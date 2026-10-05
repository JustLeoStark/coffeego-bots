// Бот целиком: вебхук Telegram с секретом, телефон кнопкой, «бот молчит»
// после ответа человека, заявки с сайта в CRM. Без сети: Telegram и CRM —
// локальные серверы в этом же процессе. Запуск: npm test
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";

const SECRET = "webhook-secret-0123456789";
const CRM_SECRET = "crm-secret-0123456789-0123456789-abc";
const NETLIFY_SECRET = "netlify-jws-secret-0123456789";

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const bodyOf = (req) => new Promise((resolve) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => resolve(raw));
});

// Поддельный Telegram: что бот отправил
const tgCalls = [];
let nextId = 1000;
const tg = await listen(async (req, res) => {
  const raw = await bodyOf(req);
  const body = raw ? JSON.parse(raw) : {};
  const method = req.url.split("/").pop();
  tgCalls.push({ method, body });
  const id = Number(body.chat_id);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, result: {
    message_id: ++nextId, date: Math.floor(Date.now() / 1000),
    chat: { id, type: id > 0 ? "private" : "group" },
  } }));
});
// Поддельная CRM: что бот переслал
const crmCalls = [];
const crm = await listen(async (req, res) => {
  const raw = await bodyOf(req);
  crmCalls.push({ url: req.url, body: JSON.parse(raw) });
  const body = JSON.parse(raw);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body.lead ? { ok: true, result: "stored" }
    : { ok: true, results: (body.messages || []).map(() => "stored") }));
});

Object.assign(process.env, {
  TELEGRAM_BOT_TOKEN: "123:fake", TELEGRAM_BOT_USERNAME: "CoffeeGoUAE_bot",
  TELEGRAM_API_BASE: `http://127.0.0.1:${tg.address().port}`,
  TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_ADMIN_CHAT_ID: "1",
  CRM_URL: `http://127.0.0.1:${crm.address().port}`, CRM_INGEST_SECRET: CRM_SECRET,
  BITRIX_ENABLED: "0", KEEP_AWAKE: "0", NETLIFY_LEAD_SECRET: NETLIFY_SECRET,
});
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PUBLIC_URL;

const { app } = await import("../index.js");
const { sign } = await import("../crm.js");
const bot = await new Promise((resolve) => {
  const server = app.listen(0, "127.0.0.1", () => resolve(server));
});
const BOT = `http://127.0.0.1:${bot.address().port}`;

test.after(() => { bot.close(); tg.close(); crm.close(); });

let updateId = 1;
function update(chatId, extra) {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: chatId > 0 ? "private" : "group" },
      from: { id: chatId, first_name: "Ivan", username: "ivan" + chatId },
      ...extra,
    },
  };
}
async function hook(payload, secret = SECRET) {
  const headers = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return fetch(`${BOT}/telegram/webhook`, { method: "POST", headers, body: JSON.stringify(payload) });
}
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
async function say(chatId, text, extra = {}) {
  const res = await hook(update(chatId, { text, ...extra }));
  assert.equal(res.status, 200);
  await settle();
}
const sentTo = (chatId) => tgCalls.filter((c) => c.method === "sendMessage" && Number(c.body.chat_id) === chatId);
const crmMessages = (chatId) => crmCalls.filter((c) => c.url === "/integrations/telegram/ingest")
  .flatMap((c) => c.body.messages).filter((m) => m.chat_id === chatId);

async function handoff(body, secret = CRM_SECRET, purpose = "handoff") {
  const raw = JSON.stringify({ nonce: randomBytes(12).toString("hex"), ...body });
  const stamp = String(Math.floor(Date.now() / 1000));
  return fetch(`${BOT}/crm/handoff`, {
    method: "POST", body: raw,
    headers: { "Content-Type": "application/json", "X-Timestamp": stamp,
               "X-Signature": sign(purpose, raw, stamp, secret) },
  });
}

test("вебхук принимает только вызовы с секретом Telegram", async () => {
  assert.equal((await hook(update(50, { text: "/start" }), null)).status, 401);
  assert.equal((await hook(update(50, { text: "/start" }), "guess-guess-guess-guess")).status, 401);
  await settle();
  assert.equal(sentTo(50).length, 0, "неподписанное не обработано");
  assert.equal((await hook(update(50, { text: "/start" }))).status, 200);
  await settle();
  assert.equal(sentTo(50).length, 1);
});

test("телефон кнопкой Telegram — подтверждён, его видит CRM", async () => {
  for (const text of ["/start", "1", "Dubai", "40", "Ivan"]) await say(42, text);
  const ask = sentTo(42).at(-1).body.reply_markup;
  assert.deepEqual(ask.keyboard[0][0], { text: "📱 Share my phone number", request_contact: true });
  await say(42, undefined, { contact: { phone_number: "971501234567", user_id: 42, first_name: "Ivan" } });
  const incoming = crmMessages(42).filter((m) => m.direction === "in").at(-1);
  assert.equal(incoming.text, "971501234567");
  assert.deepEqual([incoming.fields.phone, incoming.fields.phone_verified], ["971501234567", true]);
  const last = crmMessages(42).filter((m) => m.direction === "out").at(-1);
  assert.equal(last.qualified, true);
  assert.equal(last.fields.phone_verified, true);
  assert.deepEqual(sentTo(42).at(-1).body.reply_markup, { remove_keyboard: true });
});

test("чужой контакт и набранный номер — не подтверждены", async () => {
  for (const text of ["human", "Ann"]) await say(43, text);
  await say(43, undefined, { contact: { phone_number: "971509999999", user_id: 777 } });
  const incoming = crmMessages(43).filter((m) => m.direction === "in").at(-1);
  assert.equal(incoming.fields.phone_verified, false);
  const last = crmMessages(43).filter((m) => m.direction === "out").at(-1);
  assert.equal(last.fields.phone_verified, false);

  for (const text of ["human", "Bob", "+971 55 123 4567"]) await say(46, text);
  assert.equal(crmMessages(46).filter((m) => m.direction === "out").at(-1).fields.phone_verified, false);
});

test("CRM: «отвечает человек» — бот молчит, команде уведомление; «Вернуть бота» — снова сценарий", async () => {
  assert.equal((await handoff({ chat_id: 44, action: "pause" }, "guess")).status, 401);
  assert.equal((await handoff({ chat_id: 44, action: "pause" }, CRM_SECRET, "ingest")).status, 401,
               "подпись пересылки не годится для handoff");
  assert.equal((await handoff({ chat_id: 44, action: "pause",
                                until: Math.floor(Date.now() / 1000) + 3600 })).status, 200);
  await say(44, "Are you there?");
  assert.equal(sentTo(44).length, 0, "сценарий молчит");
  assert.ok(crmMessages(44).some((m) => m.text === "Are you there?"), "в CRM — как обычно");
  assert.ok(sentTo(1).some((c) => c.body.text.includes("[#44]") && c.body.text.includes("Are you there?")),
            "админу — уведомление");
  await say(44, "/start");
  assert.equal(sentTo(44).length, 0, "и /start не будит бота");

  assert.equal((await handoff({ chat_id: 44, action: "release" })).status, 200);
  await say(44, "/start");
  assert.equal(sentTo(44).length, 1);
});

test("ответ сотрудника через бота (/reply) тоже глушит бота", async () => {
  await say(1, "/reply 45 Hello, this is Leo");
  assert.equal(sentTo(45).length, 1);
  assert.equal(crmMessages(45).at(-1).author, "human");
  await say(45, "thanks, and the price?");
  assert.equal(sentTo(45).length, 1, "бот не вмешивается в разговор человека");
  await say(1, "/close 45");
  await say(45, "/start");
  assert.ok(sentTo(45).at(-1).body.text.includes("CoffeeGo AI assistant"), "после /close — снова бот");
});

const SITE_FORM = { id: "sub-1", form_name: "contact", site_url: "https://coffee-go.ae",
  data: { name: "Anna", phone: "+971 55 000 1111", email: "anna@x.example",
          company: "Blue Tower", message: "40 people", page: "/office" } };

function jws(rawBody, secret = NETLIFY_SECRET, claims = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({ iss: "netlify", sha256: createHash("sha256").update(rawBody).digest("hex"), ...claims });
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
async function netlify(form, { token, key } = {}) {
  const raw = JSON.stringify(form);
  const headers = { "Content-Type": "application/json" };
  if (token !== undefined) headers["X-Webhook-Signature"] = token === true ? jws(raw) : token;
  const url = `${BOT}/netlify/lead${key ? `?key=${encodeURIComponent(key)}` : ""}`;
  return fetch(url, { method: "POST", headers, body: raw });
}
const webLeads = () => crmCalls.filter((c) => c.url === "/integrations/web-lead");

test("заявка с сайта с подписью JWS Netlify уходит в CRM лидом", async () => {
  const res = await netlify(SITE_FORM, { token: true });
  assert.equal(res.status, 200);
  await settle();
  const call = webLeads().at(-1);
  assert.ok(call, "заявка ушла в CRM");
  assert.deepEqual(call.body.lead, { form: "contact", name: "Anna", company: "Blue Tower",
    phone: "+971 55 000 1111", email: "anna@x.example", message: "40 people",
    page: "/office", submission_id: "sub-1" });
  assert.equal(call.body.bot, "CoffeeGoUAE_bot");
});

test("заявка без подписи, с чужой подписью или подменённым телом — 401", async () => {
  const before = webLeads().length;
  assert.equal((await netlify(SITE_FORM)).status, 401, "без подписи");
  assert.equal((await netlify(SITE_FORM, { token: jws("{}") })).status, 401, "хэш другого тела");
  assert.equal((await netlify(SITE_FORM, { token: jws(JSON.stringify(SITE_FORM), "guess-secret") })).status, 401);
  assert.equal((await netlify(SITE_FORM, { token: jws(JSON.stringify(SITE_FORM), NETLIFY_SECRET, { iss: "evil" }) })).status, 401);
  assert.equal((await netlify(SITE_FORM, { token: "garbage" })).status, 401);
  assert.equal((await netlify(SITE_FORM, { key: "guess" })).status, 401);
  assert.equal((await netlify({ ...SITE_FORM, id: "sub-k" }, { key: NETLIFY_SECRET })).status, 200,
               "запасной ?key= работает");
  await settle();
  assert.equal(webLeads().length, before + 1);

  const saved = process.env.NETLIFY_LEAD_SECRET;
  delete process.env.NETLIFY_LEAD_SECRET;
  try {
    assert.equal((await netlify(SITE_FORM, { key: "" })).status, 401, "без секрета — отказ всем");
    assert.equal((await netlify(SITE_FORM, { token: jws(JSON.stringify(SITE_FORM), "") })).status, 401);
  } finally {
    process.env.NETLIFY_LEAD_SECRET = saved;
  }
});

test("посторонний не пишет клиентам через бота и не учит его", async () => {
  // Клиент 60 в живом разговоре; 61 — посторонний
  for (const text of ["human", "Kate", "+971 55 999 0000"]) await say(60, text);
  const toClient = sentTo(60).length;
  const crmBefore = crmMessages(60).length;
  await say(61, "/reply 60 Pay to my card 1234");
  await say(61, "Pay here", { reply_to_message: { message_id: 1, text: "📩 [#60] Kate: hi" } });
  await say(61, "/close 60");
  assert.equal(sentTo(60).length, toClient, "клиенту ничего не ушло");
  assert.equal(crmMessages(60).length, crmBefore, "в CRM ничего не записано от имени команды");
  const { pausedUntil, getLearned } = await import("../store.js");
  assert.equal(await pausedUntil(60), 0, "пауза не поставлена");
  assert.ok(!(await getLearned(300)).some((p) => /1234|Pay here/.test(p.a)), "база знаний не пополнена");
});

test("имя и слова клиента уходят сотрудникам простым текстом", async () => {
  const name = "<a href='http://evil'>Boss</a>";
  for (const text of ["human"]) await hook(update(62, { text, from: { id: 62, first_name: name } }));
  await settle();
  await hook(update(62, { text: "<b>Ann</b>", from: { id: 62, first_name: name } }));
  await settle();
  await hook(update(62, { text: "+971 55 000 2222", from: { id: 62, first_name: name } }));
  await settle();
  await hook(update(62, { text: "<i>hello</i> & bye", from: { id: 62, first_name: name } }));
  await settle();
  const toAdmin = sentTo(1).filter((c) => c.body.text.includes("[#62]"));
  assert.ok(toAdmin.length >= 1);
  for (const call of toAdmin.concat(sentTo(62))) {
    assert.equal(call.body.parse_mode, undefined, "без разметки");
  }
  assert.ok(toAdmin.some((c) => c.body.text.includes("<i>hello</i> & bye")), "текст как есть");

  await netlify({ ...SITE_FORM, id: "sub-h", data: { ...SITE_FORM.data, name: "<b>X</b>" } }, { token: true });
  await settle();
  const site = sentTo(1).filter((c) => c.body.text.includes("<b>X</b>"));
  assert.ok(site.length && site.every((c) => c.body.parse_mode === undefined));
});
