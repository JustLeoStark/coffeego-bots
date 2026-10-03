// Вход сотрудников по заявке: ссылка t.me/<бот>?start=team → кнопки админу.
//
// Клиенты приходят в того же бота по обычной ссылке и попадают в диалог с
// помощником — поэтому сотрудник просится по отдельной ссылке, а не просто
// «Стартом». Пока админ не нажал кнопку, человек ничего не получает.
import { sendTelegram, sendInline, editMessage, answerCallback } from "./telegram.js";
import {
  requestStaff, getStaffRequest, dropStaffRequest, addLeadWatcher,
  removeLeadWatcher, listLeadWatchers, setAssignment, getAssignments,
} from "./store.js";

export const JOIN_START = "/start team";
const REPEAT_MS = 60 * 60 * 1000;   // повторный «Старт» в течение часа не дёргает админа

// Что можно поручить: копия заявок с сайта (сколько угодно человек) или
// роль ответственного (одна на роль — назначение заменяет прежнего)
export const CHOICES = {
  leads: "📬 Заявки с сайта",
  sales: "💼 Продажи — ответственный",
  support: "🛠 Поддержка — ответственный",
  invest: "💰 Инвестиции — ответственный",
};

const esc = (s) => String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);

/** Человек открыл ссылку для сотрудников. */
export async function askToJoin(chatId, name, admin) {
  if (!admin) {
    await sendTelegram(chatId, "Приём сотрудников сейчас не настроен.");
    return;
  }
  if (String(chatId) === String(admin)) {
    await sendTelegram(chatId, "Вы администратор бота — одобрять заявки будете вы.");
    return;
  }
  const previous = await getStaffRequest(chatId);
  await requestStaff(chatId, name);
  if (previous && Date.now() - previous.at < REPEAT_MS) {
    await sendTelegram(chatId, "⏳ Запрос уже у администратора — дождитесь одобрения.");
    return;
  }
  await sendTelegram(chatId,
    "📨 Запрос на доступ отправлен администратору CoffeeGo. Как только одобрят — бот напишет вам.");
  const rows = Object.entries(CHOICES).map(([role, text]) => [{ text, data: `staff:${chatId}:${role}` }]);
  rows.push([{ text: "❌ Отклонить", data: `staff:${chatId}:no` }]);
  await sendInline(admin,
    `🙋 Просится в команду бота: <b>${esc(name)}</b> (id ${chatId}).\nЧто ему поручить?`, rows);
}

/** Админ нажал кнопку под заявкой. Возвращает true, если нажатие наше. */
export async function onStaffButton(cb, admin) {
  const data = String(cb.data || "");
  if (!data.startsWith("staff:")) return false;
  const [, id, role] = data.split(":");
  const message = cb.message || {};
  if (String(cb.from && cb.from.id) !== String(admin)) {
    await answerCallback(cb.id, "Одобряет только администратор.");
    return true;
  }
  const request = await getStaffRequest(id);
  if (!request) {
    await answerCallback(cb.id, "Эту заявку уже разобрали.");
    return true;
  }
  const name = request.name || id;
  let result;
  if (role === "no") {
    result = `❌ ${esc(name)} — не одобрен.`;
  } else if (role === "leads") {
    await addLeadWatcher(id, name);
    result = `✅ ${esc(name)} — получает заявки с сайта.`;
    await sendTelegram(id, "✅ Доступ открыт: сюда будут приходить заявки клиентов с сайта coffee-go.ae.");
  } else if (CHOICES[role]) {
    await setAssignment(role, id);
    result = `✅ ${esc(name)} — ${CHOICES[role]}.`;
    await sendTelegram(id, `✅ Доступ открыт: вы — ${CHOICES[role].replace(/^\S+\s/, "")}. ` +
      "Обращения клиентов будут приходить сюда; отвечайте ответом на сообщение.");
  } else {
    await answerCallback(cb.id, "Не понял кнопку.");
    return true;
  }
  await dropStaffRequest(id);
  if (message.chat) await editMessage(message.chat.id, message.message_id, result);
  await answerCallback(cb.id, result.replace(/<[^>]+>/g, ""));
  return true;
}

/** Команды админа про команду бота: /team, /unwatch <id>. true — команда наша. */
export async function teamCommand(chatId, t) {
  if (t === "/team") {
    const watchers = await listLeadWatchers();
    const roles = await getAssignments();
    const lines = [
      "👥 Команда бота",
      "📬 Заявки с сайта: " + (watchers.length ? watchers.map((w) => `${w.name || "?"} (${w.id})`).join(", ") : "только вы"),
      ...Object.entries(roles).map(([role, id]) => `${CHOICES[role.split("@")[0]] || role}: ${id || "вы"}`),
      "",
      "Пригласить сотрудника: дайте ему ссылку на бота с ?start=team",
      "Убрать из получателей заявок: /unwatch <id>",
    ];
    await sendTelegram(chatId, lines.join("\n"));
    return true;
  }
  const unwatch = t.match(/^\/unwatch\s+(-?\d+)/);
  if (unwatch) {
    await removeLeadWatcher(unwatch[1]);
    await sendTelegram(chatId, `✅ ${unwatch[1]} больше не получает заявки с сайта.`);
    return true;
  }
  return false;
}

/** Кому, кроме ответственного и админа, отправить заявку с сайта. */
export async function leadWatchers(except = []) {
  const skip = new Set(except.filter(Boolean).map(String));
  return (await listLeadWatchers()).map((w) => w.id).filter((id) => !skip.has(String(id)));
}
