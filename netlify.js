// Проверка, что заявку прислал Netlify (аудит 05.10.2026).
//
// Основной способ — подпись JWS: в Netlify у исходящего вебхука формы
// задаётся «JWS secret token», и каждый вызов несёт заголовок
// X-Webhook-Signature — JWT (HS256) с полями iss: "netlify" и sha256 —
// хэш тела запроса. Тот же токен — в NETLIFY_LEAD_SECRET у бота.
//
// Запасной способ — ?key=<NETLIFY_LEAD_SECRET> в адресе вебхука (старые
// настройки). Без NETLIFY_LEAD_SECRET заявки не принимаются вовсе.
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
  if (!token || !secret || !rawBody) return false;
  const parts = String(token).split(".");
  if (parts.length !== 3) return false;
  const [head, body, signature] = parts;
  const header = fromB64url(head);
  if (!header || header.alg !== "HS256") return false;
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  if (!same(expected, signature)) return false;
  const claims = fromB64url(body);
  if (!claims || claims.iss !== "netlify" || typeof claims.sha256 !== "string") return false;
  const digest = createHash("sha256").update(rawBody).digest("hex");
  return same(digest, claims.sha256.toLowerCase());
}

/** Вызов от Netlify: подпись JWS или (запасное) верный ?key=. */
export function netlifyOk(req) {
  const secret = process.env.NETLIFY_LEAD_SECRET || "";
  if (!secret) return false;
  const token = req.get("x-webhook-signature");
  if (token) return jwsOk(token, req.rawBody, secret);
  const key = typeof req.query.key === "string" ? req.query.key : "";
  return Boolean(key) && same(key, secret);
}
