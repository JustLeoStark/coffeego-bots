// Проверка, что заявку прислал Netlify (аудит 05.10.2026).
//
// Основной способ — подпись JWS: в Netlify у исходящего вебхука формы
// задаётся «JWS secret token», и каждый вызов несёт заголовок
// X-Webhook-Signature — JWT (HS256) с полями iss: "netlify" и sha256 —
// хэш тела запроса. Тот же токен — в NETLIFY_LEAD_SECRET у бота.
//
// Запасной способ — ?key=<NETLIFY_LEAD_SECRET> в адресе вебхука (старые
// настройки) — только при явном NETLIFY_ALLOW_KEY=1. Без
// NETLIFY_LEAD_SECRET или с секретом короче 32 знаков заявки не
// принимаются вовсе (ошибка в журнале).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const fromB64url = (part) => {
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); } catch { return null; }
};

/** Подпись JWS от Netlify сходится с телом запроса. */
export function jwsOk(token, rawBody, secret) {
  return jwsCheck(token, rawBody, secret) === "";
}

/** Почему подпись не принята ("" — принята). В журнал — только причина,
 *  без секрета и без тела. */
export function jwsCheck(token, rawBody, secret) {
  if (!token) return "нет заголовка X-Webhook-Signature (в Netlify не задан JWS secret token?)";
  if (!secret) return "нет секрета";
  if (!rawBody) return "пустое тело или не JSON";
  const parts = String(token).split(".");
  if (parts.length !== 3) return "заголовок подписи не JWT";
  const [head, body, signature] = parts;
  const header = fromB64url(head);
  if (!header || header.alg !== "HS256") return `алгоритм ${header && header.alg} вместо HS256`;
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  if (!same(expected, signature)) return "подпись JWT не сошлась — JWS secret token в Netlify и NETLIFY_LEAD_SECRET на Render разные";
  const claims = fromB64url(body);
  if (!claims || claims.iss !== "netlify" || typeof claims.sha256 !== "string") return "в подписи нет iss=netlify или sha256";
  const digest = createHash("sha256").update(rawBody).digest("hex");
  if (!same(digest, claims.sha256.toLowerCase())) return "хэш тела не сошёлся";
  return "";
}

export const MIN_SECRET = 32;

/** Почему приём заявок выключен; "" — всё в порядке. */
export function netlifyProblem() {
  const secret = process.env.NETLIFY_LEAD_SECRET || "";
  if (!secret) return "NETLIFY_LEAD_SECRET не задан";
  if (secret.length < MIN_SECRET) return `NETLIFY_LEAD_SECRET короче ${MIN_SECRET} знаков`;
  return "";
}

/** Вызов от Netlify: подпись JWS или (запасное, если разрешено
 *  NETLIFY_ALLOW_KEY=1) верный ?key=. */
export function netlifyOk(req) {
  const problem = netlifyProblem();
  if (problem) {
    console.error(`[netlify] приём заявок ВЫКЛЮЧЕН: ${problem}`);
    return false;
  }
  const secret = process.env.NETLIFY_LEAD_SECRET;
  const token = req.get("x-webhook-signature");
  if (token) {
    const why = jwsCheck(token, req.rawBody, secret);
    if (why) console.warn(`[netlify] подпись не принята: ${why}; content-type=${req.get("content-type")}`);
    return !why;
  }
  console.warn("[netlify] подпись не принята: нет заголовка X-Webhook-Signature (в Netlify не задан JWS secret token?)");
  if (process.env.NETLIFY_ALLOW_KEY !== "1") return false;
  const key = typeof req.query.key === "string" ? req.query.key : "";
  return Boolean(key) && same(key, secret);
}
