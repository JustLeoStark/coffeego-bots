// Пересылка переписки в CoffeeGo CRM (владелец 05.10.2026: «бот
// пересылает в CRM»). Каждое сообщение клиента в личке с ботом и каждый
// ответ бота клиенту уходят POST-ом в CRM_URL/integrations/telegram/ingest
// и появляются в карточке лида или клиента рядом с WhatsApp.
//
// Подпись: X-Signature = "sha256=" + HMAC-SHA256(CRM_INGEST_SECRET,
// "<X-Timestamp>.<тело>"). Метка времени входит в подпись — CRM отвергает
// вызовы старше нескольких минут, перехваченный вызов не повторить.
//
// Отправка не должна тормозить и ронять бота: она не ждётся (fire and
// forget), с таймаутом, ошибка — в лог и в небольшую очередь повторов в
// Upstash (без него — в памяти до перезапуска). Повтор безопасен: CRM
// узнаёт уже записанное по (chat_id, message_id, направление).
import { createHmac } from "node:crypto";
import { queuePush, queueRange, queueDrop } from "./store.js";
import { botUsername } from "./telegram.js";

const QUEUE = "crm:retry";
const QUEUE_MAX = 500;          // старше — выбрасываем: CRM лежит слишком долго
const BATCH = 50;
const RETRY_EVERY_MS = 60 * 1000;

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

// Поля квалификации из сессии движка — под именами, которые ждёт CRM
export function leadFields(data) {
  const d = data || {};
  const out = {
    category: d.category, name: d.name, company: d.company, phone: d.phone,
    email: d.email, emirate: d.emirate, location: d.location,
    team_size: d.teamSize, space_type: d.spaceType, issue: d.issue,
    wants_human: d.wantsHuman ? true : undefined,
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined || out[key] === null || out[key] === "") delete out[key];
  }
  return Object.keys(out).length ? out : undefined;
}

async function post(messages) {
  const { url, secret, timeout } = env();
  const raw = JSON.stringify({ bot: await botUsername(), messages });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${url}/integrations/telegram/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": timestamp,
      "X-Signature": sign(raw, timestamp, secret),
    },
    body: raw,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`CRM ответила ${res.status}`);
  const json = await res.json().catch(() => ({}));
  if (json.ignored) {
    console.warn(`[crm] CRM не записала ${json.ignored} сообщ. — проверьте имя бота у компании`);
  }
  return json;
}

async function send(item) {
  try {
    await post([item]);
  } catch (e) {
    console.error("[crm] пересылка не удалась, в очередь повторов:", e.message);
    try { await queuePush(QUEUE, JSON.stringify(item), QUEUE_MAX); } catch { /* память */ }
  }
}

// Не ждём: бот отвечает клиенту, а CRM получает копию следом
function fire(item) {
  if (!crmEnabled()) return;
  send(item).catch(() => {});
}

const userOf = (from) => {
  const f = from || {};
  const name = [f.first_name, f.last_name].filter(Boolean).join(" ");
  return { id: f.id, username: f.username || undefined, name: name || undefined };
};

/** Входящее сообщение клиента (объект message из Telegram). */
export function crmIncoming(msg, text, data) {
  if (!msg || !msg.chat || msg.chat.type !== "private") return;
  fire({
    chat_id: msg.chat.id, message_id: msg.message_id, direction: "in",
    date: msg.date, text, user: userOf(msg.from), fields: leadFields(data),
  });
}

/** Ответ бота клиенту. sent — то, что вернул Telegram на sendMessage;
 *  author — "scenario", "ai" или "human" (сотрудник через бота). */
export function crmOutgoing(chatId, sent, text, author, extra = {}) {
  if (!sent || !sent.message_id || !sent.chat || sent.chat.type !== "private") return;
  fire({
    chat_id: chatId, message_id: sent.message_id, direction: "out",
    date: sent.date, text, author, user: { id: Number(chatId) },
    fields: leadFields(extra.data), qualified: extra.qualified || undefined,
  });
}

/** Повторить то, что не ушло. Берём пачку с головы очереди и снимаем её
 *  только после ответа CRM: упали посередине — пачка уйдёт ещё раз. */
export async function flushCrmQueue() {
  if (!crmEnabled()) return 0;
  const raw = (await queueRange(QUEUE, BATCH)) || [];
  if (!raw.length) return 0;
  const items = [];
  for (const v of raw) { try { items.push(JSON.parse(v)); } catch { /* битое — выкинем */ } }
  try {
    if (items.length) await post(items);
  } catch (e) {
    console.error("[crm] повтор не удался:", e.message);
    return 0;
  }
  await queueDrop(QUEUE, raw.length);
  console.log(`[crm] повторно отправлено: ${items.length}`);
  return items.length;
}

export function startCrmRetry() {
  if (!crmEnabled()) return;
  const timer = setInterval(() => { flushCrmQueue().catch(() => {}); }, RETRY_EVERY_MS);
  if (timer.unref) timer.unref();
  console.log("[crm] переписка уходит в CRM:", env().url);
}
