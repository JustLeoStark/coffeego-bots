// WhatsApp Cloud API (Meta) helpers.
// Requires a Meta app with WhatsApp product, a phone number ID, and a permanent token.
//   WHATSAPP_TOKEN         — permanent access token
//   WHATSAPP_PHONE_ID      — phone number ID
//   WHATSAPP_VERIFY_TOKEN  — arbitrary string you also enter in Meta webhook config
//   WHATSAPP_APP_SECRET    — Meta app secret; enables signature checks (recommended)
import crypto from "crypto";

const TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";
const GRAPH = "https://graph.facebook.com/v20.0";

export function whatsappConfigured() {
  return Boolean(TOKEN && PHONE_ID);
}

export async function sendWhatsApp(to, text) {
  if (!whatsappConfigured()) {
    console.log("[whatsapp] not configured — would send to", to, ":", text.slice(0, 60));
    return;
  }
  // WhatsApp caps a text body at 4096 chars; split instead of losing the tail.
  const chunks = [];
  let rest = String(text || "");
  while (rest.length > 4000) {
    let cut = rest.lastIndexOf("\n", 4000);
    if (cut < 2000) cut = 4000;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);

  for (const body of chunks) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "text",
            text: { preview_url: false, body },
          }),
        });
        if (res.ok) break;
        const detail = await res.text();
        // 4xx кроме 429 повторять бессмысленно — это наша ошибка, а не сети
        if (res.status !== 429 && res.status < 500) {
          console.error("[whatsapp] send rejected:", res.status, detail.slice(0, 300));
          break;
        }
        console.warn("[whatsapp] send retry", attempt + 1, res.status);
      } catch (e) {
        console.warn("[whatsapp] send error, retry", attempt + 1, e.message);
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

// Webhook verification handshake (GET). Returns the challenge string or null.
export function verifyWhatsAppWebhook(query) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode === "subscribe" && token === (process.env.WHATSAPP_VERIFY_TOKEN || "")) {
    return challenge;
  }
  return null;
}

// Meta signs every webhook with the app secret. Without this check anyone who
// learns the URL can feed the bot fake messages.
export function verifySignature(rawBody, header) {
  if (!APP_SECRET) return true;          // не настроено — не блокируем работу
  if (!header || !rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET)
    .update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Meta повторяет доставку, пока не получит 200 — а на спящем хостинге первый
// ответ легко опаздывает. Без защиты клиент получит один ответ несколько раз.
const seen = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;

function alreadyHandled(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

// Extract {from, text} messages from an incoming Meta webhook payload.
export function parseWhatsAppMessages(body) {
  const out = [];
  const entries = body.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const profiles = {};
      for (const c of value.contacts || []) {
        if (c.wa_id) profiles[c.wa_id] = c.profile?.name || "";
      }
      for (const m of value.messages || []) {
        if (alreadyHandled(m.id)) continue;
        const name = profiles[m.from] || "";
        if (m.type === "text") {
          out.push({ from: m.from, text: m.text?.body || "", name });
        } else if (m.type === "interactive") {
          const r = m.interactive?.button_reply || m.interactive?.list_reply;
          out.push({ from: m.from, text: r?.title || r?.id || "", name });
        } else if (m.type === "button") {
          out.push({ from: m.from, text: m.button?.text || "", name });
        } else if (["image", "document", "audio", "video"].includes(m.type)) {
          // Вложения движок пока не разбирает, но клиенту нельзя молчать:
          // жалобы «не налил» приходят именно фотографией.
          const caption = m[m.type]?.caption || "";
          out.push({ from: m.from, text: caption || `[${m.type}]`, name, media: m.type });
        }
      }
    }
  }
  return out;
}

// Статусы доставки: полезны для диагностики, ответа не требуют.
export function parseWhatsAppStatuses(body) {
  const out = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      for (const s of change.value?.statuses || []) {
        out.push({ id: s.id, status: s.status, to: s.recipient_id,
                   error: s.errors?.[0]?.title });
      }
    }
  }
  return out;
}
