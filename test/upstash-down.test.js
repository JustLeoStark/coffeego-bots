// Upstash не отвечает: кто сотрудник — неизвестно. Переписку в CRM не
// пересылаем (лучше пропустить, чем переслать сотрудника как лида),
// команды сотрудника не выполняем; админ из TELEGRAM_ADMIN_CHAT_ID —
// всегда. Без сети: Upstash, Telegram и CRM — локальные серверы.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const drain = (req) => new Promise((resolve) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => resolve(raw));
});

const upstash = await listen(async (req, res) => {
  await drain(req);
  res.writeHead(503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "down" }));
});
const tgCalls = [];
let id = 5000;
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

Object.assign(process.env, {
  UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstash.address().port}`,
  UPSTASH_REDIS_REST_TOKEN: "t",
  TELEGRAM_BOT_TOKEN: "123:fake", TELEGRAM_BOT_USERNAME: "CoffeeGoUAE_bot",
  TELEGRAM_API_BASE: `http://127.0.0.1:${tg.address().port}`,
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret-0123456789", TELEGRAM_ADMIN_CHAT_ID: "1",
  CRM_URL: `http://127.0.0.1:${crm.address().port}`,
  CRM_INGEST_SECRET: "crm-secret-0123456789-0123456789-abc",
  BITRIX_ENABLED: "0", KEEP_AWAKE: "0",
});
delete process.env.ANTHROPIC_API_KEY;

const { app } = await import("../index.js");
const bot = await new Promise((resolve) => {
  const server = app.listen(0, "127.0.0.1", () => resolve(server));
});
test.after(() => { bot.close(); tg.close(); crm.close(); upstash.close(); });

let n = 1;
async function say(chatId, text) {
  await fetch(`http://127.0.0.1:${bot.address().port}/telegram/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json",
               "X-Telegram-Bot-Api-Secret-Token": "webhook-secret-0123456789" },
    body: JSON.stringify({ update_id: n++, message: { message_id: n, date: 1, text,
      chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "X" } } }),
  });
  await new Promise((r) => setTimeout(r, 150));
}
const sentTo = (chatId) => tgCalls.filter((c) => c.method === "sendMessage" && Number(c.body.chat_id) === chatId);

test("Upstash лежит: в CRM не уходит, сценарий молчит, сотрудникам — пересылка", async () => {
  await say(70, "/start");
  assert.equal(crmCalls.length, 0, "неизвестно, клиент ли это, — не пересылаем");
  assert.equal(sentTo(70).length, 0, "пауза неизвестна — лучше промолчать, чем перебить человека");
  assert.ok(sentTo(1).some((c) => c.body.text.includes("[#70]") && c.body.text.includes("/start")),
            "админу — сообщение клиента");
});

test("Upstash лежит: команды сотрудника не выполняются, админ из env — да", async () => {
  await say(71, "/reply 70 hi from someone");
  assert.equal(sentTo(70).length, 0, "от «не знаем кого» клиенту ничего");
  await say(1, "/reply 70 hi from admin");
  assert.equal(sentTo(70).length, 1);
  assert.match(sentTo(70).at(-1).body.text, /hi from admin/);
});

test("Upstash лежит: очередь CRM не берёт записи из памяти, проход прерван", async () => {
  const { flushCrmQueue } = await import("../crm.js");
  const { queueLength } = await import("../store.js");
  await assert.rejects(queueLength("crm:retry"), "очередь — только в Upstash, сбой — исключение");
  assert.equal(await flushCrmQueue(), 0, "проход прерван без падения");
});
