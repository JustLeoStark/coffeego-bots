// WhatsApp Cloud API (Meta) helpers.
// Requires a Meta app with WhatsApp product, a phone number ID, and a permanent token.
//   WHATSAPP_TOKEN         — permanent access token
//   WHATSAPP_PHONE_ID      — phone number ID
//   WHATSAPP_VERIFY_TOKEN  — arbitrary string you also enter in Meta webhook config
const TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const GRAPH = "https://graph.facebook.com/v20.0";

export async function sendWhatsApp(to, text) {
  if (!TOKEN || !PHONE_ID) {
    console.log("[whatsapp] not configured — would send to", to, ":", text.slice(0, 60));
    return;
  }
  const res = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { preview_url: false, body: text },
    }),
  });
  if (!res.ok) console.error("[whatsapp] send failed:", res.status, await res.text());
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

// Extract {from, text} messages from an incoming Meta webhook payload.
export function parseWhatsAppMessages(body) {
  const out = [];
  const entries = body.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const msgs = change.value?.messages || [];
      for (const m of msgs) {
        if (m.type === "text") out.push({ from: m.from, text: m.text?.body || "" });
        else if (m.type === "interactive") {
          const r = m.interactive?.button_reply || m.interactive?.list_reply;
          out.push({ from: m.from, text: r?.title || r?.id || "" });
        }
      }
    }
  }
  return out;
}
