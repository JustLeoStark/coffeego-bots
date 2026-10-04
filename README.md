# CoffeeGo lead bot — Telegram + WhatsApp → Bitrix24

A single Node service that runs a scripted, English-language qualification chat on
**Telegram** and **WhatsApp (Meta Cloud API)**, and drops every qualified conversation
into **Bitrix24** as a lead. When a user asks for a person, it also pings an admin chat.

```
index.js     Express server: Telegram + WhatsApp webhooks
engine.js    Conversation script (the flow lives here — edit freely)
bitrix.js    crm.lead.add via inbound webhook (BITRIX_ENABLED=0 — off)
crm.js       Telegram conversation → CoffeeGo CRM (signed, retried)
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

## 7. Команда бота: приглашения и роли

Клиенты входят по обычной ссылке на бота — в диалог с помощником.
Сотрудники — по одноразовой ссылке-приглашению (48 часов): админ берёт
её командой `/invite` или кнопкой «➕ Пригласить» в `/team`.

`/team` (только у админа) — меню команды: список, у каждого кнопки ролей
«📬 Заявки с сайта» (копия заявок, сколько угодно человек), «💼 Продажи»,
«🛠 Поддержка», «💰 Инвестиции» (один ответственный на роль — назначение
заменяет прежнего), «❌ Убрать из команды». Ссылка `?start=team` — заявка
с одобрением кнопкой, для тех, кому дали ссылку без приглашения.

Хранение — Upstash Redis (`UPSTASH_REDIS_REST_URL/TOKEN`); без него
команда и роли живут до перезапуска. Меню «/» бот прописывает сам при
старте: клиентам — /start, /menu; админу — команды управления.

## 8. CoffeeGo CRM — переписка в карточках

С `CRM_URL` и `CRM_INGEST_SECRET` бот пересылает в CRM каждое сообщение
лички с клиентом и каждый свой ответ ему (`crm.js`): `POST
CRM_URL/integrations/telegram/ingest`. В CRM переписка появляется в карточке
лида или клиента одной лентой с WhatsApp; новый собеседник становится лидом
(источник «Telegram»), телефон из квалификации привязывает разговор к
клиенту или к лиду с этим номером.

- Подпись: `X-Timestamp` (секунды) и `X-Signature: sha256=<hex>`, где hex —
  HMAC-SHA256 общим секретом от строки `<X-Timestamp>.<тело>`. CRM отвергает
  неверную подпись и вызовы старше 5 минут (401).
- Тело: `{"bot": "<имя бота>", "messages": [{chat_id, message_id, direction:
  "in"|"out", date, text, author: "scenario"|"ai"|"human", user: {id,
  username, name}, fields: {name, company, phone, location, category, …},
  qualified}]}`. Повтор безопасен: CRM узнаёт записанное по (chat_id,
  message_id, direction).
- Не тормозит бота: отправка не ждётся, таймаут `CRM_TIMEOUT_MS`; ошибка — в
  лог и в очередь повторов (Upstash, ключ `crm:retry`, до 500 сообщений),
  повтор раз в минуту.
- Не пересылаются: группы, админ, команда и все, у кого есть роль или
  назначение (`/team`, `/assign`), WhatsApp-переписка бота.
- `BITRIX_ENABLED=0` выключает Bitrix24: лиды из чата заводит CRM. По
  умолчанию Bitrix работает как раньше. Заявки с сайта (Netlify) в CRM
  этим каналом не идут — их пока принимает только Bitrix.
- Ответ менеджера из CRM уходит клиенту через Bot API тем же токеном — в
  этот сервис он не попадает, и сотрудники в Telegram его не видят.
- `GET /version` показывает `crm` и `bitrix` — включены ли (без адресов).
- Проверки: `npm test` (без сети: CRM — локальный сервер в тесте).

## 9. Editing the conversation

The whole script is in `src/engine.js` — plain English strings and a small step machine.
Change wording, add questions, or add branches there. `SCRIPT.md` describes the current flow.

## Notes

- Sessions are in-memory: a restart forgets in-progress chats (finished leads are already
  in Bitrix). For heavy volume, swap the `Map` in `index.js` for Redis.
- No secrets are committed — everything sensitive lives in `.env`.


## Website leads (Netlify Forms → Telegram → Bitrix)

Netlify → Project configuration → Notifications → Form submission notifications → **Add notification → Outgoing webhook**:
event `New form submission`, URL `PUBLIC_URL/netlify/lead?key=<NETLIFY_LEAD_SECRET>` (key optional).
The bot forwards every website form to the sales responsible (`/assign sales <id>`), copies the admin, and creates a Bitrix lead when the webhook is configured.
