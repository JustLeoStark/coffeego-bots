// CoffeeGo lead bot — Express server hosting Telegram + WhatsApp webhooks.
// The AI assistant triages the client, then hands off to a live team member
// (two-way relay through the bot). Admins assign responsibles from subscribers.
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleMessage } from "./engine.js";
import { askAI } from "./ai.js";
import { createLead, bitrixEnabled } from "./bitrix.js";
import {
  crmIncoming, crmOutgoing, crmEnabled, startCrmRetry, crmWebLead,
  crmCallOk,
} from "./crm.js";
import { netlifyOk, netlifyProblem } from "./netlify.js";
import {
  sendTelegram, sendPhotoToChat, setTelegramWebhook, setTelegramCommands,
  webhookSecret,
} from "./telegram.js";
import {
  sendWhatsApp, verifyWhatsAppWebhook, parseWhatsAppMessages,
  parseWhatsAppStatuses, verifySignature, whatsappConfigured,
} from "./whatsapp.js";
import {
  recordSubscriber, listSubscribers, setAssignment, getAssignments,
  setHandoff, getHandoff, clearHandoff, resolveAgents, addLearned,
  logTicket, logFirstReply, regionStats, teamStatus,
  setPause, clearPause, pauseState,
} from "./store.js";
import {
  regionOf, isWorkingHours, outOfHoursNote, REGION_NAMES, DEFAULT_REGION,
} from "./regions.js";
import { onStart, onTeamButton, teamCommand, leadRecipients } from "./team.js";

// Кому переслать сообщение клиента в живой переписке: все назначенные
// (старые переписки — с одним agentId)
const agentsOf = (ho) => (ho.agents && ho.agents.length ? ho.agents : [ho.agentId]).filter(Boolean);

const app = express();
// Сырое тело нужно, чтобы проверить подпись Meta: она считается по байтам
// запроса, а express.json() их уже не отдаёт.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

const ADMIN = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "");
const isAdmin = (id) => ADMIN && String(id) === ADMIN;
const RESET = ["/start", "start", "menu", "/menu", "restart"];

// In-memory conversation sessions (the AI/menu flow). Handoff state is persistent (store.js).
const sessions = new Map();
function getSession(key) {
  if (!sessions.has(key)) sessions.set(key, { step: "menu", data: {} });
  return sessions.get(key);
}

// Ответ сотрудника уходит клиенту в тот канал, откуда он пришёл. Без этого
// ответы на обращения из WhatsApp улетали бы в пустоту: id клиента там —
// номер телефона, а не Telegram-чат.
// Сколько бот молчит после ответа человека (владелец 05.10.2026)
const PAUSE_MS = 24 * 60 * 60 * 1000;

async function replyToClient(clientId, text, opts = {}) {
  const ho = await getHandoff(clientId);
  const body = opts.raw ? text : `👤 CoffeeGo team: ${text}`;
  const author = opts.author || "human";
  if (ho && ho.channel === "whatsapp") await sendWhatsApp(clientId, body);
  else {
    const sent = await sendTelegram(clientId, body);
    // Копия в CRM: ответ сотрудника через бота — тоже история клиента
    crmOutgoing(clientId, sent, body, author);
  }
  // Ответил человек — сценарий и ИИ в этом чате молчат сутки
  if (author === "human") await setPause(clientId, Date.now() + PAUSE_MS);
}

// Run the AI/menu engine and, on completion, open a live handoff to an agent.
// region — рынок клиента: он решает, кому уйдёт обращение и в какие часы
// на него ответят. Для Telegram региона нет (номера не видно), там работает
// общая роль.
// toCrm — ответы бота копируются в CoffeeGo CRM (личка клиента в Telegram).
async function runEngine(channel, userId, text, send, clientName, region, toCrm = false,
                         phoneVerified = false) {
  const session = getSession(`${channel}:${userId}`);
  const result = await handleMessage(session, text, { askAI, phoneVerified });
  // Квалификация закончилась — CRM узнаёт это с первым же ответом бота
  let qualified = Boolean(result.lead);
  for (const reply of result.replies) {
    const sent = await send(reply.text, reply.buttons);
    if (toCrm) {
      crmOutgoing(userId, sent, reply.text, reply.by === "ai" ? "ai" : "scenario",
                  { data: session.data, qualified });
      qualified = false;
    }
  }

  if (result.lead) {
    const r = await createLead(result.lead);
    const inCrm = toCrm && crmEnabled();
    result.lead._tag = r.ok
      ? `Bitrix lead #${r.id}${inCrm ? " · CoffeeGo CRM" : ""}`
      : inCrm ? "lead → CoffeeGo CRM"
        : `lead (Bitrix ${r.error || "not configured"})`;
  }

  if (result.openHandoff) {
    const agents = await resolveAgents(result.openHandoff.category, region);
    if (agents.length) {
      await setHandoff(userId, {
        agentId: agents[0], agents, category: result.openHandoff.category,
        name: clientName, channel, region: region || null,
        openedAt: Date.now(),
      });
      await logTicket(region || "telegram", result.openHandoff.category, agents[0]);
      const tag = result.lead ? result.lead._tag : "";
      const place = region ? ` · ${REGION_NAMES[region] || region}` : "";
      for (const agent of agents) await sendTelegram(
        agent,
        `🔔 New chat handed to you — ${result.openHandoff.category}${place}\n` +
          `[#${userId}] ${clientName}\n\n` +
          `${result.openHandoff.summary}\n(${tag})\n\n` +
          `↩️ Reply to this message (or any [#${userId}] message) to chat with the client.\n` +
          `Type /close ${userId} to end the chat.`
      );
      // Вне рабочих часов региона клиент не должен сидеть в тишине.
      if (region && !isWorkingHours(region)) {
        const note = outOfHoursNote(region, /[а-яё]/i.test(text) ? "ru" : "en");
        if (note) {
          const sent = await send(note);
          if (toCrm) crmOutgoing(userId, sent, note, "scenario");
        }
      }
    }
  }
}

// Вызов действительно от Telegram: секрет вебхука в заголовке (аудит
// 05.10). Секрет не задан — не верим никому, вебхук отключён
function fromTelegram(req) {
  const secret = webhookSecret();
  const given = req.get("x-telegram-bot-api-secret-token") || "";
  if (!secret || !given) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Telegram ----
app.post("/telegram/webhook", async (req, res) => {
  if (!fromTelegram(req)) return res.sendStatus(401);
  res.sendStatus(200);
  // Нажатие кнопки — одобрение заявки сотрудника
  const cb = req.body && req.body.callback_query;
  if (cb) {
    try { await onTeamButton(cb, ADMIN); } catch (e) { console.error("[telegram] button error:", e); }
    return;
  }
  const msg = req.body && req.body.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const clientName = [from.first_name, from.last_name].filter(Boolean).join(" ") || "Client";
  const photoId = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : null;
  // Телефон кнопкой «поделиться номером». Подтверждён, только если это
  // номер самого пишущего: чужой контакт — всё равно что набранный текстом
  const contact = msg.contact && msg.contact.phone_number ? msg.contact : null;
  const phoneVerified = Boolean(contact && from.id && contact.user_id === from.id);
  const text = (contact ? contact.phone_number
    : msg.text || msg.caption || (photoId ? "[photo]" : "")).toString();
  const t = text.trim();
  const replyText = (msg.reply_to_message && msg.reply_to_message.text) || "";

  try {
    recordSubscriber(chatId, clientName);

    // Utility
    if (t === "/id") { await sendTelegram(chatId, `Your Telegram chat ID: ${chatId}`); return; }

    // Сотрудник — по ссылке-приглашению (?start=inv_…) или с заявкой
    // (?start=team): не в клиентский диалог
    if (await onStart(chatId, clientName, t, ADMIN)) return;

    // Копия в CoffeeGo CRM — только личка клиента: группы, админ и
    // сотрудники (команда, роли, ответственные) туда не идут
    // Кто пишет: команда, клиент или «не знаем» (Upstash не ответил).
    // «Не знаем» — ни в CRM (лучше пропустить, чем переслать сотрудника
    // как лида), ни команд сотрудника (аудит 05.10); админ из env — всегда
    const status = isAdmin(chatId) ? "staff" : await teamStatus(chatId);
    const isClient = msg.chat.type === "private" && status === "client";
    const toCrm = crmEnabled() && isClient;
    if (toCrm) {
      const data = getSession(`telegram:${chatId}`).data;
      crmIncoming(msg, text, contact ? { ...data, phone: text, phoneVerified } : data);
    }

    // ----- Admin commands -----
    if (isAdmin(chatId)) {
      if (await teamCommand(chatId, t)) return;
      if (t === "/staff") {
        const list = await listSubscribers();
        const body = list.length ? list.map((s) => `${s.id} — ${s.name || "?"}`).join("\n") : "No subscribers yet.";
        await sendTelegram(chatId, `👥 Subscribers:\n${body}\n\nAssign: /assign <support|sales|invest|default> <id>`);
        return;
      }
      if (t === "/assignments") {
        const a = await getAssignments();
        const lines = Object.entries(a).map(([k, v]) => {
          const [role, reg] = k.split("@");
          const place = reg ? ` · ${REGION_NAMES[reg] || reg}` : " · вся сеть";
          return `${role}${place}: ${v || "(admin)"}`;
        });
        await sendTelegram(chatId,
          "📌 Кто за что отвечает:\n" + lines.join("\n") +
          "\n\nНазначить: /assign <роль>[@регион] <chat_id>\n" +
          "Регионы: /regions");
        return;
      }
      if (t === "/regions") {
        const list = Object.entries(REGION_NAMES)
          .map(([k, v]) => `${k} — ${v}`).join("\n");
        await sendTelegram(chatId,
          "🌍 Регионы (определяются по коду номера клиента):\n" + list +
          `\n\nПо умолчанию: ${DEFAULT_REGION}.\n` +
          "Пример: /assign support@ru 12345678 — поддержку по России ведёт " +
          "этот сотрудник. Роль без региона работает как запасная для всех.");
        return;
      }
      if (t.startsWith("/stats")) {
        const days = Number((t.split(/\s+/)[1] || "30").replace(/\D/g, "")) || 30;
        const s = await regionStats(days);
        const rows = Object.entries(s.по_регионам);
        if (!rows.length) {
          await sendTelegram(chatId, `За ${days} дн. обращений не было.`);
          return;
        }
        const lines = rows.map(([r, v]) =>
          `${REGION_NAMES[r] || r}: обращений ${v.обращений}, ответов ` +
          `${v.ответов}` +
          (v.среднее_время_ответа_мин !== null
            ? `, среднее время ответа ${v.среднее_время_ответа_мин} мин` : ""));
        await sendTelegram(chatId,
          `📊 Обращения за ${days} дн.:\n` + lines.join("\n"));
        return;
      }
      if (t.startsWith("/assign")) {
        const [, roleRaw, id] = t.split(/\s+/);
        const [role, region] = String(roleRaw || "").split("@");
        const roles = ["support", "sales", "invest", "default"];
        if (!roles.includes(role) || !id) {
          await sendTelegram(chatId,
            "Как назначать:\n" +
            "/assign support 12345678 — на всю сеть\n" +
            "/assign support@ru 12345678 — только по России\n" +
            "Список регионов: /regions");
        } else if (region && !REGION_NAMES[region]) {
          await sendTelegram(chatId,
            `Регион «${region}» не знаю. Доступные: /regions`);
        } else {
          await setAssignment(roleRaw, id);
          const place = region
            ? ` по региону «${REGION_NAMES[region]}»` : " на всю сеть";
          await sendTelegram(chatId, `✅ ${role}${place} — теперь ${id}.`);
        }
        return;
      }
      if (t.startsWith("/teach")) {
        const rest = text.slice(6).trim();
        const parts = rest.split("|");
        if (parts.length < 2) {
          await sendTelegram(chatId, "Usage: /teach <question> | <answer>");
        } else {
          await addLearned(parts[0].trim(), parts.slice(1).join("|").trim());
          await sendTelegram(chatId, "✅ Saved to the bot's knowledge.");
        }
        return;
      }
      if (t === "/adminhelp") {
        await sendTelegram(chatId, "Admin commands:\n/team — команда: роли, пригласить, убрать\n/invite — ссылка-приглашение для сотрудника\n/close <id> — end a client chat\n/teach <question> | <answer> — teach the bot\n\nСотрудники входят по ссылке из /invite (или «➕ Пригласить» в /team), клиенты — по обычной ссылке на бота.");
        return;
      }
    }

    // ----- Agent -> client relay -----
    // Только команда: иначе любой мог бы писать клиентам от имени CoffeeGo
    // и учить бота своим ответам.
    const isStaff = isAdmin(chatId) || status === "staff";
    // Close a chat: "/close <id>" or reply "/close" to a [#id] message.
    const closeMatch = isStaff && (t.match(/^\/close\s+(\d+)/) || (t === "/close" && replyText.match(/\[#(\d+)\]/)));
    if (closeMatch) {
      const cid = closeMatch[1];
      await clearHandoff(cid);
      await clearPause(cid);   // разговор закрыт — бот снова на месте
      await sendTelegram(chatId, `✅ Chat with ${cid} closed.`);
      await replyToClient(cid,
        "Our team member has closed this chat. Type \"menu\" if you need " +
        "anything else. Thank you! ☕", { raw: true, author: "scenario" });
      return;
    }
    // Explicit relay: "/reply <id> <text>"
    const replyCmd = isStaff && t.match(/^\/reply\s+(\d+)\s+([\s\S]+)/);
    if (replyCmd) {
      await replyToClient(replyCmd[1], replyCmd[2]);
      const ho = await getHandoff(replyCmd[1]);
      if (ho && ho.lastClientMsg) await addLearned(ho.lastClientMsg, replyCmd[2]);
      await sendTelegram(chatId, "✔️ Sent (saved to the bot's knowledge).");
      return;
    }
    // Reply to a forwarded ticket message that contains [#clientId]
    const ticket = isStaff && replyText.match(/\[#(\d+)\]/);
    if (ticket) {
      const cid = ticket[1];
      const ho = await getHandoff(cid);
      if (photoId && (!ho || ho.channel !== "whatsapp")) {
        const caption = `👤 CoffeeGo team${msg.caption ? ": " + msg.caption : ""}`;
        const sent = await sendPhotoToChat(cid, photoId, caption);
        crmOutgoing(cid, sent, `[photo] ${caption}`, "human");
        await setPause(cid, Date.now() + PAUSE_MS);
      } else if (photoId) {
        // В WhatsApp фото пока не пересылаем — предупреждаем сотрудника,
        // чтобы он не думал, что клиент его получил.
        await sendTelegram(chatId,
          "⚠️ Клиент в WhatsApp — фото туда пока не уходит, опишите словами.");
        return;
      } else {
        await replyToClient(cid, text);
      }
      // The bot learns: pair the client's last question with the team's answer.
      if (!photoId && t.length >= 3 && !t.startsWith("/")) {
        if (ho && ho.lastClientMsg) await addLearned(ho.lastClientMsg, text);
      }
      // Первый ответ на обращение — засекаем скорость для отчёта по франшизе.
      if (ho && ho.openedAt && !ho.firstReplyAt) {
        ho.firstReplyAt = Date.now();
        await setHandoff(cid, ho);
        await logFirstReply(cid, (ho.firstReplyAt - ho.openedAt) / 1000,
                            ho.region || "telegram");
      }
      await sendTelegram(chatId, "✔️ Sent (saved to the bot's knowledge).");
      return;
    }

    // ----- Client in active handoff -> forward to their agent -----
    const ho = await getHandoff(chatId);
    if (ho && !RESET.includes(t.toLowerCase())) {
      // Remember the client's last text so we can pair it with the agent's answer (learning).
      if (!photoId && text && text !== "[photo]") { ho.lastClientMsg = text; await setHandoff(chatId, ho); }
      for (const agent of agentsOf(ho)) {
        if (photoId) await sendPhotoToChat(agent, photoId, `📩 [#${chatId}] ${clientName}${msg.caption ? ": " + msg.caption : ""}`);
        else await sendTelegram(agent, `📩 [#${chatId}] ${clientName}: ${text}`);
      }
      return;
    }
    // Отвечает человек (из CRM или через бота) — бот молчит: сообщение
    // уже в CRM, команде — уведомление, как при запросе человека
    // Пауза неизвестна (Upstash не ответил) — тоже молчим: лучше
    // промолчать, чем перебить человека. Если не знаем даже, кто пишет, —
    // как клиенту: команды сотрудника выше уже не выполнились
    const pause = msg.chat.type === "private" && status !== "staff"
      ? (status === "unknown" ? "unknown" : await pauseState(chatId)) : "free";
    if (pause !== "free") {
      const sess = getSession(`telegram:${chatId}`);
      for (const agent of await resolveAgents(sess.data && sess.data.category || "Human hand-off")) {
        const head = pause === "paused"
          ? `📩 [#${chatId}] ${clientName} (отвечает человек, бот молчит)`
          : `📩 [#${chatId}] ${clientName} (сбой хранилища — бот молчит, ответьте сами)`;
        if (photoId) await sendPhotoToChat(agent, photoId, `${head}${msg.caption ? ": " + msg.caption : ""}`);
        else await sendTelegram(agent, `${head}: ${text}`);
      }
      return;
    }
    if (ho && RESET.includes(t.toLowerCase())) await clearHandoff(chatId);

    // ----- Otherwise: run the AI/menu engine -----
    // Forward a photo sent during AI triage to the support agent.
    if (photoId) {
      const sess = getSession(`telegram:${chatId}`);
      if (String(sess.step).startsWith("support") || sess.step === "ai_chat") {
        sess.data = sess.data || {};
        sess.data.photoNote = "Photo attached (forwarded to team)";
        for (const support of await resolveAgents("Support / complaint")) {
          await sendPhotoToChat(support, photoId, `📷 [#${chatId}] ${clientName}${msg.caption ? ": " + msg.caption : ""}`);
        }
      }
    }
    await runEngine("telegram", chatId, text, (tx, buttons) => sendTelegram(chatId, tx, buttons),
                    clientName, undefined, toCrm, phoneVerified);
  } catch (e) {
    console.error("[telegram] handler error:", e);
  }
});

// ---- CRM: отвечает человек ----
// CRM после ответа менеджера из карточки: «молчи до until» (pause) или
// кнопка «Вернуть бота» (release). Подпись — тот же HMAC, что у пересылки
app.post("/crm/handoff", async (req, res) => {
  const b = req.body || {};
  if (!(await crmCallOk("handoff", req.rawBody, req.get("x-timestamp"),
                        req.get("x-signature"), b.nonce))) {
    return res.sendStatus(401);
  }
  const chatId = Number(b.chat_id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return res.status(400).json({ ok: false });
  if (b.action === "pause") {
    // Не дольше недели: опечатка в CRM не должна заглушить бота навсегда
    const asked = Number(b.until) * 1000;
    const until = Math.min(Number.isFinite(asked) && asked > Date.now() ? asked : Date.now() + PAUSE_MS,
                           Date.now() + 7 * PAUSE_MS);
    await setPause(chatId, until);
  } else if (b.action === "release") {
    await clearPause(chatId);
    await clearHandoff(chatId);
  } else {
    return res.status(400).json({ ok: false });
  }
  res.json({ ok: true });
});

// ---- WhatsApp (Meta Cloud API) ----
app.get("/whatsapp/webhook", (req, res) => {
  const challenge = verifyWhatsAppWebhook(req.query);
  if (challenge) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post("/whatsapp/webhook", async (req, res) => {
  // Подпись проверяем ДО ответа: чужой запрос обрабатывать не нужно.
  if (!verifySignature(req.rawBody, req.get("x-hub-signature-256"))) {
    console.warn("[whatsapp] bad signature — ignored");
    return res.sendStatus(403);
  }
  // Meta ждёт 200 в пределах нескольких секунд, иначе шлёт повтор. Отвечаем
  // сразу, разбираем после.
  res.sendStatus(200);
  try {
    for (const s of parseWhatsAppStatuses(req.body)) {
      if (s.status === "failed") {
        console.error("[whatsapp] delivery failed to", s.to, ":", s.error);
      }
    }
    for (const m of parseWhatsAppMessages(req.body)) {
      const name = m.name ? `${m.name} (WhatsApp)` : "WhatsApp user";
      // Файл без подписи: движок его не разберёт, но молчать нельзя —
      // жалобы «не налил» приходят именно фотографией.
      if (m.media && m.text.startsWith("[")) {
        await sendWhatsApp(m.from,
          "Спасибо, файл получил. Опишите, пожалуйста, что произошло — " +
          "номер автомата и что именно случилось.");
        continue;
      }
      const region = regionOf(m.from);
      // Клиент уже в живой переписке — не гоняем его через меню заново,
      // а передаём сообщение тому, кто с ним говорит.
      const ho = await getHandoff(m.from);
      if (ho) {
        if (!ho.lastClientMsg || ho.lastClientMsg !== m.text) {
          ho.lastClientMsg = m.text;
          await setHandoff(m.from, ho);
        }
        const place = REGION_NAMES[region] || region;
        for (const agent of agentsOf(ho)) await sendTelegram(agent,
          `📩 [#${m.from}] ${name} · ${place}: ${m.text}`);
        continue;
      }
      await runEngine("whatsapp", m.from, m.text,
        (t) => sendWhatsApp(m.from, t), name, region);
    }
  } catch (e) {
    console.error("[whatsapp] handler error:", e);
  }
});

// Диагностика: показывает, что настроено, без раскрытия секретов.
app.get("/whatsapp/health", (_req, res) => {
  res.json({
    configured: whatsappConfigured(),
    verify_token_set: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
    app_secret_set: Boolean(process.env.WHATSAPP_APP_SECRET),
    phone_id_set: Boolean(process.env.WHATSAPP_PHONE_ID),
    time: new Date().toISOString(),
  });
});


// ---- Website leads (Netlify Forms outgoing webhook) ----
// Netlify posts JSON: { form_name, data: {name,email,phone,company,people,message,option,...}, site_url, created_at }
// Только от Netlify: подпись JWS (X-Webhook-Signature) или запасной ?key=.
// Без NETLIFY_LEAD_SECRET — отказ всем (аудит 05.10). Ключ в журнал не пишем
app.post("/netlify/lead", async (req, res) => {
  if (!netlifyOk(req)) {
    console.warn("[netlify] заявка без верной подписи — отклонена");
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  try {
    const b = req.body || {};
    const d = b.data || {};
    const form = b.form_name || d["form-name"] || "contact";
    const isNews = form === "newsletter";
    const isInvest = form === "investor" || /invest/i.test(d.option || "");
    const head = isNews ? "📰 Newsletter signup (website)" : isInvest ? "💼 INVESTOR REQUEST (website) — investor pack" : "🌐 New website lead — coffee machine enquiry";
    const page = d.page || b.site_url || "";
    const lines = [
      head,
      d.option ? `Interest: ${d.option}` : null,
      d.name ? `Name: ${d.name}` : null,
      d.company ? `Company: ${d.company}` : null,
      d.phone ? `Phone: ${d.phone}` : null,
      d.email ? `Email: ${d.email}` : null,
      d.people ? `People/footfall: ${d.people}` : null,
      d.message ? `Message: ${d.message}` : null,
      page ? `Page: ${page}` : null,
      isInvest ? "→ Send the 2-page summary + data room link; book a 20-min call." : null,
    ].filter(Boolean);
    const text = lines.join("\n");
    // Инвесторам — роль «Инвестиции», остальным — «Заявки с сайта» (пока в
    // ней никого — продажи). Админу — всегда, ровно один раз
    const recipients = isInvest ? await resolveAgents("Invest") : await leadRecipients(ADMIN);
    for (const id of recipients) await sendTelegram(id, "🔔 " + text);
    if (!isNews) {
      // Лидом в CoffeeGo CRM (владелец 05.10.2026); Bitrix — как раньше
      crmWebLead({
        form, option: d.option, name: d.name, company: d.company, phone: d.phone,
        email: d.email, people: d.people, message: d.message, page,
        submission_id: b.id || d.id,
      });
      const r = await createLead({ title: `Website: ${d.option || form} — ${d.name || d.company || d.email || "lead"}`, name: d.name, phone: d.phone, email: d.email,
        comments: [d.company && `Company: ${d.company}`, d.people && `People: ${d.people}`, d.message, b.site_url && `Page: ${b.site_url}`].filter(Boolean).join("\n") });
      if (!r.ok) console.log("[netlify] lead not sent to Bitrix:", r.error || "not configured");
    }
  } catch (e) { console.error("[netlify] handler error:", e); }
});

app.get("/", (_req, res) => res.send("CoffeeGo bot is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));
// Какая версия работает: Render кладёт коммит в RENDER_GIT_COMMIT. Нужно,
// чтобы проверить, подхватил ли он выкладку, — без доступа к Render
const STARTED = new Date().toISOString();
app.get("/version", (_req, res) => res.json({
  commit: (process.env.RENDER_GIT_COMMIT || "unknown").slice(0, 7),
  started: STARTED,
  // Куда идут лиды — без раскрытия адресов и ключей
  crm: crmEnabled(),
  // Вебхук Telegram принимает только вызовы с секретом
  telegram_webhook_secret: Boolean(webhookSecret()),
  bitrix: bitrixEnabled() && Boolean(process.env.BITRIX_WEBHOOK_URL),
}));

export { app };

// Сервер поднимается, только когда файл запущен (npm start). Тесты
// импортируют app и слушают свой порт
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const PORT = process.env.PORT || 3000;
if (isMain) app.listen(PORT, async () => {
  console.log(`CoffeeGo bot listening on :${PORT}`);
  if (process.env.PUBLIC_URL) await setTelegramWebhook(process.env.PUBLIC_URL);
  await setTelegramCommands(ADMIN);
  startCrmRetry();
  if (netlifyProblem()) console.error(`[netlify] приём заявок с сайта ВЫКЛЮЧЕН: ${netlifyProblem()}`);

  // Бесплатный Render усыпляет сервис через 15 минут тишины, а просыпается
  // почти минуту. Telegram повторяет доставку долго и переживёт это, а Meta
  // ждёт ответа секунды — первое сообщение клиента в WhatsApp просто
  // потеряется. Поэтому будим себя сами, пока смысл есть.
  if (process.env.PUBLIC_URL && process.env.KEEP_AWAKE !== "0") {
    const url = `${process.env.PUBLIC_URL.replace(/\/$/, "")}/health`;
    setInterval(() => {
      fetch(url).catch(() => {});
    }, 10 * 60 * 1000);
    console.log("[keepalive] self-ping every 10 min →", url);
  }
});
