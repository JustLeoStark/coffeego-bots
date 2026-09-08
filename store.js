// Persistent store for staff, assignments and live-handoff state.
// Uses Upstash Redis (REST) when configured, else an in-memory fallback
// (fine for testing; resets on restart).
const URL = process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const mem = new Map(); // key -> value (string) ; sets stored as Set

async function cmd(args) {
  if (!URL || !TOKEN) return memCmd(args);
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const json = await res.json();
    return json.result;
  } catch (e) {
    console.error("[store] redis error, using memory:", e.message);
    return memCmd(args);
  }
}

function memCmd([op, key, a, b]) {
  op = op.toUpperCase();
  if (op === "SET") { mem.set(key, String(a)); return "OK"; }
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

// ---- Assignments (role -> agent chat id) ----
// Роль может быть с регионом: "support@ru", "sales@uae". Без региона —
// общая роль на всю сеть, она же запасной вариант.
export async function setAssignment(role, agentId) {
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
