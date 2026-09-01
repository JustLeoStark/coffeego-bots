// CoffeeGo lead bot — conversation engine (channel-agnostic, English).
// Pure logic: given a session and an incoming text, returns reply messages,
// an optional `lead` object to push to Bitrix24, and whether to notify a human.

const CONTACT_PHONE = "+971 58 532 9288";
const WHATSAPP_LINK = "https://wa.me/971585329288";
const SITE = "https://coffee-go.ae";

const MAIN_MENU = [
  { id: "1", label: "☕ Coffee for my office" },
  { id: "2", label: "🏢 Coffee point for my building / property" },
  { id: "3", label: "📈 Investing / partnership" },
  { id: "4", label: "💬 Talk to a person" },
  { id: "5", label: "🛠 Report a problem / ask a question" },
];

function welcome() {
  return {
    text:
      "Hi! I'm the CoffeeGo AI assistant 🤖 (an automated bot — a real person can join anytime).\n\n" +
      "We install and fully service self-service coffee machines across the UAE — " +
      "free machine, free install, free maintenance. You only pay for what's consumed.\n\n" +
      "What can I help you with? Reply with a number:\n" +
      MAIN_MENU.map((o) => `${o.id}. ${o.label}`).join("\n"),
    buttons: MAIN_MENU,
  };
}

function normalize(text) {
  return (text || "").trim().toLowerCase();
}

// Returns { replies:[{text,buttons?}], lead?, notifyHuman?, reset? }
// deps.askAI(history, userText) -> { reply, is_complaint, complaint_type, needs_photo, wants_contact }
export async function handleMessage(session, rawText, deps = {}) {
  const text = (rawText || "").trim();
  const t = normalize(text);
  session.data = session.data || {};

  // Global commands
  if (["/start", "start", "menu", "/menu", "hi", "hello", "restart"].includes(t)) {
    session.step = "menu";
    session.data = {};
    return { replies: [welcome()] };
  }
  if (["human", "agent", "person", "operator", "manager", "call me"].includes(t)) {
    session.step = "ask_name";
    session.data = { category: "Human hand-off", wantsHuman: true };
    return { replies: [{ text: "Sure — I'll connect you with our team. What's your name?" }] };
  }

  const step = session.step || "menu";

  switch (step) {
    case "menu": {
      if (t === "1" || t.includes("office")) {
        session.step = "office_location";
        session.data = { category: "Office coffee" };
        return { replies: [{ text: "Great choice. Which emirate / area is your office in? (e.g. Dubai, Business Bay)" }] };
      }
      if (t === "2" || t.includes("building") || t.includes("property") || t.includes("point")) {
        session.step = "building_type";
        session.data = { category: "Developer / building" };
        return {
          replies: [{
            text:
              "Perfect — a coffee point adds comfort for residents, buyers and guests, at no cost to you.\n\n" +
              "What type of space is it?\n1. Residential building / community\n2. Mall / retail\n3. Clinic / office building\n4. Other",
          }],
        };
      }
      if (t === "3" || t.includes("invest") || t.includes("partner")) {
        session.step = "ask_name";
        session.data = { category: "Investing / partnership" };
        return {
          replies: [{
            text:
              `We offer investment and partnership models around our UAE machine network. Details: ${SITE}/investing.html\n\n` +
              "Let's get you the investor pack. What's your name?",
          }],
        };
      }
      if (t === "4" || t.includes("talk") || t.includes("person")) {
        session.step = "ask_name";
        session.data = { category: "Human hand-off", wantsHuman: true };
        return { replies: [{ text: "Of course — a real person from our team will help you. What's your name?" }] };
      }
      if (t === "5" || t.includes("problem") || t.includes("question") || t.includes("complain") || t.includes("report") || t.includes("issue")) {
        session.step = "ai_chat";
        session.data = { category: "Question / support" };
        session.aiHistory = [];
        return {
          replies: [{
            text:
              "I'm the CoffeeGo AI assistant 🤖 — please describe your question or problem. " +
              "Thanks for reaching out, we're always here to help.",
          }],
        };
      }
      return { replies: [{ text: "Please reply with 1, 2, 3, 4 or 5:", buttons: MAIN_MENU }] };
    }

    case "ai_chat": {
      session.aiHistory = session.aiHistory || [];
      const ai = deps.askAI
        ? await deps.askAI(session.aiHistory, text)
        : { reply: "Our team will help you shortly.", is_complaint: false, complaint_type: "", needs_photo: false, wants_contact: true };
      session.aiHistory.push({ role: "user", content: text });
      session.aiHistory.push({ role: "assistant", content: ai.reply });
      if (session.aiHistory.length > 20) session.aiHistory = session.aiHistory.slice(-20);

      if (ai.is_complaint) {
        session.data.category = "Support / complaint";
        session.data.wantsHuman = true;
        if (!session.data.issue) session.data.issue = text;
      }
      if (ai.needs_photo) session.data.needPhoto = true;

      // 1) If a photo was requested but not yet received, keep waiting for it.
      if (session.data.needPhoto && !session.data.photoNote) {
        return { replies: [{ text: ai.reply }] };
      }
      // 2) Once it's a complaint or the user wants a human, collect contact to file a ticket.
      if (ai.wants_contact && !session.data.askedContact) {
        session.data.askedContact = true;
        session.step = "ask_name";
        return { replies: [{ text: `${ai.reply}\n\nCould I take your name so our team can follow up?` }] };
      }
      // 3) Otherwise just keep answering.
      return { replies: [{ text: ai.reply }] };
    }

    case "office_location": {
      session.data.location = text;
      session.step = "office_size";
      return { replies: [{ text: "How many people are in the office roughly? (e.g. 15, 40, 100+)" }] };
    }
    case "office_size": {
      session.data.teamSize = text;
      session.step = "ask_name";
      return { replies: [{ text: "Got it. What's your name?" }] };
    }

    case "building_type": {
      const map = { "1": "Residential / community", "2": "Mall / retail", "3": "Clinic / office building", "4": "Other" };
      session.data.spaceType = map[t] || text;
      session.step = "building_location";
      return { replies: [{ text: "Which emirate / area is it in? (e.g. Dubai, Jumeirah)" }] };
    }
    case "building_location": {
      session.data.location = text;
      session.step = "ask_name";
      return { replies: [{ text: "Thanks. What's your name?" }] };
    }

    case "ask_name": {
      if (text.length < 2) return { replies: [{ text: "Please share your name so we can address you properly." }] };
      session.data.name = text;
      session.step = "ask_phone";
      return { replies: [{ text: `Thanks, ${text}! What's the best phone number (WhatsApp preferred) to reach you?` }] };
    }
    case "ask_phone": {
      const digits = text.replace(/[^\d]/g, "");
      if (digits.length < 7) {
        return { replies: [{ text: "That doesn't look like a full number — please send a phone we can call or WhatsApp." }] };
      }
      session.data.phone = text;
      session.step = "done";
      const d = session.data;
      const isSupport = d.category === "Support / complaint";
      const summaryLines = [
        `New CoffeeGo ${isSupport ? "SUPPORT / COMPLAINT" : "lead"} — ${d.category}`,
        d.name ? `Name: ${d.name}` : null,
        d.phone ? `Phone: ${d.phone}` : null,
        d.issue ? `Issue: ${d.issue}` : null,
        d.photoNote ? d.photoNote : null,
        d.location ? `Location: ${d.location}` : null,
        d.teamSize ? `Team size: ${d.teamSize}` : null,
        d.spaceType ? `Space: ${d.spaceType}` : null,
        d.wantsHuman ? `Wants a human call back` : null,
      ].filter(Boolean);

      const lead = {
        title: `CoffeeGo bot — ${d.category}`,
        name: d.name,
        phone: d.phone,
        comments: summaryLines.join("\n"),
        category: d.category,
        wantsHuman: !!d.wantsHuman,
      };

      const closing = isSupport
        ? `Thank you — your report has been sent to our team and they'll get back to you as soon as possible. For anything urgent, reach us now on WhatsApp:\n💬 ${WHATSAPP_LINK}\n📞 ${CONTACT_PHONE}`
        : d.wantsHuman
        ? `A real person from our team will reach out shortly. Want to talk right now? Message us on WhatsApp:\n💬 ${WHATSAPP_LINK}\n📞 ${CONTACT_PHONE}`
        : `All set! Our team will send you a tailored quote within one business day. You can also reach us directly:\n📞 ${CONTACT_PHONE}\n💬 ${WHATSAPP_LINK}`;

      return {
        replies: [{
          text:
            `${closing}\n🌐 ${SITE}\n\n` +
            `Type "menu" anytime to start over.`,
        }],
        lead,
        notifyHuman: true,
      };
    }

    case "done":
    default: {
      session.step = "menu";
      session.data = {};
      return { replies: [welcome()] };
    }
  }
}
