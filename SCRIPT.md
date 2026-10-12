# CoffeeGo bot — conversation script (English)

This is the flow implemented in `src/engine.js`. Edit wording there; this doc mirrors it
for review. Users can type `menu` anytime to restart, or `human` to jump straight to a person.

**When the CRM runs intake** (owner, 12.10.2026: the "Intake scenario" checkbox on the
CRM `/assistant` page): in Telegram this whole script — the menu, the AI answers and the
`/start` welcome — is off for clients, new and ongoing chats alike. Kofik in the CRM
answers instead; the bot only forwards every client message (with files) to the CRM and
sends the team no "new lead" from its own script. Unchecking the box brings this script
back. WhatsApp is not affected.

## Welcome (on /start, hi, menu)

> Hi! I'm the CoffeeGo assistant ☕
> We install and fully service self-service coffee machines across the UAE — free machine,
> free install, free maintenance. You only pay for what's consumed.
> What can I help you with? Reply with a number:
> 1. ☕ Coffee for my office
> 2. 🏢 Coffee point for my building / property
> 3. 📈 Investing / partnership
> 4. 💬 Talk to a person

## Branch 1 — Office coffee

1. Which emirate / area is your office in?
2. How many people are in the office roughly?
3. What's your name?
4. Best phone (WhatsApp preferred)?
→ Lead created: **Office coffee** + location + team size + name + phone.
→ "Our team will send you a tailored quote within one business day."

## Branch 2 — Building / property (developers & management companies)

Framing: *a coffee point adds comfort for residents, buyers and guests, at no cost to you.*

1. Type of space? (Residential / Mall / Clinic-office / Other)
2. Which emirate / area?
3. Name?
4. Phone?
→ Lead created: **Developer / building** + space type + location + name + phone.

## Branch 3 — Investing / partnership

Sends investor-pack link (coffee-go.ae/investing.html), then:
1. Name?
2. Phone?
→ Lead created: **Investing / partnership**.

## Branch 4 / "human" — Talk to a person

1. Name?
2. Phone?
→ Lead created flagged **Wants a human call back**; admin chat pinged immediately.

## Every completed branch

- The lead reaches CoffeeGo CRM from the forwarded conversation. Bitrix24
  (`crm.lead.add`) is off since 12.10.2026 — only with `BITRIX_LEADS=1`.
- Sends the user CoffeeGo's direct contact (+971 58 532 9288, coffee-go.ae).
- Pings the Telegram admin chat (if configured) so a human sees it in real time.

## Validation built in

- Name must be ≥2 chars.
- Phone must contain ≥7 digits, else the bot re-asks.
- In Telegram the phone is asked with a "📱 Share my phone number" button
  (`request_contact`). Only the sender's own shared contact counts as verified;
  a typed number still works but goes to the CRM as unverified.
- After a person answers the client (from the CRM card or via `/reply`) the
  script and the AI stay silent in that chat for 24 hours (or until "Bring the
  bot back" in the CRM / `/close <id>`); client messages go to the CRM and the
  team chat.
- Photos, documents, voice notes, videos and audio from the client reach the
  CRM as files (`media` with the Telegram `file_id`; the CRM downloads them),
  with the caption as the text.
- Internal contacts in the CRM (staff, own people, partners, spam): the bot
  does not answer them at all and does not ping the team; their messages still
  go to the CRM. Lifted only when the CRM returns the contact to leads / "Bring
  the bot back".
- Unrecognised menu input re-shows the 4 options.

## Ideas to extend later

- Arabic version (add a language switch at the welcome step).
- Interactive buttons on WhatsApp (list message) instead of numbered replies.
- Persist sessions in Redis; add a follow-up nudge if a chat is abandoned mid-flow.
