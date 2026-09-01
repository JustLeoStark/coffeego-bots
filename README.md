# CoffeeGo lead bot — Telegram + WhatsApp → Bitrix24

A single Node service that runs a scripted, English-language qualification chat on
**Telegram** and **WhatsApp (Meta Cloud API)**, and drops every qualified conversation
into **Bitrix24** as a lead. When a user asks for a person, it also pings an admin chat.

```
index.js     Express server: Telegram + WhatsApp webhooks
engine.js    Conversation script (the flow lives here — edit freely)
bitrix.js    crm.lead.add via inbound webhook
telegram.js  Telegram send + admin notify + setWebhook
whatsapp.js  WhatsApp Cloud API send + webhook verify + parse
```

## 1. Prerequisites

- Node.js 18+
- A hosting spot with a public HTTPS URL (Render, Railway, Fly.io — free tiers work).
  Webhooks need a public URL; you can't run this purely on your laptop for production.

## 2. Telegram bot (start here — fastest)

1. In Telegram, open **@BotFather** → `/newbot` → pick a name and username → copy the **token**.
2. (Optional) To get admin pings: add the bot to a group or DM it, then find the chat id
   (e.g. via `@userinfobot`) and set `TELEGRAM_ADMIN_CHAT_ID`.
3. Set `TELEGRAM_BOT_TOKEN` and `PUBLIC_URL` in `.env`.
   On boot the service auto-registers the webhook at `PUBLIC_URL/telegram/webhook`.

## 3. Bitrix24 lead hand-off

1. Bitrix24 → **Developer resources → Other → Inbound webhook**.
2. Grant the **crm** scope. Copy the webhook URL — it looks like:
   `https://YOURACCOUNT.bitrix24.com/rest/1/XXXXXXXXXXXX/`
3. Put it in `BITRIX_WEBHOOK_URL` (keep the trailing slash).
4. (Optional) `BITRIX_ASSIGNED_TO` = the Bitrix user id who should own new leads.

Until this is set, leads are only logged to the console and sent to the admin chat —
nothing breaks, so you can launch Telegram first and wire Bitrix in after.

## 4. WhatsApp (Meta Cloud API) — add when ready

1. Create a Meta app at developers.facebook.com → add the **WhatsApp** product.
2. Get a **phone number ID** and a **permanent access token**; set `WHATSAPP_TOKEN`
   and `WHATSAPP_PHONE_ID`.
3. Pick any string for `WHATSAPP_VERIFY_TOKEN` (you'll enter the same one in Meta).
4. In Meta → WhatsApp → Configuration → **Webhook**, set the callback URL to
   `PUBLIC_URL/whatsapp/webhook`, enter your verify token, and subscribe to **messages**.
5. Business verification is required before you can message users outside the 24-hour
   window / at scale — start it early, it takes a few days.

## 5. Run

```bash
cp .env.example .env      # fill in values
npm install
npm start
```

Local test without deploying: install `ngrok`, run `ngrok http 3000`, and use the
https URL it prints as `PUBLIC_URL`.

## 6. Deploy (Render example)

1. Push this folder to a Git repo (GitHub).
2. Render → New → **Web Service** → connect the repo.
3. Build command `npm install`, start command `npm start`.
4. Add the environment variables from `.env`. Set `PUBLIC_URL` to the Render URL
   (e.g. `https://coffeego-bot.onrender.com`) and redeploy so the Telegram webhook registers.

## 7. Editing the conversation

The whole script is in `src/engine.js` — plain English strings and a small step machine.
Change wording, add questions, or add branches there. `SCRIPT.md` describes the current flow.

## Notes

- Sessions are in-memory: a restart forgets in-progress chats (finished leads are already
  in Bitrix). For heavy volume, swap the `Map` in `index.js` for Redis.
- No secrets are committed — everything sensitive lives in `.env`.
