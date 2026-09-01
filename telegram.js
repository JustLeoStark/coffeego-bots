// Telegram Bot API helpers (send messages, optional admin notify).
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || "";
const API = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

export async function sendTelegram(chatId, text, buttons) {
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (buttons && buttons.length) {
    body.reply_markup = {
      keyboard: buttons.map((b) => [{ text: b.label }]),
      resize_keyboard: true,
      one_time_keyboard: false,
    };
  }
  const res = await fetch(API("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error("[telegram] send failed:", res.status, await res.text());
}

export async function notifyAdminTelegram(text) {
  if (!ADMIN_CHAT_ID) return;
  await sendTelegram(ADMIN_CHAT_ID, "🔔 " + text);
}

// Re-send a photo (by Telegram file_id) to the admin chat.
export async function sendPhotoToAdmin(fileId, caption) {
  if (!ADMIN_CHAT_ID || !TOKEN) return;
  const res = await fetch(API("sendPhoto"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, photo: fileId, caption: caption || "" }),
  });
  if (!res.ok) console.error("[telegram] sendPhoto failed:", res.status, await res.text());
}

// Register the webhook URL with Telegram (call once, or use setWebhook manually).
export async function setTelegramWebhook(publicUrl) {
  if (!TOKEN) return;
  const url = `${publicUrl.replace(/\/?$/, "")}/telegram/webhook`;
  const res = await fetch(API("setWebhook"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, allowed_updates: ["message"] }),
  });
  console.log("[telegram] setWebhook", url, "->", res.status);
}
