// Бот целиком: вебхук Telegram с секретом, телефон кнопкой, «бот молчит»
// после ответа человека, заявки с сайта в CRM. Без сети: Telegram и CRM —
// локальные серверы в этом же процессе. Запуск: npm test
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";

const SECRET = "webhook-secret-0123456789";
const CRM_SECRET = "crm-secret-0123456789-0123456789-abc";
const NETLIFY_SECRET = "netlify-jws-secret-0123456789-0123456789";

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
  const result = {
    message_id: ++nextId, date: Math.floor(Date.now() / 1000),
    chat: { id, type: id > 0 ? "private" : "group" },
  };
  if (method === "sendPhoto") result.photo = [{ file_id: body.photo, width: 1280, height: 960 }];
  res.end(JSON.stringify({ ok: true, result }));
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
  KEEP_AWAKE: "0", NETLIFY_LEAD_SECRET: NETLIFY_SECRET,
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
          company: "Blue Tower", message: "40 people", page: "/office",
          source: "ads · google · CoffeeGo - Search UAE", landing: "/office-coffee-machine-dubai" } };

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
    page: "/office", submission_id: "sub-1",
    source: "ads · google · CoffeeGo - Search UAE", landing: "/office-coffee-machine-dubai" });
  assert.equal(call.body.bot, "CoffeeGoUAE_bot");
});

test("заявка без верной подписи — только в Telegram (200), в CRM не уходит", async () => {
  const before = webLeads().length;
  assert.equal((await netlify(SITE_FORM)).status, 200, "без подписи");
  assert.equal((await netlify(SITE_FORM, { token: jws("{}") })).status, 200, "хэш другого тела");
  assert.equal((await netlify(SITE_FORM, { token: jws(JSON.stringify(SITE_FORM), "guess-secret") })).status, 200);
  assert.equal((await netlify(SITE_FORM, { token: jws(JSON.stringify(SITE_FORM), NETLIFY_SECRET, { iss: "evil" }) })).status, 200);
  assert.equal((await netlify(SITE_FORM, { token: "garbage" })).status, 200);
  assert.equal((await netlify({ ...SITE_FORM, id: "sub-k" }, { key: NETLIFY_SECRET })).status, 200,
               "?key= без NETLIFY_ALLOW_KEY=1 не принимается");
  process.env.NETLIFY_ALLOW_KEY = "1";
  try {
    assert.equal((await netlify(SITE_FORM, { key: "guess" })).status, 200);
    assert.equal((await netlify({ ...SITE_FORM, id: "sub-k" }, { key: NETLIFY_SECRET })).status, 200,
                 "запасной ?key= — только по явному разрешению");
  } finally {
    delete process.env.NETLIFY_ALLOW_KEY;
  }
  await settle();
  assert.equal(webLeads().length, before + 1);

  const saved = process.env.NETLIFY_LEAD_SECRET;
  delete process.env.NETLIFY_LEAD_SECRET;
  try {
    assert.equal((await netlify(SITE_FORM, { key: "" })).status, 200, "без секрета — отказ всем");
    assert.equal((await netlify(SITE_FORM, { token: jws(JSON.stringify(SITE_FORM), "") })).status, 200);
    // Короткий секрет — приём выключен даже с верной подписью
    process.env.NETLIFY_LEAD_SECRET = "short-secret";
    const raw = JSON.stringify({ ...SITE_FORM, id: "sub-s" });
    assert.equal((await fetch(`${BOT}/netlify/lead`, { method: "POST", body: raw,
      headers: { "Content-Type": "application/json",
                 "X-Webhook-Signature": jws(raw, "short-secret") } })).status, 200);
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

test("снятый с роли сотрудник сразу перестаёт быть командой", async () => {
  const { addRoleMember, removeRoleMember, addLeadWatcher, removeLeadWatcher, isTeamMember } =
    await import("../store.js");
  await addRoleMember("sales", "880");
  assert.equal(await isTeamMember("880"), true);
  await removeRoleMember("sales", "880");
  assert.equal(await isTeamMember("880"), false, "кэш состава сброшен");
  await addLeadWatcher("881", "W");
  assert.equal(await isTeamMember("881"), true);
  await removeLeadWatcher("881");
  assert.equal(await isTeamMember("881"), false);
});

test("nonce handoff живёт 10 минут", async () => {
  const { takeNonce } = await import("../store.js");
  const realNow = Date.now;
  const start = realNow();
  try {
    assert.equal(await takeNonce("nonce-ttl-000000000001"), true);
    Date.now = () => start + 7 * 60 * 1000;
    assert.equal(await takeNonce("nonce-ttl-000000000001"), false, "через 7 минут — всё ещё повтор");
    Date.now = () => start + 11 * 60 * 1000;
    assert.equal(await takeNonce("nonce-ttl-000000000001"), true, "через 11 минут — забыт");
  } finally {
    Date.now = realNow;
  }
});

test("фото, документ и голосовое клиента уходят в CRM файлом (media), текст — подпись", async () => {
  await say(70, "/start");
  await say(70, undefined, { caption: "broken cup", photo: [
    { file_id: "ph-small", file_unique_id: "u1", width: 90, height: 90, file_size: 900 },
    { file_id: "ph-big", file_unique_id: "u2", width: 1280, height: 1280, file_size: 99000 },
  ] });
  await say(70, undefined, { document: { file_id: "doc-1", file_name: "invoice.pdf",
                                         mime_type: "application/pdf", file_size: 12345 } });
  await say(70, undefined, { voice: { file_id: "voice-1", mime_type: "audio/ogg", file_size: 4000, duration: 3 } });
  const got = crmMessages(70).filter((m) => m.direction === "in" && m.media);
  assert.deepEqual(got.map((m) => [m.text, m.media]), [
    ["broken cup", { file_id: "ph-big", type: "photo", file_size: 99000 }],
    ["", { file_id: "doc-1", type: "document", file_name: "invoice.pdf",
           mime_type: "application/pdf", file_size: 12345 }],
    ["", { file_id: "voice-1", type: "voice", mime_type: "audio/ogg", file_size: 4000 }],
  ]);
  assert.ok(!crmMessages(70).some((m) => m.text === "[photo]"), "не «[photo]» вместо подписи");
  assert.ok(crmMessages(70).filter((m) => m.direction === "in" && !m.media).every((m) => m.media === undefined));
});

test("фото сотрудника клиенту — в CRM тоже файлом", async () => {
  await say(1, "look", { photo: [{ file_id: "staff-ph", width: 800, height: 600 }], caption: "look",
                         reply_to_message: { message_id: 1, text: "📩 [#71] Kate: hi" } });
  const out = crmMessages(71).filter((m) => m.direction === "out");
  assert.equal(out.length, 1);
  assert.equal(out[0].author, "human");
  assert.deepEqual(out[0].media, { file_id: "staff-ph", type: "photo" });
  assert.equal(out[0].text, "👤 CoffeeGo team: look");
});

test("внутренний контакт CRM: бот молчит и не зовёт команду, в CRM пересылает; «Вернуть бота» снимает", async () => {
  const year = Math.floor(Date.now() / 1000) + 3650 * 86400;   // как internal_contacts.py
  assert.equal((await handoff({ chat_id: 72, action: "pause", until: year })).status, 200);
  const toAdmin = () => sentTo(1).filter((c) => c.body.text.includes("[#72]")).length;
  await say(72, "/start");
  await say(72, "hi, it's the accountant");
  await say(72, undefined, { document: { file_id: "vat-1", file_name: "vat.pdf" } });
  assert.equal(sentTo(72).length, 0, "ни сценария, ни ИИ");
  assert.equal(toAdmin(), 0, "команду не дёргаем — переписка в CRM");
  assert.ok(crmMessages(72).some((m) => m.text === "hi, it's the accountant"), "в CRM — как обычно");
  assert.ok(crmMessages(72).some((m) => m.media && m.media.file_id === "vat-1"));

  // Менеджер ответил контакту из CRM — пауза на сутки тишину не снимает
  assert.equal((await handoff({ chat_id: 72, action: "pause",
                                until: Math.floor(Date.now() / 1000) + 86400 })).status, 200);
  await say(72, "thanks");
  assert.equal(sentTo(72).length, 0);
  assert.equal(toAdmin(), 0);

  // Контакт вернули в лиды (или «Вернуть бота») — снова сценарий
  assert.equal((await handoff({ chat_id: 72, action: "release" })).status, 200);
  await say(72, "/start");
  assert.equal(sentTo(72).length, 1);
});

test("пауза CRM до двух недель — по-прежнему не дольше недели, не тишина", async () => {
  const { pausedUntil, isSilenced } = await import("../store.js");
  const twoWeeks = Math.floor(Date.now() / 1000) + 14 * 86400;
  assert.equal((await handoff({ chat_id: 73, action: "pause", until: twoWeeks })).status, 200);
  assert.equal(await isSilenced(73), false);
  const until = await pausedUntil(73);
  assert.ok(until > Date.now() && until <= Date.now() + 7 * 86400 * 1000 + 1000);
});

// ---- Приём ведёт CRM (владелец 12.10.2026) ----

async function intake(enabled) {
  const res = await handoff({ action: "intake", enabled });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, intake: enabled });
}
const photosAbout = (chatId) => tgCalls.filter((c) => c.method === "sendPhoto" &&
  String(c.body.caption || "").includes(`[#${chatId}]`));
const toTeamAbout = (chatId) => tgCalls.filter((c) => c.method === "sendMessage" &&
  Number(c.body.chat_id) !== chatId && String(c.body.text || "").includes(`[#${chatId}]`));

test("intake: только подписанный вызов CRM, nonce одноразовый, enabled — да/нет", async () => {
  const { intakeOn } = await import("../store.js");
  assert.equal((await handoff({ action: "intake", enabled: true }, "guess-guess-guess-guess-guess-guess")).status, 401);
  assert.equal((await handoff({ action: "intake", enabled: true }, CRM_SECRET, "ingest")).status, 401,
               "подпись пересылки не годится");
  assert.equal(await intakeOn(), false, "неподписанное не записано");
  // Повтор того же вызова (тот же nonce) — отказ
  const raw = JSON.stringify({ action: "intake", enabled: true, nonce: randomBytes(12).toString("hex") });
  const send = () => {
    const stamp = String(Math.floor(Date.now() / 1000));
    return fetch(`${BOT}/crm/handoff`, { method: "POST", body: raw,
      headers: { "Content-Type": "application/json", "X-Timestamp": stamp,
                 "X-Signature": sign("handoff", raw, stamp, CRM_SECRET) } });
  };
  assert.equal((await send()).status, 200);
  assert.equal(await intakeOn(), true);
  assert.equal((await send()).status, 401, "тот же nonce второй раз");
  assert.equal((await handoff({ action: "intake", enabled: "yes" })).status, 400);
  assert.equal((await handoff({ action: "intake" })).status, 400);
  await intake(false);
  assert.equal(await intakeOn(), false);
  const version = await (await fetch(`${BOT}/version`)).json();
  assert.equal(version.crm_intake, false);
  assert.equal(version.bitrix, undefined, "Bitrix24 из бота удалён");
});

test("приём ведёт CRM: на /start, текст и фото бот молчит, всё — в CRM, команде — ничего", async () => {
  // Текущий разговор: клиент 81 уже в меню сценария
  await say(81, "/start");
  await say(81, "1");
  assert.equal(sentTo(81).length, 2);
  await intake(true);
  try {
    await say(80, "/start");
    await say(80, "Hi, I need a coffee machine for my office");
    await say(80, "human");
    await say(80, undefined, { caption: "our kitchen", photo: [{ file_id: "kitchen-1", width: 800, height: 600 }] });
    await say(80, "menu");
    assert.equal(sentTo(80).length, 0, "ни сценария, ни ИИ, ни приветствия");
    assert.equal(toTeamAbout(80).length + photosAbout(80).length, 0, "команде — ни «новый лид», ни фото");
    const got = crmMessages(80).filter((m) => m.direction === "in");
    assert.deepEqual(got.map((m) => m.text),
                     ["/start", "Hi, I need a coffee machine for my office", "human", "our kitchen", "menu"]);
    assert.deepEqual(got[3].media, { file_id: "kitchen-1", type: "photo" });
    assert.equal(crmMessages(80).filter((m) => m.direction === "out").length, 0);

    // Текущий разговор тоже замолк — посреди сценария
    for (const text of ["Dubai", "40", "Ivan", "+971 50 111 2222"]) await say(81, text);
    assert.equal(sentTo(81).length, 2, "сценарий не продолжился");
    assert.equal(toTeamAbout(81).length, 0, "лид из сценария команде не ушёл");
    assert.ok(crmMessages(81).some((m) => m.text === "+971 50 111 2222"));

    // Пауза (человек из CRM ответил) — как раньше: молчим, команде уведомление
    assert.equal((await handoff({ chat_id: 82, action: "pause",
                                  until: Math.floor(Date.now() / 1000) + 3600 })).status, 200);
    await say(82, "still there?");
    assert.equal(sentTo(82).length, 0);
    assert.ok(toTeamAbout(82).some((c) => c.body.text.includes("отвечает человек")));

    // Сотрудник (админ) — не клиент: ему бот отвечает как раньше
    await say(1, "/start");
    assert.ok(sentTo(1).at(-1).body.text.includes("CoffeeGo AI assistant"));
  } finally {
    await intake(false);
  }

  // Галочку сняли — снова сценарий бота
  await say(80, "/start");
  assert.equal(sentTo(80).length, 1);
  assert.ok(sentTo(80)[0].body.text.includes("CoffeeGo AI assistant"));
});

