// CoffeeGo AI brain — Anthropic Claude Haiku.
// Understands any language, replies in the user's language, answers ONLY from the
// knowledge base + answers learned from staff, detects complaints, and decides
// when to ask for a photo / a human. It never invents facts.
import { getLearned } from "./store.js";
const KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";

// Baseline knowledge (refine freely — this string is the bot's brain).
const KB = `
COMPANY: CoffeeGo (Coffee Go Selling Products and Services by Automatic Vending Machines L.L.C), Dubai, UAE.
Website: https://coffee-go.ae · Phone/WhatsApp: +971 58 532 9288.
WHAT WE DO: We install and fully service self-service coffee machines across the UAE
(Dubai, Abu Dhabi, Sharjah and more) for offices and public spaces (buildings, malls, clinics, communities).
MODEL: The machine, installation and maintenance are free. The client pays only for what is consumed
(ingredients), typically from around AED 1,000/month depending on volume. No upfront cost.
MACHINES & DRINKS: Bean-to-cup machines (Jetinno, Necta) and Rocket Espresso; espresso, americano,
latte, cappuccino and more. Freshly roasted in Dubai.
PAYMENT AT MACHINE: Card and app payments supported.
REQUIREMENTS: About 1–2 m² of space, a power socket and (for some models) water.
COVERAGE: 120+ locations across the UAE. Typical response within 1 business day.
FOR DEVELOPERS/PROPERTY MANAGERS: A free coffee point adds comfort for residents, buyers and guests.
SUPPORT: For payment or machine issues, the team resolves them quickly and can arrange a refund
where appropriate. Escalation via WhatsApp/phone +971 58 532 9288.
`;

// Returns { reply, is_complaint, complaint_type, needs_photo, wants_contact }
export async function askAI(history, userText) {
  if (!KEY) {
    return {
      reply: "Our AI assistant isn't fully set up yet, but our team will help you. Please share your question and a contact number.",
      is_complaint: false, complaint_type: "", needs_photo: false, wants_contact: true,
    };
  }
  // Answers the team has given before — the bot learns from these.
  let learnedBlock = "";
  try {
    const learned = await getLearned(40);
    if (learned.length) {
      learnedBlock = "\n\nLEARNED ANSWERS (from our team — prefer these, they are authoritative):\n" +
        learned.map((p) => `Q: ${p.q}\nA: ${p.a}`).join("\n---\n");
    }
  } catch { /* store optional */ }

  const system =
    `You are CoffeeGo's AI support assistant — an automated bot (say so if asked; a human can join anytime). ` +
    `Detect the user's language from their message and ALWAYS reply in that same language. Be warm, concise and professional. ` +
    `CRITICAL: Answer ONLY using the KNOWLEDGE and LEARNED ANSWERS below. NEVER invent or guess prices, policies, numbers, timelines, availability or any fact that is not written there. ` +
    `If the answer is not covered, do NOT make anything up — say you'll connect a team member and set wants_contact true. ` +
    `If the user reports a COMPLAINT (e.g. paid but nothing poured, wrong drink poured, delivery/refill delay, machine broken), ` +
    `sincerely apologize and reassure them the team will resolve it. ` +
    `ONLY when the complaint is "paid but nothing poured" or "wrong drink poured", ask them to attach a photo of the result AND the payment receipt or screenshot. ` +
    `Keep replies short.\n\nKNOWLEDGE:\n${KB}${learnedBlock}\n\n` +
    `Respond ONLY as strict minified JSON with keys: reply (string, ready to send to the user, in their language), ` +
    `is_complaint (boolean), complaint_type (short string or ""), needs_photo (boolean), wants_contact (boolean). ` +
    `Set wants_contact true when it is a complaint, the user asks for a human, or the question is not covered by the knowledge/learned answers. No text outside the JSON.`;

  const messages = [...(history || []), { role: "user", content: userText }];
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, system, messages }),
    });
    const data = await res.json();
    if (data.error) {
      console.error("[ai] error:", data.error);
      return { reply: "Sorry, I had a hiccup. Could you rephrase, or shall I connect a person?", is_complaint: false, complaint_type: "", needs_photo: false, wants_contact: true };
    }
    const txt = (data.content && data.content[0] && data.content[0].text) || "";
    try {
      const parsed = JSON.parse(txt);
      return {
        reply: parsed.reply || "Could you rephrase that?",
        is_complaint: !!parsed.is_complaint,
        complaint_type: parsed.complaint_type || "",
        needs_photo: !!parsed.needs_photo,
        wants_contact: !!parsed.wants_contact,
      };
    } catch {
      return { reply: txt || "Could you rephrase that?", is_complaint: false, complaint_type: "", needs_photo: false, wants_contact: false };
    }
  } catch (e) {
    console.error("[ai] request failed:", e.message);
    return { reply: "Sorry, I'm having trouble right now. You can reach our team on WhatsApp +971 58 532 9288.", is_complaint: false, complaint_type: "", needs_photo: false, wants_contact: true };
  }
}
