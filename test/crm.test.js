// Пересылка в CRM: подпись, состав сообщения, очередь повторов.
// Без сети: CRM — локальный сервер в этом же процессе. Запуск: npm test
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";

delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
process.env.CRM_INGEST_SECRET = "test-secret";

const {
  crmIncoming, crmOutgoing, crmWebLead, flushCrmQueue, sign, leadFields,
  crmSignatureOk, MAX_ATTEMPTS,
} = await import("../crm.js");
const { queueRange, queueLength } = await import("../store.js");

// Поддельная CRM: status.code — общий ответ; status.perRecord(item) —
// что CRM скажет про запись ("stored" / "error"); status.reject(item) —
// отвергнуть вызов с такой записью целиком (400)
function crmServer(status) {
  const calls = [];
  let wake;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      calls.push({ url: req.url, headers: req.headers, raw });
      const body = JSON.parse(raw);
      const items = body.messages || [];
      let code = status.code;
      if (code === 200 && status.reject && items.some(status.reject)) code = 400;
      res.writeHead(code, { "Content-Type": "application/json" });
      const results = items.map((m) => (status.perRecord ? status.perRecord(m) : "stored"));
      res.end(JSON.stringify(body.lead ? { ok: true, result: "stored" } : { ok: true, results }));
      if (wake) wake();
    });
  });
  const next = () => new Promise((r) => { wake = r; });
  return new Promise((resolve) => server.listen(0, () => {
    process.env.CRM_URL = `http://127.0.0.1:${server.address().port}/`;
    resolve({ server, calls, next });
  }));
}

const settle = () => new Promise((r) => setTimeout(r, 60));
const privateChat = { id: 42, type: "private" };
const queued = async () => (await queueRange("crm:retry", 100)).map((v) => JSON.parse(v));
const dead = async () => (await queueRange("crm:dead", 100)).map((v) => JSON.parse(v));
const msgIn = (id, text = "x") => ({ chat: privateChat, message_id: id, date: 1, from: { id: 42 } });

test("подпись — HMAC-SHA256 от «метка.тело» общим секретом", () => {
  const expected = "sha256=" + createHmac("sha256", "s").update("100.{}").digest("hex");
  assert.equal(sign("{}", "100", "s"), expected);
});

test("вызов CRM к боту: подпись, окно времени, мусор в заголовке", () => {
  const raw = Buffer.from('{"chat_id":1}');
  const now = String(Math.floor(Date.now() / 1000));
  assert.ok(crmSignatureOk(raw, now, sign(raw.toString(), now, "test-secret")));
  assert.ok(!crmSignatureOk(raw, now, sign(raw.toString(), now, "guess")));
  const old = String(Math.floor(Date.now() / 1000) - 600);
  assert.ok(!crmSignatureOk(raw, old, sign(raw.toString(), old, "test-secret")));
  assert.ok(!crmSignatureOk(raw, now, "sha256=ж"));
  assert.ok(!crmSignatureOk(undefined, now, "x"));
});

test("входящее и ответ бота уходят подписанными, с полями лида", async () => {
  const { server, calls, next } = await crmServer({ code: 200 });
  let arrived = next();
  crmIncoming({ chat: privateChat, message_id: 7, date: 1700000000,
                from: { id: 42, first_name: "Ivan", last_name: "P", username: "ivanp" } },
              "hel\u0000lo", { name: "Ivan", teamSize: "40", step: "x" });
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
              { data: { phone: "+971", phoneVerified: true }, qualified: true });
  await arrived;
  const out = JSON.parse(calls[1].raw).messages[0];
  assert.equal(out.direction, "out");
  assert.equal(out.author, "ai");
  assert.equal(out.qualified, true);
  assert.deepEqual(out.fields, { phone: "+971", phone_verified: true });
  server.close();
});

test("набранный текстом телефон уходит неподтверждённым", () => {
  assert.deepEqual(leadFields({ phone: "+971 50" }), { phone: "+971 50", phone_verified: false });
  assert.equal(leadFields({}), undefined);
});

test("заявка с сайта уходит в /integrations/web-lead", async () => {
  const { server, calls, next } = await crmServer({ code: 200 });
  const arrived = next();
  crmWebLead({ form: "contact", name: "Anna", phone: "+971", email: "", submission_id: "s1" });
  await arrived;
  assert.equal(calls[0].url, "/integrations/web-lead");
  assert.deepEqual(JSON.parse(calls[0].raw).lead,
                   { form: "contact", name: "Anna", phone: "+971", submission_id: "s1" });
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

test("CRM лежит — запись ждёт без счёта попыток и уходит повтором", async () => {
  const status = { code: 503 };
  const { server, calls, next } = await crmServer(status);
  const arrived = next();
  crmIncoming(msgIn(9), "lost?");
  await arrived;
  await settle();
  assert.deepEqual((await queued()).map((e) => [e.item.message_id, e.attempts]), [[9, 0]]);

  assert.equal(await flushCrmQueue(), 0, "CRM всё ещё лежит — очередь цела");
  assert.deepEqual((await queued()).map((e) => e.attempts), [0]);

  status.code = 200;
  assert.equal(await flushCrmQueue(), 1);
  assert.equal(JSON.parse(calls.at(-1).raw).messages[0].message_id, 9);
  assert.equal(await queueLength("crm:retry"), 0);
  server.close();
});

test("отвергнутая пачка — по одной; плохая запись копит попытки и уходит в crm:dead", async () => {
  const status = { code: 200, reject: (m) => m.message_id === 66 };
  const { server, calls } = await crmServer(status);
  status.code = 503;
  crmIncoming(msgIn(65), "ok-1");
  crmIncoming(msgIn(66), "poison");
  crmIncoming(msgIn(67), "ok-2");
  await settle();
  assert.equal(await queueLength("crm:retry"), 3);

  status.code = 200;
  calls.length = 0;
  assert.equal(await flushCrmQueue(), 3);
  // Пачка (400) → по одной: две ушли, плохая — обратно с попыткой
  const singles = calls.slice(1).map((c) => JSON.parse(c.raw).messages.map((m) => m.message_id));
  assert.deepEqual(singles, [[65], [66], [67]]);
  assert.deepEqual((await queued()).map((e) => [e.item.message_id, e.attempts]), [[66, 1]]);

  for (let i = 2; i <= MAX_ATTEMPTS; i++) await flushCrmQueue();
  assert.equal(await queueLength("crm:retry"), 0);
  const buried = await dead();
  assert.equal(buried.length, 1);
  assert.equal(buried[0].item.message_id, 66);
  assert.equal(buried[0].attempts, MAX_ATTEMPTS);
  server.close();
});

test("ошибка CRM по одной записи пачки — повтор только её", async () => {
  const status = { code: 503, perRecord: (m) => (m.message_id === 71 ? "error" : "stored") };
  const { server } = await crmServer(status);
  crmIncoming(msgIn(70));
  crmIncoming(msgIn(71));
  await settle();
  status.code = 200;
  assert.equal(await flushCrmQueue(), 2);
  assert.deepEqual((await queued()).map((e) => [e.item.message_id, e.attempts]), [[71, 1]]);
  status.perRecord = () => "stored";
  assert.equal(await flushCrmQueue(), 1);
  assert.equal(await queueLength("crm:retry"), 0);
  server.close();
});

test("без CRM_URL ничего не уходит и ничего не падает", async () => {
  delete process.env.CRM_URL;
  crmIncoming(msgIn(1), "x");
  assert.equal(await flushCrmQueue(), 0);
});
