// Команда бота: приглашения сотрудников и роли — меню /team у админа.
//
// Владелец 03.10.2026: «по обычной ссылке входят клиенты для контактов,
// сотрудники — по ссылке-приглашению; по кнопке /team — меню (только у
// администратора), где назначать роли».
//
// Приглашение — одноразовая ссылка t.me/<бот>?start=inv_<код>, живёт 48
// часов. Открыл — в команде, админ видит это сразу и раздаёт роли в меню.
// Ссылка ?start=team (заявка с одобрением кнопкой) тоже работает — для
// тех, кому ссылку дали без приглашения.
import { randomBytes } from "node:crypto";
import {
  sendTelegram, sendInline, editMessage, editInline, answerCallback, botUsername,
} from "./telegram.js";
import {
  requestStaff, getStaffRequest, dropStaffRequest, markDeclined, declinedAt, addLeadWatcher,
  removeLeadWatcher, listLeadWatchers, roleMembers, addRoleMember, removeRoleMember,
  addTeamMember, removeTeamMember, listTeam, createInvite, takeInvite,
} from "./store.js";

export const JOIN_START = "/start team";
const INVITE_PREFIX = "/start inv_";
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const REPEAT_MS = 60 * 60 * 1000;   // повторный «Старт» в течение часа не дёргает админа
const DECLINE_QUIET_MS = 7 * 24 * 60 * 60 * 1000;   // отказ помним неделю

// Роли: на каждую — сколько угодно человек; админу приходит всё всегда
// (владелец 03.10.2026: «несколько человек на позицию, и мне обязательно»)
export const ROLES = {
  leads: "📬 Заявки с сайта",
  sales: "💼 Продажи",
  support: "🛠 Поддержка",
  invest: "💰 Инвестиции",
};

const esc = (s) => String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
const isAdmin = (id, admin) => admin && String(id) === String(admin);

async function rolesOf(id) {
  const out = [];
  for (const role of Object.keys(ROLES)) {
    if ((await roleMembers(role)).includes(String(id))) out.push(role);
  }
  return out;
}

// ------------------------------------------------------------ вход

/** Сообщение — вход сотрудника? Тогда обработать и вернуть true. */
export async function onStart(chatId, name, text, admin) {
  const t = text.trim();
  if (t.toLowerCase() === JOIN_START) { await askToJoin(chatId, name, admin); return true; }
  if (t.startsWith(INVITE_PREFIX)) { await useInvite(chatId, name, t.slice(INVITE_PREFIX.length), admin); return true; }
  return false;
}

async function useInvite(chatId, name, code, admin) {
  const invite = await takeInvite(code);
  if (!invite || Date.now() - invite.at > INVITE_TTL_MS) {
    await sendTelegram(chatId, "Ссылка-приглашение недействительна или уже использована. " +
      "Попросите у администратора новую.");
    return;
  }
  await addTeamMember(chatId, name);
  await sendTelegram(chatId, "✅ Вы в команде CoffeeGo. Администратор назначит, что вам " +
    "приходит: заявки с сайта или обращения клиентов.");
  if (admin) {
    await sendInline(admin, `👋 По приглашению вступил: <b>${esc(name)}</b> (id ${chatId}). Назначьте роль:`,
      memberRows(chatId, []));
  }
}

async function askToJoin(chatId, name, admin) {
  if (!admin) { await sendTelegram(chatId, "Приём сотрудников сейчас не настроен."); return; }
  if (isAdmin(chatId, admin)) {
    await sendTelegram(chatId, "Вы администратор бота — команда и роли: /team.");
    return;
  }
  if (Date.now() - (await declinedAt(chatId)) < DECLINE_QUIET_MS) {
    await sendTelegram(chatId, "Доступ к команде не одобрен. Если это ошибка — свяжитесь с администратором CoffeeGo.");
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
  await sendInline(admin, `🙋 Просится в команду бота: <b>${esc(name)}</b> (id ${chatId}).`, [
    [{ text: "✅ Принять в команду", data: `tm:ok:${chatId}` }],
    [{ text: "❌ Отклонить", data: `tm:no:${chatId}` }],
  ]);
}

// ------------------------------------------------------------ меню /team

async function teamScreen() {
  const team = await listTeam();
  const lines = ["👥 <b>Команда бота</b>"];
  const rows = [];
  for (const member of team) {
    const roles = await rolesOf(member.id);
    const label = roles.length ? roles.map((r) => ROLES[r].split(" ")[0]).join("") : "без роли";
    lines.push(`• ${esc(member.name || member.id)} — ${roles.map((r) => ROLES[r]).join(", ") || "без роли"}`);
    rows.push([{ text: `${member.name || member.id} · ${label}`.slice(0, 60), data: `tm:m:${member.id}` }]);
  }
  if (!team.length) lines.push("Пока никого. Пригласите сотрудника кнопкой ниже.");
  lines.push("", "Вам приходит всё: заявки с сайта и обращения клиентов — " +
    "кто бы ни был назначен.");
  rows.push([{ text: "➕ Пригласить сотрудника", data: "tm:inv" }]);
  return [lines.join("\n"), rows];
}

function memberRows(id, roles) {
  const rows = Object.entries(ROLES).map(([role, text]) =>
    [{ text: `${roles.includes(role) ? "✅" : "▫️"} ${text}`, data: `tm:t:${id}:${role}` }]);
  rows.push([{ text: "❌ Убрать из команды", data: `tm:rm:${id}` }]);
  rows.push([{ text: "⬅️ Команда", data: "tm:list" }]);
  return rows;
}

async function memberScreen(id) {
  const team = await listTeam();
  const member = team.find((m) => String(m.id) === String(id)) || { id, name: "" };
  const roles = await rolesOf(id);
  const text = `👤 <b>${esc(member.name || id)}</b> (id ${id})\n` +
    "Нажмите роль, чтобы включить или выключить. На одну роль можно " +
    "назначить нескольких — получат все; вам приходит всегда.";
  return [text, memberRows(id, roles)];
}

async function inviteText() {
  const code = randomBytes(9).toString("base64url");
  await createInvite(code, "admin");
  const link = `https://t.me/${await botUsername()}?start=inv_${code}`;
  return "🔗 Ссылка-приглашение для сотрудника — одноразовая, действует 48 часов:\n" +
    `${link}\n\nПерешлите её сотруднику. Клиентам давайте обычную ссылку на бота.`;
}

/** Команды админа: /team — меню, /invite — ссылка. true — команда наша. */
export async function teamCommand(chatId, t) {
  if (t === "/team") {
    const [text, rows] = await teamScreen();
    await sendInline(chatId, text, rows);
    return true;
  }
  if (t === "/invite") {
    await sendTelegram(chatId, await inviteText());
    return true;
  }
  const unwatch = t.match(/^\/unwatch\s+(-?\d+)/);
  if (unwatch) {
    await removeRoleMember("leads", unwatch[1]);
    await sendTelegram(chatId, `✅ ${unwatch[1]} больше не получает заявки с сайта.`);
    return true;
  }
  return false;
}

/** Нажатие кнопки меню команды. true — нажатие наше. */
export async function onTeamButton(cb, admin) {
  const data = String(cb.data || "");
  if (!data.startsWith("tm:") && !data.startsWith("staff:")) return false;
  if (!isAdmin(cb.from && cb.from.id, admin)) {
    await answerCallback(cb.id, "Только для администратора.");
    return true;
  }
  const chat = cb.message && cb.message.chat ? cb.message.chat.id : admin;
  const messageId = cb.message && cb.message.message_id;
  const [, action, id, role] = data.split(":");
  const show = async ([text, rows]) => {
    if (messageId) await editInline(chat, messageId, text, rows);
    else await sendInline(chat, text, rows);
  };

  if (action === "list") { await show(await teamScreen()); return answerCallback(cb.id).then(() => true); }
  if (action === "inv") {
    await sendTelegram(chat, await inviteText());
    await answerCallback(cb.id, "Ссылка готова");
    return true;
  }
  if (action === "m") { await show(await memberScreen(id)); await answerCallback(cb.id); return true; }
  if (action === "t" && ROLES[role]) {
    const has = (await rolesOf(id)).includes(role);
    if (has) await removeRoleMember(role, id); else await addRoleMember(role, id);
    await addTeamMember(id);
    if (!has) {
      await sendTelegram(id, role === "leads"
        ? "✅ Теперь сюда будут приходить заявки клиентов с сайта coffee-go.ae."
        : `✅ Вы — ответственный: ${ROLES[role]}. Обращения клиентов будут приходить сюда; ` +
          "отвечайте ответом на сообщение.");
    }
    await show(await memberScreen(id));
    await answerCallback(cb.id, has ? "Снято" : "Назначено");
    return true;
  }
  if (action === "rm") {
    await removeTeamMember(id);
    await sendTelegram(id, "Доступ к команде CoffeeGo закрыт администратором.");
    await show(await teamScreen());
    await answerCallback(cb.id, "Убран");
    return true;
  }
  // Заявка по ссылке ?start=team
  if (action === "ok" || action === "no") {
    const request = await getStaffRequest(id);
    if (!request) { await answerCallback(cb.id, "Эту заявку уже разобрали."); return true; }
    await dropStaffRequest(id);
    if (action === "no") {
      await markDeclined(id);
      if (messageId) await editMessage(chat, messageId, `❌ ${esc(request.name || id)} — не принят.`);
      await answerCallback(cb.id, "Отклонено");
      return true;
    }
    await addTeamMember(id, request.name);
    await sendTelegram(id, "✅ Вы в команде CoffeeGo. Администратор назначит, что вам приходит.");
    await show(await memberScreen(id));
    await answerCallback(cb.id, "Принят — назначьте роль");
    return true;
  }
  await answerCallback(cb.id, "Не понял кнопку.");
  return true;
}

/** Кому отправить заявку с сайта: роль «Заявки с сайта»; пока в ней
 *  никого — продажи; админ — всегда. */
export async function leadRecipients(admin) {
  let ids = await roleMembers("leads");
  if (!ids.length) ids = await roleMembers("sales");
  if (admin && !ids.includes(String(admin))) ids.push(String(admin));
  return ids;
}
