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
// "<назначение>.<X-Timestamp>.<тело>"), назначение — ingest, web-lead или
// handoff: подпись одного вызова не подходит к другому адресу. Метка
// времени входит в подпись — вызов старше пяти минут отвергается; у
// handoff ещё и одноразовый номер (nonce).
//
// Пересылка включается, только если CRM_URL — https (http — лишь для
// localhost в тестах) и секрет не короче 32 знаков. Иначе — ошибка в
// журнале при старте, бот работает без пересылки.
//
// Отправка не должна тормозить и ронять бота: она не ждётся, с таймаутом.
// Не ушло — в лог и в очередь повторов (Upstash crm:retry, без него — в
// памяти до перезапуска), повтор раз в минуту. CRM лежит (сеть, 5xx) —
// запись просто ждёт. CRM отвергла запись (4xx или «error» по записи) —
// счётчик попыток; после MAX_ATTEMPTS — в crm:dead, разбирать руками.
import { createHmac, timingSafeEqual } from "node:crypto";
import { queuePush, queueRange, queuePop, queueLength, takeNonce } from "./store.js";
import { botUsername } from "./telegram.js";

const QUEUE = "crm:retry";
const DEAD = "crm:dead";
const QUEUE_MAX = 500;
const DEAD_MAX = 500;
const BATCH = 50;
const ROUNDS = 10;              // пачек за один проход повтора
export const MAX_ATTEMPTS = 5;     // CRM отвергла запись (4xx, «error»)
export const MAX_TRIES = 60;       // CRM не ответила (сеть, 5xx): ~час повторов
const RETRY_EVERY_MS = 60 * 1000;
const WINDOW_SEC = 300;

const env = () => ({
  url: String(process.env.CRM_URL || "").replace(/\/+$/, ""),
  secret: process.env.CRM_INGEST_SECRET || "",
  timeout: Number(process.env.CRM_TIMEOUT_MS || 5000),
});

export const MIN_SECRET = 32;

/** Почему пересылка выключена; "" — всё в порядке. */
export function crmConfigProblem() {
  const { url, secret } = env();
  if (!url && !secret) return "CRM_URL и CRM_INGEST_SECRET не заданы";
  let parsed;
  try { parsed = new URL(url); } catch { return "CRM_URL — не адрес"; }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    return "CRM_URL должен быть https://";
  }
  if (secret.length < MIN_SECRET) return `CRM_INGEST_SECRET короче ${MIN_SECRET} знаков`;
  return "";
}

export const crmEnabled = () => !crmConfigProblem();

export function sign(purpose, raw, timestamp, secret) {
  return "sha256=" + createHmac("sha256", secret)
    .update(`${purpose}.${timestamp}.${raw}`).digest("hex");
}

/** Подписал ли вызов CRM (POST /crm/handoff), не старый ли он и не
 *  повтор ли (nonce). Пересылка выключена — не верим никому. */
export async function crmCallOk(purpose, rawBody, timestamp, signature, nonce) {
  if (!crmEnabled()) return false;
  const { secret } = env();
  if (!rawBody || !timestamp || !signature) return false;
  const moment = Number(timestamp);
  if (!Number.isFinite(moment) || Math.abs(Date.now() / 1000 - moment) > WINDOW_SEC) return false;
  const expected = Buffer.from(sign(purpose, rawBody.toString("utf8"), String(timestamp), secret));
  const given = Buffer.from(String(signature));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return false;
  return takeNonce(nonce);
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
  const purpose = PURPOSES[path];
  let res;
  try {
    res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Timestamp": timestamp,
        "X-Signature": sign(purpose, raw, timestamp, secret),
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
const PURPOSES = { [PATHS.tg]: "ingest", [PATHS.web]: "web-lead" };

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

// CRM не ответила: попытка «без ответа» и запись в хвост, чтобы не
// держала остальные; после MAX_TRIES — в «мёртвые» (вечный 5xx)
async function unanswered(entry, why) {
  const next = { ...entry, tries: (entry.tries || 0) + 1 };
  if (next.tries >= MAX_TRIES) await bury(next, why);
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

// Один круг: голова очереди. Ведущие записи переписки — пачкой; пачка не
// принята — по одной. Запись, на которой CRM не ответила (сеть, 5xx),
// получает попытку «без ответа» и уходит в хвост, круг на ней кончается:
// вечный 5xx на одной записи не держит очередь, а через MAX_TRIES она в
// crm:dead. Возвращает
// { done, stop }: сколько записей с головы снято и пора ли остановиться.
async function round(limit) {
  const raw = await queueRange(QUEUE, Math.min(BATCH, limit));
  if (!raw.length) return { done: 0, stop: true };
  const entries = raw.map(parse);
  let lead = 0;
  while (lead < entries.length && entries[lead] && entries[lead].kind === "tg") lead++;
  const later = [];          // [запись, причина, без ответа?]
  let done = 0;
  let stop = false;

  if (lead > 0) {
    let json = null;
    let single = false;
    try {
      json = await post(PATHS.tg, { messages: entries.slice(0, lead).map((e) => e.item) });
    } catch (e) {
      // И 4xx, и 5xx на пачку — по одной: вечная ошибка на одной записи
      // иначе роняла бы каждую пачку с ней и держала остальные
      console.error("[crm] пачка не принята, по одной:", e.message);
      single = true;
    }
    if (json) {
      entries.slice(0, lead).forEach((entry, i) => {
        if (!accepted("tg", json, i)) later.push([entry, "CRM: ошибка записи", false]);
      });
      done = lead;
    } else if (!single) {
      lead = 0;
    }
  }
  if (done === 0) {
    // По одной: битая запись (или первая — заявка с сайта) не держит
    // остальные. CRM не ответила — запись в хвост, остальные ждут минуту
    const upTo = lead > 0 ? lead : 1;
    for (let i = 0; i < upTo; i++) {
      const entry = entries[i];
      done++;
      if (!entry) continue;                  // нечитаемая запись — выкинуть
      try {
        if (!(await sendOne(entry))) later.push([entry, "CRM: ошибка записи", false]);
      } catch (e) {
        if (e instanceof Transient) {
          later.push([entry, e.message, true]);
          stop = true;
          break;
        }
        later.push([entry, e.message, false]);
      }
    }
  }
  // Сначала — в хвост и в «мёртвые», потом снять голову: упали между —
  // запись уйдёт дважды, а не пропадёт
  for (const [entry, why, silent] of later) {
    if (silent) await unanswered(entry, why);
    else await failed(entry, why);
  }
  await queuePop(QUEUE, done);
  return { done, stop };
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
      const { done, stop } = await round(budget);
      total += done;
      budget -= done;
      if (stop || !done) break;
    }
  } finally {
    flushing = false;
  }
  if (total) console.log(`[crm] очередь повторов: разобрано ${total}`);
  return total;
}

export function startCrmRetry() {
  const problem = crmConfigProblem();
  if (problem) {
    // Пустые CRM_URL и секрет — пересылка просто не настроена; иначе это
    // ошибка настройки, и молчать о ней нельзя
    const unset = !process.env.CRM_URL && !process.env.CRM_INGEST_SECRET;
    (unset ? console.log : console.error)(`[crm] пересылка в CRM ВЫКЛЮЧЕНА: ${problem}`);
    return;
  }
  const timer = setInterval(() => { flushCrmQueue().catch(() => {}); }, RETRY_EVERY_MS);
  if (timer.unref) timer.unref();
  console.log("[crm] переписка и заявки уходят в CRM:", env().url);
}
