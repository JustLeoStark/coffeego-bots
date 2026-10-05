// Пересылка в CoffeeGo CRM (владелец 05.10.2026: «бот пересылает в CRM»).
//
// 1. Переписка: каждое сообщение клиента в личке с ботом и каждый ответ
//    бота клиенту → CRM_URL/integrations/telegram/ingest. В CRM она
//    появляется в карточке лида или клиента рядом с WhatsApp.
// 2. Заявки с сайта coffee-go.ae (Netlify) → CRM_URL/integrations/web-lead.
// 3. Обратно CRM зовёт бота: POST /crm/handoff — «отвечает человек, молчи»
//    или «верни сценарий» (index.js). Подпись та же.
//
// Подпись: X-Signature = "sha256=" + HMAC-SHA256(CRM_INGEST_SECRET,
// "<X-Timestamp>.<тело>"). Метка времени входит в подпись — вызов старше
// пяти минут отвергается, перехваченный не повторить.
//
// Отправка не должна тормозить и ронять бота: она не ждётся, с таймаутом.
// Не ушло — в лог и в очередь повторов (Upstash crm:retry, без него — в
// памяти до перезапуска), повтор раз в минуту. CRM лежит (сеть, 5xx) —
// запись просто ждёт. CRM отвергла запись (4xx или «error» по записи) —
// счётчик попыток; после MAX_ATTEMPTS — в crm:dead, разбирать руками.
import { createHmac, timingSafeEqual } from "node:crypto";
import { queuePush, queueRange, queuePop, queueLength } from "./store.js";
import { botUsername } from "./telegram.js";

const QUEUE = "crm:retry";
const DEAD = "crm:dead";
const QUEUE_MAX = 500;
const DEAD_MAX = 500;
const BATCH = 50;
const ROUNDS = 10;              // пачек за один проход повтора
export const MAX_ATTEMPTS = 5;
const RETRY_EVERY_MS = 60 * 1000;
const WINDOW_SEC = 300;

const env = () => ({
  url: String(process.env.CRM_URL || "").replace(/\/+$/, ""),
  secret: process.env.CRM_INGEST_SECRET || "",
  timeout: Number(process.env.CRM_TIMEOUT_MS || 5000),
});

export const crmEnabled = () => Boolean(env().url && env().secret);

export function sign(raw, timestamp, secret) {
  return "sha256=" + createHmac("sha256", secret)
    .update(`${timestamp}.${raw}`).digest("hex");
}

/** Подписал ли вызов CRM (POST /crm/handoff). Без секрета — никому. */
export function crmSignatureOk(rawBody, timestamp, signature) {
  const { secret } = env();
  if (!secret || !rawBody || !timestamp || !signature) return false;
  const moment = Number(timestamp);
  if (!Number.isFinite(moment) || Math.abs(Date.now() / 1000 - moment) > WINDOW_SEC) return false;
  const expected = Buffer.from(sign(rawBody.toString("utf8"), String(timestamp), secret));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// NUL Postgres не хранит — запись в CRM упала бы целиком
const clean = (v) => (typeof v === "string" ? v.replace(/\u0000/g, "") : v);

// Поля квалификации из сессии движка — под именами, которые ждёт CRM.
// phone_verified — телефон отдан кнопкой Telegram (contact.user_id —
// сам пишущий); набранный текстом не подтверждён и к чужим карточкам в
// CRM не привязывает
export function leadFields(data) {
  const d = data || {};
  const out = {
    category: d.category, name: d.name, company: d.company, phone: d.phone,
    email: d.email, emirate: d.emirate, location: d.location,
    team_size: d.teamSize, space_type: d.spaceType, issue: d.issue,
    wants_human: d.wantsHuman ? true : undefined,
    phone_verified: d.phone ? d.phoneVerified === true : undefined,
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined || out[key] === null || out[key] === "") delete out[key];
    else out[key] = clean(out[key]);
  }
  return Object.keys(out).length ? out : undefined;
}

class Transient extends Error {}

// Один вызов CRM. Сеть, таймаут, 5xx, 408, 429 — Transient (CRM лежит,
// запись подождёт); иной не-2xx — обычная ошибка (запись не принята).
async function post(path, body) {
  const { url, secret, timeout } = env();
  const raw = JSON.stringify({ bot: await botUsername(), ...body });
  const timestamp = String(Math.floor(Date.now() / 1000));
  let res;
  try {
    res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Timestamp": timestamp,
        "X-Signature": sign(raw, timestamp, secret),
      },
      body: raw,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Transient(`CRM недоступна: ${e.name || e.message}`);
  }
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    throw new Transient(`CRM ответила ${res.status}`);
  }
  if (!res.ok) throw new Error(`CRM ответила ${res.status}`);
  return res.json().catch(() => ({}));
}

const PATHS = { tg: "/integrations/telegram/ingest", web: "/integrations/web-lead" };

// Ответ CRM по одной записи: true — принята (записана, повтор, чужое)
function accepted(kind, json, index = 0) {
  if (kind === "web") return Boolean(json && json.result && json.result !== "error");
  const results = (json && json.results) || [];
  return results[index] !== "error";
}

async function sendOne(entry) {
  const body = entry.kind === "web" ? { lead: entry.item } : { messages: [entry.item] };
  const json = await post(PATHS[entry.kind], body);
  if (entry.kind === "tg" && json.ignored) {
    console.warn("[crm] CRM не записала сообщение — проверьте имя бота у компании");
  }
  return accepted(entry.kind, json);
}

async function enqueue(entry) {
  const pushed = await queuePush(QUEUE, JSON.stringify(entry), QUEUE_MAX);
  if (!pushed) console.error("[crm] очередь повторов полна — запись потеряна:", entry.kind);
}

async function bury(entry, why) {
  console.error(`[crm] запись не принята ${entry.attempts} раз — в ${DEAD}:`, why);
  await queuePush(DEAD, JSON.stringify({ ...entry, why, at: Date.now() }), DEAD_MAX);
}

async function failed(entry, why) {
  const next = { ...entry, attempts: (entry.attempts || 0) + 1 };
  if (next.attempts >= MAX_ATTEMPTS) await bury(next, why);
  else await enqueue(next);
}

async function deliver(entry) {
  try {
    if (!(await sendOne(entry))) await failed(entry, "CRM: ошибка записи");
  } catch (e) {
    console.error("[crm] пересылка не удалась, в очередь повторов:", e.message);
    if (e instanceof Transient) await enqueue(entry);
    else await failed(entry, e.message);
  }
}

// Не ждём: бот отвечает клиенту, а CRM получает копию следом
function fire(kind, item) {
  if (!crmEnabled()) return;
  deliver({ kind, item, attempts: 0 }).catch((e) => console.error("[crm]", e.message));
}

const userOf = (from) => {
  const f = from || {};
  const name = [f.first_name, f.last_name].filter(Boolean).join(" ");
  return { id: f.id, username: f.username || undefined, name: clean(name) || undefined };
};

/** Входящее сообщение клиента (объект message из Telegram). */
export function crmIncoming(msg, text, data) {
  if (!msg || !msg.chat || msg.chat.type !== "private") return;
  fire("tg", {
    chat_id: msg.chat.id, message_id: msg.message_id, direction: "in",
    date: msg.date, text: clean(text), user: userOf(msg.from), fields: leadFields(data),
  });
}

/** Ответ бота клиенту. sent — то, что вернул Telegram на sendMessage;
 *  author — "scenario", "ai" или "human" (сотрудник через бота). */
export function crmOutgoing(chatId, sent, text, author, extra = {}) {
  if (!sent || !sent.message_id || !sent.chat || sent.chat.type !== "private") return;
  fire("tg", {
    chat_id: Number(chatId), message_id: sent.message_id, direction: "out",
    date: sent.date, text: clean(text), author, user: { id: Number(chatId) },
    fields: leadFields(extra.data), qualified: extra.qualified || undefined,
  });
}

/** Заявка с сайта (форма Netlify) — лидом в CRM. */
export function crmWebLead(lead) {
  const out = {};
  for (const [key, value] of Object.entries(lead || {})) {
    if (value !== undefined && value !== null && value !== "") out[key] = clean(String(value));
  }
  fire("web", out);
}

const parse = (raw) => {
  try {
    const v = JSON.parse(raw);
    // Запись без обёртки — от первой версии пересылки
    return v && v.kind ? v : { kind: "tg", item: v, attempts: 0 };
  } catch { return null; }
};

// Один круг: голова очереди. Ведущие записи переписки — пачкой; не-2xx
// (кроме «CRM лежит») — по одной. Возвращает, сколько снято; null — CRM
// лежит, ждём следующей минуты.
async function round(limit) {
  const raw = await queueRange(QUEUE, Math.min(BATCH, limit));
  if (!raw.length) return 0;
  const entries = raw.map(parse);
  let lead = 0;
  while (lead < entries.length && entries[lead] && entries[lead].kind === "tg") lead++;
  const later = [];          // что вернуть в очередь (в хвост) или похоронить
  let done = 0;              // сколько записей с головы разобрано

  if (lead > 0) {
    let json = null;
    try {
      json = await post(PATHS.tg, { messages: entries.slice(0, lead).map((e) => e.item) });
    } catch (e) {
      if (e instanceof Transient) return null;
      console.error("[crm] пачка не принята, по одной:", e.message);
    }
    if (json) {
      entries.slice(0, lead).forEach((entry, i) => {
        if (!accepted("tg", json, i)) later.push([entry, "CRM: ошибка записи"]);
      });
      done = lead;
    }
  }
  if (done === 0) {
    // По одной: битая запись (или первая — заявка с сайта) не держит
    // остальные. CRM легла посреди — останавливаемся, остаток ждёт
    const upTo = lead > 0 ? lead : 1;
    for (let i = 0; i < upTo; i++) {
      const entry = entries[i];
      if (!entry) { done++; continue; }      // нечитаемая запись — выкинуть
      try {
        if (!(await sendOne(entry))) later.push([entry, "CRM: ошибка записи"]);
      } catch (e) {
        if (e instanceof Transient) break;
        later.push([entry, e.message]);
      }
      done++;
    }
    if (done === 0) return null;
  }
  // Сначала — в хвост и в «мёртвые», потом снять голову: упали между —
  // запись уйдёт дважды, а не пропадёт
  for (const [entry, why] of later) await failed(entry, why);
  await queuePop(QUEUE, done);
  return done;
}

let flushing = false;

/** Повторить то, что не ушло. Возвращает, сколько записей снято. */
export async function flushCrmQueue() {
  if (!crmEnabled() || flushing) return 0;
  flushing = true;
  let total = 0;
  try {
    // Каждую запись — не больше раза за проход: вернувшаяся в хвост
    // ждёт следующей минуты, а не сжигает все попытки сразу
    let budget = await queueLength(QUEUE);
    for (let i = 0; i < ROUNDS && budget > 0; i++) {
      const n = await round(budget);
      if (!n) break;
      total += n;
      budget -= n;
    }
  } finally {
    flushing = false;
  }
  if (total) console.log(`[crm] очередь повторов: разобрано ${total}`);
  return total;
}

export function startCrmRetry() {
  if (!crmEnabled()) return;
  const timer = setInterval(() => { flushCrmQueue().catch(() => {}); }, RETRY_EVERY_MS);
  if (timer.unref) timer.unref();
  console.log("[crm] переписка и заявки уходят в CRM:", env().url);
}
