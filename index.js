// CoffeeGo lead bot — Express server hosting Telegram + WhatsApp webhooks.
// One conversation engine drives both channels; qualified chats become Bitrix24 leads.
import express from "express";
import { handleMessage } from "./engine.js";
import { createLead } from "./bitrix.js";
import { sendTelegram, notifyAdminTelegram, setTelegramWebhook } from "./telegram.js";
import { sendWhatsApp, verifyWhatsAppWebhook, parseWhatsAppMessages } from "./whatsapp.js";

const app = express();
app.use(express.json());

// In-memory sessions. For production, swap for Redis/DB (keyed by channel:userId).
const sessions = new Map();
function getSession(key) {
  if (!sessions.has(key)) sessions.set(key, { step: "menu", data: {} });
  return sessions.get(key);
}

async function handleIncoming(channel, userId, text, send) {
  const session = getSession(`${channel}:${userId}`);
  const result = handleMessage(session, text);
  for (const reply of result.replies) {
    await send(reply.text, reply.buttons);
  }
  if (result.lead) {
    const res = await createLead(result.lead);
    const tag = res.ok ? `Bitrix lead #${res.id}` : `lead (Bitrix ${res.error || "not configured"})`;
    await notifyAdminTelegram(
      `New ${channel} lead — ${result.lead.category}\n` +
        `Name: ${result.lead.name}\nPhone: ${result.lead.phone}\n${result.lead.comments}\n(${tag})`
    );
  }
}

// ---- Telegram ----
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = msg.text || "";
  if (text.trim() === "/id") {
    await sendTelegram(chatId, `Your Telegram chat ID: ${chatId}`);
    return;
  }
  try {
    await handleIncoming("telegram", chatId, text, (t, buttons) => sendTelegram(chatId, t, buttons));
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
      await handleIncoming("whatsapp", m.from, m.text, (t) => sendWhatsApp(m.from, t));
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
  // Auto-register Telegram webhook if a public URL is provided.
  if (process.env.PUBLIC_URL) await setTelegramWebhook(process.env.PUBLIC_URL);
});
