// Пересылка в CRM: подпись, состав сообщения, очередь повторов.
// Без сети: CRM — локальный сервер в этом же процессе. Запуск: npm test
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";

delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
process.env.CRM_INGEST_SECRET = "test-secret";

const { crmIncoming, crmOutgoing, flushCrmQueue, sign, leadFields } = await import("../crm.js");
const { queueRange } = await import("../store.js");

function crmServer(status) {
  const calls = [];
  let wake;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      calls.push({ url: req.url, headers: req.headers, raw });
      res.writeHead(status.code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: status.code === 200, stored: 1 }));
      if (wake) wake();
    });
  });
  const next = () => new Promise((r) => { wake = r; });
  return new Promise((resolve) => server.listen(0, () => {
    process.env.CRM_URL = `http://127.0.0.1:${server.address().port}/`;
    resolve({ server, calls, next });
  }));
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const privateChat = { id: 42, type: "private" };

test("подпись — HMAC-SHA256 от «метка.тело» общим секретом", () => {
  const expected = "sha256=" + createHmac("sha256", "s").update("100.{}").digest("hex");
  assert.equal(sign("{}", "100", "s"), expected);
});

test("входящее и ответ бота уходят подписанными, с полями лида", async () => {
  const status = { code: 200 };
  const { server, calls, next } = await crmServer(status);
  let arrived = next();
  crmIncoming({ chat: privateChat, message_id: 7, date: 1700000000,
                from: { id: 42, first_name: "Ivan", last_name: "P", username: "ivanp" } },
              "hello", { name: "Ivan", teamSize: "40", step: "x" });
  await arrived;
  const call = calls[0];
  assert.equal(call.url, "/integrations/telegram/ingest");
  assert.equal(call.headers["x-signature"],
               sign(call.raw, call.headers["x-timestamp"], "test-secret"));
  const body = JSON.parse(call.raw);
  assert.equal(body.bot, "CoffeeGoUAE_bot");
  assert.deepEqual(body.messages[0], {
    chat_id: 42, message_id: 7, direction: "in", date: 1700000000, text: "hello",
    user: { id: 42, username: "ivanp", name: "Ivan P" },
    fields: { name: "Ivan", team_size: "40" },
  });

  arrived = next();
  crmOutgoing(42, { message_id: 8, date: 1700000001, chat: privateChat }, "Hi!", "ai",
              { data: { phone: "+971" }, qualified: true });
  await arrived;
  const out = JSON.parse(calls[1].raw).messages[0];
  assert.equal(out.direction, "out");
  assert.equal(out.author, "ai");
  assert.equal(out.qualified, true);
  assert.deepEqual(out.fields, { phone: "+971" });
  server.close();
});

test("группы и неотправленное не пересылаются", async () => {
  const { server, calls } = await crmServer({ code: 200 });
  crmIncoming({ chat: { id: -100, type: "group" }, message_id: 1, date: 1, from: {} }, "x");
  crmOutgoing(42, null, "не ушло", "scenario");
  crmOutgoing(-100, { message_id: 2, date: 1, chat: { id: -100, type: "supergroup" } }, "x", "human");
  await settle();
  assert.equal(calls.length, 0);
  server.close();
});

test("CRM недоступна — сообщение ждёт в очереди и уходит повтором", async () => {
  const status = { code: 503 };
  const { server, calls, next } = await crmServer(status);
  let arrived = next();
  crmIncoming({ chat: privateChat, message_id: 9, date: 1, from: { id: 42 } }, "lost?");
  await arrived;
  await settle();
  assert.equal((await queueRange("crm:retry", 50)).length, 1);

  assert.equal(await flushCrmQueue(), 0, "CRM всё ещё лежит — очередь цела");
  assert.equal((await queueRange("crm:retry", 50)).length, 1);

  status.code = 200;
  arrived = next();
  assert.equal(await flushCrmQueue(), 1);
  await arrived;
  assert.equal(JSON.parse(calls.at(-1).raw).messages[0].message_id, 9);
  assert.equal((await queueRange("crm:retry", 50)).length, 0);
  server.close();
});

test("без CRM_URL ничего не уходит и ничего не падает", async () => {
  delete process.env.CRM_URL;
  crmIncoming({ chat: privateChat, message_id: 1, date: 1, from: {} }, "x");
  assert.equal(await flushCrmQueue(), 0);
  assert.equal(leadFields({}), undefined);
});
