// CoffeeGo lead bot — conversation engine (channel-agnostic, English).
// Pure logic: given a session and an incoming text, returns reply messages,
// an optional `lead` object to push to Bitrix24, and whether to notify a human.

const CONTACT_PHONE = "+971 58 532 9288";
const SITE = "https://coffee-go.ae";

const MAIN_MENU = [
  { id: "1", label: "☕ Coffee for my office" },
  { id: "2", label: "🏢 Coffee point for my building / property" },
  { id: "3", label: "📈 Investing / partnership" },
  { id: "4", label: "💬 Talk to a person" },
];

function welcome() {
  return {
    text:
      "Hi! I'm the CoffeeGo assistant ☕\n\n" +
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
export function handleMessage(session, rawText) {
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
      if (t === "4") {
        session.step = "ask_name";
        session.data = { category: "Human hand-off", wantsHuman: true };
        return { replies: [{ text: "Of course — I'll connect you with our team. What's your name?" }] };
      }
      return { replies: [{ text: "Please reply with 1, 2, 3 or 4:", buttons: MAIN_MENU }] };
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
      const summaryLines = [
        `New CoffeeGo lead — ${d.category}`,
        d.name ? `Name: ${d.name}` : null,
        d.phone ? `Phone: ${d.phone}` : null,
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

      const closing = d.wantsHuman
        ? "Perfect — our team will reach out shortly. Meanwhile, feel free to call us directly:"
        : "All set! Our team will send you a tailored quote within one business day. You can also reach us directly:";

      return {
        replies: [{
          text:
            `${closing}\n📞 ${CONTACT_PHONE}\n🌐 ${SITE}\n\n` +
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
