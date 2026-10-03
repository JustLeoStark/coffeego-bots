// Telegram Bot API helpers (send messages, optional admin notify).
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || "";
// Адрес API можно подменить для локальной проверки без настоящего Telegram
const BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const API = (method) => `${BASE}/bot${TOKEN}/${method}`;

async function call(method, body) {
  const res = await fetch(API(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`[telegram] ${method} failed:`, res.status, await res.text());
  return res;
}

// Сообщение с кнопками под ним (inline): rows — [[{text, data}], ...]
export async function sendInline(chatId, text, rows) {
  await call("sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    reply_markup: { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) },
  });
}

// Поправить сообщение — например, кнопки заявки превратить в «одобрено»
export async function editMessage(chatId, messageId, text) {
  await call("editMessageText", {
    chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// Имя бота для ссылок-приглашений — один раз спрашиваем у Telegram
let USERNAME = process.env.TELEGRAM_BOT_USERNAME || "";
export async function botUsername() {
  if (USERNAME || !TOKEN) return USERNAME || "CoffeeGoUAE_bot";
  try {
    const res = await call("getMe", {});
    const json = await res.json();
    USERNAME = (json.result && json.result.username) || "CoffeeGoUAE_bot";
  } catch { USERNAME = "CoffeeGoUAE_bot"; }
  return USERNAME;
}

// Поправить сообщение вместе с кнопками — меню команды листается на месте
export async function editInline(chatId, messageId, text, rows) {
  await call("editMessageText", {
    chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) },
  });
}

// Ответ на нажатие кнопки: без него у человека крутятся часики
export async function answerCallback(id, text) {
  await call("answerCallbackQuery", { callback_query_id: id, text: text || "" });
}

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

// Route a lead category to the right employee's chat id (env-driven).
// Falls back to the admin chat when a role is not configured.
export function routeChatId(category) {
  const c = (category || "").toLowerCase();
  const env = process.env;
  const admin = env.TELEGRAM_ADMIN_CHAT_ID || "";
  if (c.includes("support") || c.includes("complaint") || c.includes("question")) {
    return env.TELEGRAM_SUPPORT_CHAT_ID || admin;
  }
  if (c.includes("invest") || c.includes("partner")) {
    return env.TELEGRAM_INVEST_CHAT_ID || admin;
  }
  if (c.includes("office") || c.includes("developer") || c.includes("building") || c.includes("hand")) {
    return env.TELEGRAM_SALES_CHAT_ID || admin;
  }
  return admin;
}

// Notify the employee responsible for this category (with admin fallback).
export async function notifyRole(category, text) {
  const id = routeChatId(category);
  if (!id) return;
  await sendTelegram(id, "🔔 " + text);
}

// Re-send a photo (by Telegram file_id) to a specific chat.
export async function sendPhotoToChat(chatId, fileId, caption) {
  if (!chatId || !TOKEN) return;
  const res = await fetch(API("sendPhoto"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: fileId, caption: caption || "" }),
  });
  if (!res.ok) console.error("[telegram] sendPhoto failed:", res.status, await res.text());
}

// Back-compat: photo to the admin chat.
export async function sendPhotoToAdmin(fileId, caption) {
  await sendPhotoToChat(ADMIN_CHAT_ID, fileId, caption);
}

// Меню команд «/» в Telegram. Клиентам — только начать заново; админу —
// управление командой и заявками. Без этого меню пустое, и команды
// приходится помнить наизусть (владелец 03.10: «нет меню команды»).
export async function setTelegramCommands(adminChatId) {
  if (!TOKEN) return;
  await call("setMyCommands", {
    commands: [{ command: "start", description: "Start / Начать" },
               { command: "menu", description: "Menu / Меню" }],
  });
  if (!adminChatId) return;
  await call("setMyCommands", {
    scope: { type: "chat", chat_id: Number(adminChatId) },
    commands: [
      { command: "team", description: "Команда: роли, пригласить, убрать" },
      { command: "invite", description: "Ссылка-приглашение для сотрудника" },
      { command: "assignments", description: "Кто за что отвечает" },
      { command: "staff", description: "Все, кто писал боту" },
      { command: "stats", description: "Обращения по регионам" },
      { command: "regions", description: "Регионы" },
      { command: "adminhelp", description: "Все команды админа" },
      { command: "menu", description: "Меню клиента" },
    ],
  });
  console.log("[telegram] commands menu set");
}

// Register the webhook URL with Telegram (call once, or use setWebhook manually).
export async function setTelegramWebhook(publicUrl) {
  if (!TOKEN) return;
  const url = `${publicUrl.replace(/\/?$/, "")}/telegram/webhook`;
  const res = await fetch(API("setWebhook"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // callback_query — нажатия кнопок: ими одобряются заявки сотрудников
    body: JSON.stringify({ url, allowed_updates: ["message", "callback_query"] }),
  });
  console.log("[telegram] setWebhook", url, "->", res.status);
}
