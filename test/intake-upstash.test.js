// Флаг «приём ведёт CRM» не читается (Upstash сбоит на нём): бот не
// отвечает клиенту сценарием — лучше промолчать, чем ответить вторым
// голосом рядом с CRM, — но переписку в CRM пересылает. Запись флага не
// удалась — CRM получает 503 («бот не получил настройку»).
// Без сети: Upstash, Telegram и CRM — локальные серверы.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const drain = (req) => new Promise((resolve) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => resolve(raw));
});

// Поддельный Upstash: простые команды в памяти; broken — команды с ключом
// crm:intake отвечают ошибкой (весь вызов — 503, как при сбое)
const data = new Map();
const upstashState = { broken: false };
function run([op, key, a, ...rest]) {
  op = String(op).toUpperCase();
  if (op === "GET") return data.has(key) ? data.get(key) : null;
  if (op === "SET") {
    if (rest.map((x) => String(x).toUpperCase()).includes("NX") && data.has(key)) return null;
    data.set(key, String(a));
    return "OK";
  }
  if (op === "DEL") return data.delete(key) ? 1 : 0;
  if (op === "SADD") { const s = data.get(key) || new Set(); s.add(String(a)); data.set(key, s); return 1; }
  if (op === "SMEMBERS") { const s = data.get(key); return s instanceof Set ? [...s] : []; }
  return null;
}
const upstash = await listen(async (req, res) => {
  const body = JSON.parse((await drain(req)) || "[]");
  const commands = req.url.endsWith("/pipeline") ? body : [body];
  if (upstashState.broken && commands.some((c) => c.includes("crm:intake"))) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "down" }));
    return;
  }
  const out = commands.map((c) => ({ result: run(c) }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(req.url.endsWith("/pipeline") ? out : out[0]));
});
const tgCalls = [];
let id = 7000;
const tg = await listen(async (req, res) => {
  const body = JSON.parse((await drain(req)) || "{}");
  tgCalls.push({ method: req.url.split("/").pop(), body });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, result: { message_id: ++id, date: 1,
    chat: { id: Number(body.chat_id), type: "private" } } }));
});
const crmCalls = [];
const crm = await listen(async (req, res) => {
  crmCalls.push(JSON.parse(await drain(req)));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, results: ["stored"] }));
});

const CRM_SECRET = "crm-secret-0123456789-0123456789-abc";
Object.assign(process.env, {
  UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstash.address().port}`,
  UPSTASH_REDIS_REST_TOKEN: "t",
  TELEGRAM_BOT_TOKEN: "123:fake", TELEGRAM_BOT_USERNAME: "CoffeeGoUAE_bot",
  TELEGRAM_API_BASE: `http://127.0.0.1:${tg.address().port}`,
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret-0123456789", TELEGRAM_ADMIN_CHAT_ID: "1",
  CRM_URL: `http://127.0.0.1:${crm.address().port}`, CRM_INGEST_SECRET: CRM_SECRET,
  KEEP_AWAKE: "0",
});
delete process.env.ANTHROPIC_API_KEY;
delete process.env.BITRIX_LEADS;

const { app } = await import("../index.js");
const { sign } = await import("../crm.js");
const bot = await new Promise((resolve) => {
  const server = app.listen(0, "127.0.0.1", () => resolve(server));
});
const BOT = `http://127.0.0.1:${bot.address().port}`;
test.after(() => { bot.close(); tg.close(); crm.close(); upstash.close(); });

let n = 1;
async function say(chatId, text) {
  await fetch(`${BOT}/telegram/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json",
               "X-Telegram-Bot-Api-Secret-Token": "webhook-secret-0123456789" },
    body: JSON.stringify({ update_id: n++, message: { message_id: n, date: 1, text,
      chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "X" } } }),
  });
  await new Promise((r) => setTimeout(r, 150));
}
const sentTo = (chatId) => tgCalls.filter((c) => c.method === "sendMessage" && Number(c.body.chat_id) === chatId);
const crmTexts = (chatId) => crmCalls.flatMap((c) => c.messages || [])
  .filter((m) => m.chat_id === chatId && m.direction === "in").map((m) => m.text);
async function intake(enabled) {
  const raw = JSON.stringify({ action: "intake", enabled, nonce: randomBytes(12).toString("hex") });
  const stamp = String(Math.floor(Date.now() / 1000));
  return fetch(`${BOT}/crm/handoff`, { method: "POST", body: raw,
    headers: { "Content-Type": "application/json", "X-Timestamp": stamp,
               "X-Signature": sign("handoff", raw, stamp, CRM_SECRET) } });
}

test("флаг приёма не читается: сценарий молчит, в CRM пересылается", async () => {
  upstashState.broken = true;
  try {
    await say(90, "/start");
    await say(90, "hello?");
    assert.equal(sentTo(90).length, 0, "не знаем, кто ведёт приём, — молчим");
    assert.deepEqual(crmTexts(90), ["/start", "hello?"], "переписка — в CRM");
  } finally {
    upstashState.broken = false;
  }
  await say(90, "/start");
  assert.equal(sentTo(90).length, 1, "флаг снова читается (и снят) — бот отвечает");
});

test("флаг приёма не записался — CRM получает 503 и узнает об этом", async () => {
  upstashState.broken = true;
  try {
    assert.equal((await intake(true)).status, 503);
  } finally {
    upstashState.broken = false;
  }
  assert.equal(data.has("crm:intake"), false);
  assert.equal((await intake(true)).status, 200);
  assert.ok(data.has("crm:intake"), "флаг — в Upstash, без срока");
  await say(91, "/start");
  assert.equal(sentTo(91).length, 0);
  assert.deepEqual(crmTexts(91), ["/start"]);
  assert.equal((await intake(false)).status, 200);
  assert.equal(data.has("crm:intake"), false);
});
