# CoffeeGo lead bot — Telegram + WhatsApp → CoffeeGo CRM

A single Node service that runs a scripted, English-language qualification chat on
**Telegram** and **WhatsApp (Meta Cloud API)**, and drops every qualified conversation
into **CoffeeGo CRM** as a lead. When a user asks for a person, it also pings an admin chat.

```
index.js     Express server: Telegram + WhatsApp webhooks
engine.js    Conversation script (the flow lives here — edit freely)
crm.js       Telegram conversation + website leads → CoffeeGo CRM (signed, retried)
netlify.js   Netlify webhook check (JWS X-Webhook-Signature, fallback ?key=)
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
3. Set `TELEGRAM_BOT_TOKEN`, `PUBLIC_URL` and `TELEGRAM_WEBHOOK_SECRET` in `.env`.
   On boot the service auto-registers the webhook at `PUBLIC_URL/telegram/webhook`
   with that secret.

   **Секрет вебхука обязателен.** Telegram кладёт его в заголовок
   `X-Telegram-Bot-Api-Secret-Token` каждого вызова; без него или с чужим бот
   отвечает 401 и ничего не делает. Без секрета (или короче 16 знаков, только
   `A-Z a-z 0-9 _ -`) бот при старте **снимает вебхук** и в Telegram не
   отвечает — в журнале Render ошибка «вебхук ОТКЛЮЧЁН». Задать:
   `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`, вписать в
   `TELEGRAM_WEBHOOK_SECRET` и перезапустить — бот сам переподпишет вебхук.

## 3. Лиды — только CoffeeGo CRM

Bitrix24 больше не используется и не рассматривается (владелец 12.10.2026):
модуль `bitrix.js` удалён, лиды сценария и заявки с сайта ведёт CoffeeGo CRM
(`crm.js`). Переменные `BITRIX_*` на Render можно удалить.

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

## 8. CoffeeGo CRM — переписка, заявки с сайта, «бот молчит»

С `CRM_URL` и `CRM_INGEST_SECRET` бот пересылает в CoffeeGo CRM (`crm.js`):

- каждое сообщение лички с клиентом и каждый свой ответ ему —
  `POST CRM_URL/integrations/telegram/ingest`. В CRM переписка ложится в
  карточку лида или клиента одной лентой с WhatsApp; новый собеседник
  становится лидом «Telegram»;
- каждую заявку с сайта (Netlify, кроме подписки на новости) —
  `POST CRM_URL/integrations/web-lead`: лид «Сайт». В Bitrix — только при
  `BITRIX_LEADS=1`.

Подпись: `X-Timestamp` (секунды) и `X-Signature: sha256=<hex>`, hex —
HMAC-SHA256 секретом `CRM_INGEST_SECRET` от строки
`<назначение>.<X-Timestamp>.<тело>`, назначение — `ingest`, `web-lead` или
`handoff` (подпись одного вызова не годится для другого адреса). Вызовы
старше 5 минут отвергаются (401). У `handoff` ещё одноразовый `nonce` в теле:
бот запоминает его в Upstash на 10 минут (`SET NX EX 600`), повтор — 401.

Пересылка включается, только если `CRM_URL` — `https://` (http — лишь для
localhost в проверках) и `CRM_INGEST_SECRET` не короче 32 знаков. Иначе при
старте в журнале «пересылка в CRM ВЫКЛЮЧЕНА: …», бот работает без неё и
`/crm/handoff` не принимает.

Тело переписки: `{"bot", "messages": [{chat_id, message_id, direction:
"in"|"out", date, text, author: "scenario"|"ai"|"human", user: {id, username,
name}, fields: {name, company, phone, phone_verified, location, category, …},
qualified, media}]}`. CRM отвечает по каждой записи (`results`) и узнаёт повтор по
(chat_id, message_id, direction). Заявка: `{"bot", "lead": {form, option, name,
company, phone, email, people, message, page, submission_id}}`.

**Фото и файлы** (11.10.2026). Фото, документ, голосовое, видео, кружок,
аудио, GIF и стикер клиента уходят в CRM полем `media: {file_id, type:
"photo"|"document"|"voice"|"video"|"audio"|"animation"|"sticker", file_name?,
mime_type?, file_size?}` (у фото — самый большой размер; кружок — `video`),
`text` — подпись или пусто. Сам файл бот не качает: CRM берёт его через Bot
API по `file_id` (`chat_media.py` в CRM, нужен `COFFEEGO_BOT_TOKEN` там). Фото,
которое сотрудник отправил клиенту через бота, уходит так же (`direction:
"out"`). Старая CRM без поддержки файлов поле `media` просто не читает.

**Телефон.** Бот просит номер кнопкой «📱 Share my phone number»
(`request_contact`). Номер подтверждён (`phone_verified: true`), только если
Telegram прислал контакт самого пишущего (`contact.user_id === from.id`).
Набранный текстом или чужой контакт — `phone_verified: false`: CRM не
привяжет по нему разговор к клиенту или чужому лиду.

**Очередь повторов.** Отправка не ждётся, таймаут `CRM_TIMEOUT_MS`. Не ушло —
в Upstash `crm:retry` (до 500), повтор раз в минуту: голова очереди пачкой,
снимается `LPOP` только после ответа CRM; пачка не принята — по одной.
Запись, которую CRM отвергла (4xx, `error` по записи) 5 раз, или на которой
CRM не ответила (сеть, 5xx, 429) 60 раз, уходит в `crm:dead` (до 500) —
смотреть в Upstash руками (переполнен — каждая потерянная запись в журнале).
Запись, на которой CRM не ответила, уходит в хвост очереди и не держит
остальные. 401/403 от CRM считаются временными (секреты меняют по очереди).
Очередь работает только с Upstash: сбой — проход прерывается до следующей
минуты, память не подменяет Redis. Проход берёт замок `crm:flush-lock`
(`SET NX PX 55000`): во время выкладки на Render два экземпляра не разбирают
очередь одновременно.

**Бот молчит, когда отвечает человек** (владелец 05.10.2026). Менеджер
ответил клиенту из карточки CRM — CRM зовёт `POST /crm/handoff` (та же
подпись) `{"chat_id", "action": "pause", "until"}`; сотрудник ответил через
бота (`/reply`, ответ на `[#id]`, фото) — бот ставит паузу сам. В паузе
сценарий и ИИ в этом чате не отвечают (и `/start` тоже): сообщения клиента
уходят в CRM и командному чату с пометкой «отвечает человек, бот молчит».
Пауза — сутки с последнего ответа человека (не больше недели), снимается
кнопкой «Вернуть бота» в CRM (`"action": "release"`) или `/close <id>`.

**Тишина для внутренних контактов** (владелец 11.10.2026). Сотрудник, свой,
партнёр или спам в «CRM → Внутренние контакты»: CRM зовёт тот же
`/crm/handoff` с `"action": "pause"` и `until` на годы вперёд. `until` дальше
30 дней бот понимает как тишину: ключ Upstash `silence:<chat>` без срока. В
тишине бот не отвечает ни сценарием, ни ИИ, ни на `/start`, и команде
уведомлений не шлёт — сообщения (с файлами) по-прежнему уходят в CRM, где
копится переписка контакта. Сутки паузы после ответа менеджера тишину не
снимают. Снимает только `"action": "release"` (контакт вернули в лиды или
«Вернуть бота»). Пересылку в CRM выключили — тишина не действует, бот
отвечает как без CRM.

**Приём ведёт CRM** (владелец 12.10.2026). Галочка «Сценарий для входящих»
на странице CRM `/assistant` — новые обращения в Telegram ведёт «Кофик» из
CRM. CRM сообщает это боту тем же подписанным `POST /crm/handoff` (с
`nonce`): `{"action": "intake", "enabled": true|false, "nonce"}` — без
`chat_id`, флаг на весь бот: ключ Upstash `crm:intake` без срока (снят —
ключа нет). Сохранили галочку — вызов сразу; кроме того, CRM повторяет
текущее значение каждый час (проход `run_rules`), чтобы бот не разошёлся с
CRM после сбоя. Ответ `200 {"ok": true, "intake": <bool>}`; Upstash не
записал — `503` (CRM покажет «бот Telegram не получил настройку»);
`enabled` не true/false — `400`.

Пока флаг стоит, в личке клиента бот не отвечает ни сценарием (меню),
ни ИИ, ни на `/start`, и команде не шлёт «новый лид» из своего сценария —
новые и уже начатые разговоры. Все сообщения клиента (с файлами) уходят в
CRM как обычно. Как раньше: пауза после ответа человека (молчит, команде
пометка «отвечает человек»), тишина внутренних контактов, старая живая
переписка через бота (`[#id]`) — её сообщения идут сотруднику, `/start` в
ней только закрывает её. Сотрудникам и админу бот отвечает как раньше;
WhatsApp флаг не трогает. Пересылку в CRM выключили — флаг не действует.
Флаг не читается (Upstash сбоит) — бот клиенту не отвечает (лучше
промолчать, чем ответить вторым голосом), но пересылает. Снимают галочку —
`"enabled": false`, бот снова работает своим сценарием. `GET /version` —
поле `crm_intake` (`null` — Upstash не ответил).

Не пересылаются: группы, админ, команда и все, у кого есть роль или
назначение (`/team`, `/assign`; состав читается пайплайном Upstash и
помнится минуту), WhatsApp-переписка бота.

**Upstash не отвечает** — бот не знает, кто сотрудник и стоит ли пауза:
переписку в CRM не шлёт (лучше пропустить, чем переслать сотрудника как
лида), команды сотрудника (`/reply`, `/close`, ответ на `[#id]`) не выполняет,
сценарием клиенту не отвечает — пересылает сообщение сотрудникам с пометкой
«сбой хранилища» (лучше промолчать, чем перебить человека). Админ из
`TELEGRAM_ADMIN_CHAT_ID` работает всегда. Писать клиентам через бота и учить
его может только команда — посторонний с теми же командами ничего не
добьётся.

Все сообщения `sendTelegram` уходят простым текстом, без `parse_mode`: в них
попадают имя и слова клиента и поля заявки с сайта.

`GET /version` показывает `crm`, `bitrix`, `crm_intake` и `telegram_webhook_secret` —
включены ли (без адресов и ключей). Проверки: `npm test` — без сети:
Telegram и CRM — локальные серверы в тесте.

## 9. Editing the conversation

The whole script is in `src/engine.js` — plain English strings and a small step machine.
Change wording, add questions, or add branches there. `SCRIPT.md` describes the current flow.

## Notes

- Sessions are in-memory: a restart forgets in-progress chats (finished leads are already
  in CoffeeGo CRM). For heavy volume, swap the `Map` in `index.js` for Redis.
- No secrets are committed — everything sensitive lives in `.env`.


## Website leads (Netlify Forms → Telegram + CoffeeGo CRM)

Netlify → Project configuration → Notifications → Form submission notifications →
**Add notification → Outgoing webhook**: event `New form submission`, URL
`PUBLIC_URL/netlify/lead`, и в поле **JWS secret token** — та же строка, что
`NETLIFY_LEAD_SECRET` у бота (`python3 -c "import secrets; print(secrets.token_urlsafe(32))"`).
Netlify подписывает каждый вызов заголовком `X-Webhook-Signature` (JWT HS256,
`iss: "netlify"`, `sha256` тела) — бот проверяет подпись по телу запроса.

- Без `NETLIFY_LEAD_SECRET` или с секретом короче 32 знаков бот не принимает
  заявки вовсе (401, ошибка в журнале при старте).
- Запасной способ для старой настройки — `PUBLIC_URL/netlify/lead?key=<NETLIFY_LEAD_SECRET>`,
  только при явном `NETLIFY_ALLOW_KEY=1`; ключ сравнивается за постоянное время и
  в журнал не пишется. Лучше JWS: ключ в адресе оседает в журналах прокси.
- Против ботов в самой форме — honeypot Netlify: у `<form>` атрибут
  `netlify-honeypot="bot-field"` и скрытое поле
  `<p hidden><label>Не заполнять: <input name="bot-field"></label></p>`. Заявки
  с заполненным полем Netlify отбрасывает сам. CRM, кроме того, заводит не
  больше 5 лидов в час с одного телефона или почты — остальные заявки
  дописываются заметкой к последнему лиду.

The bot forwards every website form to the sales responsible (`/assign sales <id>`),
copies the admin and sends it to CoffeeGo CRM as a lead (except newsletter sign-ups).
A Bitrix lead is created only with `BITRIX_LEADS=1` and the webhook configured.
