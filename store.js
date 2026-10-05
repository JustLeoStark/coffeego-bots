// Persistent store for staff, assignments and live-handoff state.
// Uses Upstash Redis (REST) when configured, else an in-memory fallback
// (fine for testing; resets on restart).
const URL = process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const mem = new Map(); // key -> value (string) ; sets stored as Set
const memExpiry = new Map(); // key -> мгновение (мс), когда ключ исчезает

async function cmd(args) {
  if (!URL || !TOKEN) return memCmd(args);
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      // Upstash завис — не держим обработчик Telegram
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return json.result;
  } catch (e) {
    console.error("[store] redis error, using memory:", e.message);
    return memCmd(args);
  }
}

// Несколько команд одним запросом (Upstash /pipeline): состав команды
// читается десятком команд, по запросу на каждую выходило медленно.
// Сбой Upstash здесь — исключение, а не память: кто сотрудник, по пустой
// памяти не решить (аудит 05.10)
async function pipeline(commands) {
  if (!URL || !TOKEN) return commands.map(memCmd);
  const res = await fetch(`${URL.replace(/\/+$/, "")}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Upstash ответил ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json) || json.length !== commands.length) throw new Error("Upstash: странный ответ");
  return json.map((row) => {
    if (!row || row.error) throw new Error(`Upstash: ${row ? row.error : "пусто"}`);
    return row.result;
  });
}

// Одна команда, сбой — исключение (без подмены памятью)
async function strictCmd(args) {
  return (await pipeline([args]))[0];
}

function memCmd([op, key, a, b, ...rest]) {
  op = op.toUpperCase();
  if (memExpiry.has(key) && memExpiry.get(key) <= Date.now()) {
    mem.delete(key);
    memExpiry.delete(key);
  }
  if (op === "SET") {
    // NX — только если ключа нет; EX / PX / PXAT — срок жизни ключа
    const opts = [b, ...rest].map((x) => String(x ?? ""));
    const upper = opts.map((x) => x.toUpperCase());
    if (upper.includes("NX") && mem.has(key)) return null;
    mem.set(key, String(a));
    memExpiry.delete(key);
    const at = (flag) => { const i = upper.indexOf(flag); return i >= 0 ? Number(opts[i + 1]) : null; };
    if (at("EX") !== null) memExpiry.set(key, Date.now() + at("EX") * 1000);
    if (at("PX") !== null) memExpiry.set(key, Date.now() + at("PX"));
    if (at("PXAT") !== null) memExpiry.set(key, at("PXAT"));
    return "OK";
  }
  if (op === "DEL") memExpiry.delete(key);
  if (op === "LLEN") { const l = mem.get(key); return Array.isArray(l) ? l.length : 0; }
  if (op === "LPOP") {
    const l = Array.isArray(mem.get(key)) ? mem.get(key) : [];
    const n = a === undefined ? 1 : Number(a);
    const out = l.splice(0, n);
    mem.set(key, l);
    return a === undefined ? (out[0] ?? null) : out;
  }
  if (op === "GET") { return mem.has(key) ? mem.get(key) : null; }
  if (op === "DEL") { return mem.delete(key) ? 1 : 0; }
  if (op === "SADD") { const s = mem.get(key) instanceof Set ? mem.get(key) : new Set(); s.add(String(a)); mem.set(key, s); return 1; }
  if (op === "SREM") { const s = mem.get(key); if (s instanceof Set) s.delete(String(a)); return 1; }
  if (op === "SMEMBERS") { const s = mem.get(key); return s instanceof Set ? [...s] : []; }
  if (op === "RPUSH") { const l = Array.isArray(mem.get(key)) ? mem.get(key) : []; l.push(String(a)); mem.set(key, l); return l.length; }
  if (op === "LRANGE") { const l = Array.isArray(mem.get(key)) ? mem.get(key) : []; return sliceRange(l, Number(a), Number(b)); }
  if (op === "LTRIM") { const l = Array.isArray(mem.get(key)) ? mem.get(key) : []; mem.set(key, sliceRange(l, Number(a), Number(b))); return "OK"; }
  return null;
}

function sliceRange(l, start, stop) {
  const n = l.length;
  let s = start < 0 ? n + start : start;
  let e = stop < 0 ? n + stop : stop;
  if (s < 0) s = 0;
  return l.slice(s, e + 1);
}

// ---- Subscribers (anyone who started the bot) ----
export async function recordSubscriber(id, name) {
  await cmd(["SADD", "subs", String(id)]);
  if (name) await cmd(["SET", `sub:${id}`, name]);
}
export async function listSubscribers() {
  const ids = (await cmd(["SMEMBERS", "subs"])) || [];
  const out = [];
  for (const id of ids) out.push({ id, name: (await cmd(["GET", `sub:${id}`])) || "" });
  return out;
}

// ---- Заявки сотрудников и получатели заявок с сайта ----
// Владелец 03.10.2026: «как в @CoffeeGoAI_Bot — даю ссылку, человек жмёт
// Старт, я вижу, кто просится, и ставлю галочку». Заявка хранится, пока
// её не одобрили или не отклонили.
export async function requestStaff(id, name) {
  await cmd(["SET", `staffreq:${id}`, JSON.stringify({ name: name || "", at: Date.now() })]);
}
export async function getStaffRequest(id) {
  const v = await cmd(["GET", `staffreq:${id}`]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
export async function dropStaffRequest(id) {
  await cmd(["DEL", `staffreq:${id}`]);
}
// Отказ помним, чтобы отклонённый не стучался снова каждый час
export async function markDeclined(id) {
  await cmd(["SET", `staffdeclined:${id}`, String(Date.now())]);
}
export async function declinedAt(id) {
  const v = await cmd(["GET", `staffdeclined:${id}`]);
  return v ? Number(v) : 0;
}
// Кто получает копию каждой заявки с сайта — сколько угодно человек,
// в отличие от ответственного по роли, который один
export async function addLeadWatcher(id, name) {
  forgetTeamCache();
  await cmd(["SADD", "leadwatch", String(id)]);
  if (name) await cmd(["SET", `sub:${id}`, name]);
}
export async function removeLeadWatcher(id) {
  forgetTeamCache();
  await cmd(["SREM", "leadwatch", String(id)]);
}
export async function listLeadWatchers() {
  const ids = (await cmd(["SMEMBERS", "leadwatch"])) || [];
  const out = [];
  for (const id of ids) out.push({ id, name: (await cmd(["GET", `sub:${id}`])) || "" });
  return out;
}

// ---- Команда бота и приглашения ----
// Сотрудники входят по одноразовой ссылке-приглашению, которую делает
// админ; клиенты — по обычной ссылке (владелец 03.10.2026)
export async function addTeamMember(id, name) {
  forgetTeamCache();
  await cmd(["SADD", "team", String(id)]);
  if (name) await cmd(["SET", `sub:${id}`, name]);
}
export async function removeTeamMember(id) {
  forgetTeamCache();
  await cmd(["SREM", "team", String(id)]);
  await cmd(["SREM", "leadwatch", String(id)]);
  for (const role of ["leads", "sales", "support", "invest"]) {
    await cmd(["SREM", `role:${role}`, String(id)]);
  }
  for (const [role, agent] of Object.entries(await getAssignments())) {
    if (String(agent) === String(id)) await cmd(["SET", `assign:${role}`, ""]);
  }
}
export async function listTeam() {
  const ids = new Set([...(((await cmd(["SMEMBERS", "team"])) || [])),
                       ...(((await cmd(["SMEMBERS", "leadwatch"])) || []))]);
  for (const role of ["leads", "sales", "support", "invest"]) {
    for (const id of ((await cmd(["SMEMBERS", `role:${role}`])) || [])) ids.add(String(id));
  }
  for (const agent of Object.values(await getAssignments())) if (agent) ids.add(String(agent));
  ids.delete(String(process.env.TELEGRAM_ADMIN_CHAT_ID || ""));   // админ — не участник
  const out = [];
  for (const id of ids) out.push({ id, name: (await cmd(["GET", `sub:${id}`])) || "" });
  return out;
}
export async function isLeadWatcher(id) {
  return ((await cmd(["SMEMBERS", "leadwatch"])) || []).map(String).includes(String(id));
}
export async function createInvite(code, by) {
  await cmd(["SET", `invite:${code}`, JSON.stringify({ by: String(by), at: Date.now() })]);
}
export async function takeInvite(code) {
  const v = await cmd(["GET", `invite:${code}`]);
  if (!v) return null;
  await cmd(["DEL", `invite:${code}`]);   // одноразовое
  try { return JSON.parse(v); } catch { return null; }
}

// ---- Assignments (role -> agent chat id) ----
// Роль может быть с регионом: "support@ru", "sales@uae". Без региона —
// общая роль на всю сеть, она же запасной вариант.
export async function setAssignment(role, agentId) {
  forgetTeamCache();
  await cmd(["SET", `assign:${role}`, String(agentId)]);
  await cmd(["SADD", "assign:keys", String(role)]);
}
export async function getAssignment(role) {
  return await cmd(["GET", `assign:${role}`]);
}
export async function getAssignments() {
  const base = ["support", "sales", "invest", "default"];
  const extra = (await cmd(["SMEMBERS", "assign:keys"])) || [];
  const out = {};
  for (const r of [...new Set([...base, ...extra])]) {
    const v = await cmd(["GET", `assign:${r}`]);
    if (v || base.includes(r)) out[r] = v;
  }
  return out;
}

// ---- Статистика обращений по регионам и франшизам ----
// Нужна, чтобы управлять франшизой по фактам: сколько обращений пришло,
// как быстро ответили, кто отвечает медленнее остальных.
export async function logTicket(region, role, agentId) {
  const day = new Date().toISOString().slice(0, 10);
  await cmd(["RPUSH", "tickets",
             JSON.stringify({ t: Date.now(), day, region, role,
                              agent: String(agentId || "") })]);
  await cmd(["LTRIM", "tickets", "-5000", "-1"]);
}

export async function logFirstReply(clientId, seconds, region) {
  await cmd(["RPUSH", "replies",
             JSON.stringify({ t: Date.now(), client: String(clientId),
                              sec: Math.round(seconds), region })]);
  await cmd(["LTRIM", "replies", "-5000", "-1"]);
}

export async function regionStats(days = 30) {
  const edge = Date.now() - days * 86400 * 1000;
  const tickets = (await cmd(["LRANGE", "tickets", "-5000", "-1"])) || [];
  const replies = (await cmd(["LRANGE", "replies", "-5000", "-1"])) || [];
  const out = {};
  const take = (v) => { try { return JSON.parse(v); } catch { return null; } };

  for (const raw of tickets) {
    const x = take(raw);
    if (!x || x.t < edge) continue;
    const r = (out[x.region] ||= { обращений: 0, ответов: 0, сумма_сек: 0 });
    r.обращений++;
  }
  for (const raw of replies) {
    const x = take(raw);
    if (!x || x.t < edge) continue;
    const r = (out[x.region] ||= { обращений: 0, ответов: 0, сумма_сек: 0 });
    r.ответов++;
    r.сумма_сек += x.sec;
  }
  for (const r of Object.values(out)) {
    r.среднее_время_ответа_мин = r.ответов
      ? Math.round(r.сумма_сек / r.ответов / 60) : null;
    delete r.сумма_сек;
  }
  return { дней: days, по_регионам: out };
}

// ---- Live handoff (client chat -> agent chat) ----
export async function setHandoff(clientId, data) {
  await cmd(["SET", `handoff:${clientId}`, JSON.stringify(data)]);
}
export async function getHandoff(clientId) {
  const v = await cmd(["GET", `handoff:${clientId}`]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
export async function clearHandoff(clientId) {
  await cmd(["DEL", `handoff:${clientId}`]);
}

// ---- Learned answers (bot learns from staff replies) ----
export async function addLearned(question, answer) {
  const q = (question || "").trim();
  const a = (answer || "").trim();
  if (q.length < 3 || a.length < 3) return;
  await cmd(["RPUSH", "kb:learned", JSON.stringify({ q, a })]);
  await cmd(["LTRIM", "kb:learned", "-300", "-1"]); // keep the last 300
}
export async function getLearned(n = 40) {
  const arr = (await cmd(["LRANGE", "kb:learned", String(-n), "-1"])) || [];
  const out = [];
  for (const v of arr) { try { out.push(JSON.parse(v)); } catch { /* skip */ } }
  return out;
}

// ---- Роли — несколько человек на роль (владелец 03.10.2026) ----
// Было: один ответственный на роль (assign:<роль>) и отдельный список
// получателей заявок (leadwatch). Теперь роль — множество role:<роль>;
// старые записи читаются как участники, чтобы ничего не потерять.
export const TEAM_ROLES = ["leads", "sales", "support", "invest"];

export async function roleMembers(role) {
  const ids = new Set(((await cmd(["SMEMBERS", `role:${role}`])) || []).map(String));
  const single = await cmd(["GET", `assign:${role}`]);
  if (single) ids.add(String(single));
  if (role === "leads") for (const id of ((await cmd(["SMEMBERS", "leadwatch"])) || [])) ids.add(String(id));
  return [...ids];
}
export async function addRoleMember(role, id) {
  forgetTeamCache();
  await cmd(["SADD", `role:${role}`, String(id)]);
}
export async function removeRoleMember(role, id) {
  forgetTeamCache();
  await cmd(["SREM", `role:${role}`, String(id)]);
  if (String(await cmd(["GET", `assign:${role}`]) || "") === String(id)) {
    await cmd(["SET", `assign:${role}`, ""]);
  }
  if (role === "leads") await cmd(["SREM", "leadwatch", String(id)]);
}

function roleOf(category) {
  const c = (category || "").toLowerCase();
  if (c.includes("support") || c.includes("complaint") || c.includes("question")) return "support";
  if (c.includes("invest") || c.includes("partner")) return "invest";
  if (c.includes("office") || c.includes("developer") || c.includes("building") || c.includes("hand")) return "sales";
  return "default";
}

/** Кому идёт обращение: ответственный по региону (если задан командой
 *  /assign роль@регион), иначе все участники роли, иначе дежурный. Админ —
 *  всегда: владелец хочет видеть всё (03.10.2026). */
export async function resolveAgents(category, region) {
  const role = roleOf(category);
  const admin = process.env.TELEGRAM_ADMIN_CHAT_ID || "";
  let agents = [];
  if (region) {
    const local = await getAssignment(`${role}@${region}`);
    if (local) agents = [String(local)];
  }
  if (!agents.length && role !== "default") agents = await roleMembers(role);
  if (!agents.length) {
    const fallback = await getAssignment(region ? `default@${region}` : "default") ||
      await getAssignment("default");
    if (fallback) agents = [String(fallback)];
  }
  if (admin && !agents.includes(String(admin))) agents.push(String(admin));
  return agents;
}

// Resolve which agent handles a category, using assignments (admin fallback).
// Регион задаёт приоритет: сначала ответственный за этот рынок, потом общий
// по роли, потом дежурный, и только в конце — админ.
export async function resolveAgent(category, region) {
  const c = (category || "").toLowerCase();
  let role = "default";
  if (c.includes("support") || c.includes("complaint") || c.includes("question")) role = "support";
  else if (c.includes("invest") || c.includes("partner")) role = "invest";
  else if (c.includes("office") || c.includes("developer") || c.includes("building") || c.includes("hand")) role = "sales";
  const admin = process.env.TELEGRAM_ADMIN_CHAT_ID || "";
  const keys = region
    ? [`${role}@${region}`, role, `default@${region}`, "default"]
    : [role, "default"];
  for (const k of keys) {
    const v = await getAssignment(k);
    if (v) return v;
  }
  return admin;
}

// ---- Очередь повторов (пересылка в CRM) ----
// Список Redis: новые — в хвост, повтор смотрит голову (LRANGE) и снимает
// её атомарно LPOP key n только после ответа CRM — упали посередине,
// записи уйдут ещё раз (CRM узнаёт повтор). Голову никто, кроме повтора,
// не трогает: переполненная очередь не обрезается с головы, а не берёт
// новое — иначе LPOP снял бы не те записи.
// Только strictCmd: сбой Upstash — исключение, а не память. Иначе
// посреди прохода LRANGE взял бы записи из памяти, а LPOP снял бы из
// Redis — другие (аудит 05.10). Проход прерывается до следующей минуты.
export async function queuePush(key, value, max = 500) {
  if (Number(await strictCmd(["LLEN", key])) >= max) return false;
  await strictCmd(["RPUSH", key, String(value)]);
  return true;
}
export async function queueRange(key, n) {
  return (await strictCmd(["LRANGE", key, "0", String(n - 1)])) || [];
}
export async function queuePop(key, n) {
  if (n <= 0) return [];
  const out = await strictCmd(["LPOP", key, String(n)]);
  return Array.isArray(out) ? out : out ? [out] : [];
}
export async function queueLength(key) {
  return Number(await strictCmd(["LLEN", key])) || 0;
}

// Замок прохода повтора: во время выкладки на Render два экземпляра бота
// работают одновременно, и оба разбирали бы одну очередь. Ключ живёт
// 55 секунд — меньше минуты между проходами. true — замок наш
export async function lockFlush(token, ms = 55000) {
  return (await strictCmd(["SET", "crm:flush-lock", token, "NX", "PX", String(ms)])) === "OK";
}
export async function unlockFlush(token) {
  try {
    if ((await strictCmd(["GET", "crm:flush-lock"])) === token) {
      await strictCmd(["DEL", "crm:flush-lock"]);
    }
  } catch { /* истечёт сам */ }
}

// ---- Бот молчит: отвечает человек (владелец 05.10.2026) ----
// Менеджер ответил клиенту из CRM или сотрудник через бота — сценарий и
// ИИ в этом чате молчат до pause:<chat> (сутки с последнего ответа
// человека). Снимает кнопка «Вернуть бота» в CRM или /close.
export async function setPause(chatId, until) {
  // PXAT — ключ сам исчезнет, когда пауза кончится
  const at = Math.round(until);
  await cmd(["SET", `pause:${chatId}`, String(at), "PXAT", String(at)]);
}

// Одноразовый номер вызова CRM → бот: повтор перехваченного вызова в
// пределах окна подписи отвергается. true — номер новый
export async function takeNonce(nonce) {
  try {
    // 10 минут — вдвое больше окна подписи (±5 минут)
    return (await strictCmd(["SET", `nonce:${nonce}`, "1", "NX", "EX", "600"])) === "OK";
  } catch (e) {
    console.error("[store] nonce не проверен:", e.message);
    return false;
  }
}
export async function clearPause(chatId) {
  await cmd(["DEL", `pause:${chatId}`]);
}
export async function pausedUntil(chatId) {
  const v = Number(await cmd(["GET", `pause:${chatId}`]));
  return v > Date.now() ? v : 0;
}
/** "paused", "free" или "unknown" — Upstash не ответил (аудит 05.10:
 *  тогда бот молчит и только пересылает сотрудникам — лучше промолчать,
 *  чем перебить человека). */
export async function pauseState(chatId) {
  try {
    const v = Number(await strictCmd(["GET", `pause:${chatId}`]));
    return v > Date.now() ? "paused" : "free";
  } catch (e) {
    console.error("[store] пауза не прочитана:", e.message);
    return "unknown";
  }
}

// ---- Кто из команды (для пересылки в CRM) ----
// Переписку сотрудников с ботом в CRM не шлём — только клиентов. Состав —
// двумя пайплайнами (множества и назначения), помним минуту.
//
// Сбой Upstash — «не знаем» (аудит 05.10): переписку такого человека в CRM
// не пересылаем (лучше пропустить, чем переслать сотрудника как лида), а
// команды сотрудника не выполняем. Админ из TELEGRAM_ADMIN_CHAT_ID — всегда.
let teamCache = { at: 0, ids: new Set() };
export function forgetTeamCache() { teamCache = { at: 0, ids: new Set() }; }
async function readTeam() {
  const sets = ["team", "leadwatch", ...TEAM_ROLES.map((r) => `role:${r}`)];
  const base = ["support", "sales", "invest", "default"];
  const first = await pipeline([
    ...sets.map((k) => ["SMEMBERS", k]),
    ["SMEMBERS", "assign:keys"],
  ]);
  const ids = new Set();
  for (const members of first.slice(0, sets.length)) {
    for (const m of members || []) ids.add(String(m));
  }
  const roles = [...new Set([...base, ...((first[sets.length] || []).map(String))])];
  const agents = await pipeline(roles.map((r) => ["GET", `assign:${r}`]));
  for (const agent of agents) if (agent) ids.add(String(agent));
  for (const v of ["TELEGRAM_SALES_CHAT_ID", "TELEGRAM_SUPPORT_CHAT_ID", "TELEGRAM_INVEST_CHAT_ID"]) {
    if (process.env[v]) ids.add(String(process.env[v]));
  }
  return ids;
}
/** "staff" — из команды, "client" — нет, "unknown" — Upstash не ответил. */
export async function teamStatus(id) {
  const admin = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "");
  if (admin && String(id) === admin) return "staff";
  if (Date.now() - teamCache.at > 60 * 1000) {
    try {
      teamCache = { at: Date.now(), ids: await readTeam() };
    } catch (e) {
      console.error("[store] состав команды не прочитан:", e.message);
      return "unknown";
    }
  }
  return teamCache.ids.has(String(id)) ? "staff" : "client";
}
export async function isTeamMember(id) {
  return (await teamStatus(id)) === "staff";
}
