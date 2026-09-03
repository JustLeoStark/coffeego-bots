// CoffeeGo lead bot — Express server hosting Telegram + WhatsApp webhooks.
// The AI assistant triages the client, then hands off to a live team member
// (two-way relay through the bot). Admins assign responsibles from subscribers.
import express from "express";
import { handleMessage } from "./engine.js";
import { askAI } from "./ai.js";
import { createLead } from "./bitrix.js";
import { sendTelegram, sendPhotoToChat, setTelegramWebhook } from "./telegram.js";
import { sendWhatsApp, verifyWhatsAppWebhook, parseWhatsAppMessages } from "./whatsapp.js";
import {
  recordSubscriber, listSubscribers, setAssignment, getAssignments,
  setHandoff, getHandoff, clearHandoff, resolveAgent, addLearned,
} from "./store.js";

const app = express();
app.use(express.json());

const ADMIN = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "");
const isAdmin = (id) => ADMIN && String(id) === ADMIN;
const RESET = ["/start", "start", "menu", "/menu", "restart"];

// In-memory conversation sessions (the AI/menu flow). Handoff state is persistent (store.js).
const sessions = new Map();
function getSession(key) {
  if (!sessions.has(key)) sessions.set(key, { step: "menu", data: {} });
  return sessions.get(key);
}

// Run the AI/menu engine and, on completion, open a live handoff to an agent.
async function runEngine(channel, userId, text, send, clientName) {
  const session = getSession(`${channel}:${userId}`);
  const result = await handleMessage(session, text, { askAI });
  for (const reply of result.replies) await send(reply.text, reply.buttons);

  if (result.lead) {
    const r = await createLead(result.lead);
    result.lead._tag = r.ok ? `Bitrix lead #${r.id}` : `lead (Bitrix ${r.error || "not configured"})`;
  }

  if (channel === "telegram" && result.openHandoff) {
    const agent = await resolveAgent(result.openHandoff.category);
    if (agent) {
      await setHandoff(userId, { agentId: agent, category: result.openHandoff.category, name: clientName });
      const tag = result.lead ? result.lead._tag : "";
      await sendTelegram(
        agent,
        `🔔 New chat handed to you — ${result.openHandoff.category}\n[#${userId}] ${clientName}\n\n` +
          `${result.openHandoff.summary}\n(${tag})\n\n` +
          `↩️ Reply to this message (or any [#${userId}] message) to chat with the client.\n` +
          `Type /close ${userId} to end the chat.`
      );
    }
  }
}

// ---- Telegram ----
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);
  const msg = req.body && req.body.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const clientName = [from.first_name, from.last_name].filter(Boolean).join(" ") || "Client";
  const photoId = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : null;
  const text = (msg.text || msg.caption || (photoId ? "[photo]" : "")).toString();
  const t = text.trim();
  const replyText = (msg.reply_to_message && msg.reply_to_message.text) || "";

  try {
    recordSubscriber(chatId, clientName);

    // Utility
    if (t === "/id") { await sendTelegram(chatId, `Your Telegram chat ID: ${chatId}`); return; }

    // ----- Admin commands -----
    if (isAdmin(chatId)) {
      if (t === "/staff") {
        const list = await listSubscribers();
        const body = list.length ? list.map((s) => `${s.id} — ${s.name || "?"}`).join("\n") : "No subscribers yet.";
        await sendTelegram(chatId, `👥 Subscribers:\n${body}\n\nAssign: /assign <support|sales|invest|default> <id>`);
        return;
      }
      if (t === "/assignments") {
        const a = await getAssignments();
        await sendTelegram(chatId, `📌 Assignments:\nsupport: ${a.support || "(admin)"}\nsales: ${a.sales || "(admin)"}\ninvest: ${a.invest || "(admin)"}\ndefault: ${a.default || "(admin)"}`);
        return;
      }
      if (t.startsWith("/assign")) {
        const [, role, id] = t.split(/\s+/);
        const roles = ["support", "sales", "invest", "default"];
        if (!roles.includes(role) || !id) {
          await sendTelegram(chatId, "Usage: /assign <support|sales|invest|default> <chat_id>");
        } else {
          await setAssignment(role, id);
          await sendTelegram(chatId, `✅ ${role} is now handled by ${id}.`);
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
        await sendTelegram(chatId, "Admin commands:\n/staff — list subscribers\n/assign <role> <id> — set responsible\n/assignments — show current\n/close <id> — end a client chat\n/teach <question> | <answer> — teach the bot");
        return;
      }
    }

    // ----- Agent -> client relay -----
    // Close a chat: "/close <id>" or reply "/close" to a [#id] message.
    const closeMatch = t.match(/^\/close\s+(\d+)/) || (t === "/close" && replyText.match(/\[#(\d+)\]/));
    if (closeMatch) {
      const cid = closeMatch[1];
      await clearHandoff(cid);
      await sendTelegram(chatId, `✅ Chat with ${cid} closed.`);
      await sendTelegram(cid, "Our team member has closed this chat. Type \"menu\" if you need anything else. Thank you! ☕");
      return;
    }
    // Explicit relay: "/reply <id> <text>"
    const replyCmd = t.match(/^\/reply\s+(\d+)\s+([\s\S]+)/);
    if (replyCmd) {
      await sendTelegram(replyCmd[1], `👤 CoffeeGo team: ${replyCmd[2]}`);
      const ho = await getHandoff(replyCmd[1]);
      if (ho && ho.lastClientMsg) await addLearned(ho.lastClientMsg, replyCmd[2]);
      await sendTelegram(chatId, "✔️ Sent (saved to the bot's knowledge).");
      return;
    }
    // Reply to a forwarded ticket message that contains [#clientId]
    const ticket = replyText.match(/\[#(\d+)\]/);
    if (ticket) {
      const cid = ticket[1];
      if (photoId) await sendPhotoToChat(cid, photoId, `👤 CoffeeGo team${msg.caption ? ": " + msg.caption : ""}`);
      else await sendTelegram(cid, `👤 CoffeeGo team: ${text}`);
      // The bot learns: pair the client's last question with the team's answer.
      if (!photoId && t.length >= 3 && !t.startsWith("/")) {
        const ho = await getHandoff(cid);
        if (ho && ho.lastClientMsg) await addLearned(ho.lastClientMsg, text);
      }
      await sendTelegram(chatId, "✔️ Sent (saved to the bot's knowledge).");
      return;
    }

    // ----- Client in active handoff -> forward to their agent -----
    const ho = await getHandoff(chatId);
    if (ho && !RESET.includes(t.toLowerCase())) {
      // Remember the client's last text so we can pair it with the agent's answer (learning).
      if (!photoId && text && text !== "[photo]") { ho.lastClientMsg = text; await setHandoff(chatId, ho); }
      if (photoId) await sendPhotoToChat(ho.agentId, photoId, `📩 [#${chatId}] ${clientName}${msg.caption ? ": " + msg.caption : ""}`);
      else await sendTelegram(ho.agentId, `📩 [#${chatId}] ${clientName}: ${text}`);
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
        const support = await resolveAgent("Support / complaint");
        if (support) await sendPhotoToChat(support, photoId, `📷 [#${chatId}] ${clientName}${msg.caption ? ": " + msg.caption : ""}`);
      }
    }
    await runEngine("telegram", chatId, text, (tx, buttons) => sendTelegram(chatId, tx, buttons), clientName);
  } catch (e) {
    console.error("[telegram] handler error:", e);
  }
});

// ---- WhatsApp (Meta Cloud API) ----
app.get("/whatsapp/webhook", (req, res) => {
  const challenge = verifyWhatsAppWebhook(req.query);
  if (challenge) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post("/whatsapp/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    for (const m of parseWhatsAppMessages(req.body)) {
      await runEngine("whatsapp", m.from, m.text, (t) => sendWhatsApp(m.from, t), "WhatsApp user");
    }
  } catch (e) {
    console.error("[whatsapp] handler error:", e);
  }
});

app.get("/", (_req, res) => res.send("CoffeeGo bot is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`CoffeeGo bot listening on :${PORT}`);
  if (process.env.PUBLIC_URL) await setTelegramWebhook(process.env.PUBLIC_URL);
});
