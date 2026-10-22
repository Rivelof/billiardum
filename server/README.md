# Сервер «Бильярдума» (`@billiardum/server`)

Вход `index.mjs`: HTTP на `PORT` (`GET /health` и API `api/routes/*.mjs`), модули core → light → money. Контракты — `docs/contracts/m0.md` §6 и `docs/contracts/m1.md` §2–4, §7, §13; протокол — `docs/protocol.md`.

## Команды

| Команда | Что делает |
|---|---|
| `node server/index.mjs` | сервер; по `SIGTERM`/`SIGINT` перестаёт принимать соединения, закрывает потоки SSE, останавливает money → light (или мост M0) → outbox, закрывает пул базы |
| `npm test -w @billiardum/server` | юнит-тесты без базы и брокера: протокол, мост, роутер, вход, initData, PIN, Web Push (вектор RFC 8291), PDF и QR, SSE, прокси; плюс `tariffs/test`, `payments/test` (money) |
| `npm run test:db -w @billiardum/server` | тесты core на временной базе (`DATABASE_ADMIN_URL`, как `npm run test:db`): вход, CSRF, PIN, идемпотентность, outbox, журнал, тревоги, уведомления, маршруты владельца, SSE |
| `npm run provision:dev` | только разработка, ниже |
| `node server/bin/telegram-webhook.mjs [--delete]` | `setWebhook` бота на `https://{PUBLIC_HOST}/api/bots/telegram/webhook` с `secret_token` через прокси |

## Сборка (`index.mjs`, `http/app.mjs`)

Общий контекст `ctx` (контракт §2.1): `{ config, log, pool, clock, outbox, alarms, notify, sse, audit, telegram, bridge, withContext, modules }`. `withContext` — функция M0 `withContext(pool, { clubId, userId, actorType }, fn)`. Модули `server/sessions/index.mjs` (light) и `server/payments/index.mjs` (money) поднимаются по порядку через `init(ctx)` и останавливаются `stop()` в обратном порядке. Нет файла модуля — лог `module_missing`, сервер работает без него; пока нет light, мост MQTT создаётся как в M0 (`bridge_fallback_m0`). Ошибка внутри модуля — сервер не стартует.

## HTTP API (`api/router.mjs`)

Подключает все `api/routes/*.mjs` (`export const routes = [...]` или `routes(config)`). Маршрут: `{ method, path, auth, roles?, handler, requires?, idempotent?, rateLimit?, actor?, clubFromBody?, findClub?, enabled? }`.

- `auth`: `none` — без входа; `guest` — любой вошедший пользователь; `staff` — роль из `roles` в клубе запроса; `terminal` — токен терминала ресепшена; `any` — пользователь или терминал.
- Вход: `Authorization: Bearer <token>` или cookie `bl_session` (`HttpOnly; Secure; SameSite=Lax; Path=/api`). Токен — 32 байта base64url, в базе только sha256, проверка — `bl.auth_resolve`.
- Клуб запроса: `{club}` в пути → `body.club_id` (`clubFromBody`) → `?club=` → заголовок `X-Club-Id` → клуб токена PIN или терминала → единственный клуб пользователя с ролью из `roles` (несколько — `findClub` ищет объект в каждом, иначе `400`). У `auth: 'none'` клуб только из пути или `ctx.useClub(id)` в обработчике.
- Транзакция `withContext` на запрос: `actor_type = user` и `app.user_id`; вебхуки с `actor: 'system'` работают в контексте платформы. Обработчик: `async handler(ctx, req) → { status, json } | { status, headers, body } | { status, stream(res) }`; `ctx = { ...общий контекст, db, user, club, roles, principal, idempotencyKey, useClub(id), setCookie(header), afterCommit(fn) }`. `afterCommit` — после коммита (SSE, MQTT); при откате не выполняется.
- Ошибка: брошенный `HttpError` (или любая ошибка с `status` и `code`) — откат и `{"error":"code"}`; прочие — `500 {"error":"internal"}`, подробности только в лог. Словарь — `http/errors.mjs` (контракт §3, плюс `no_tariff`, `not_configured`, `method_not_allowed`, `internal`).
- Изменяющие запросы: `Content-Type: application/json` обязателен (`415`), тело — объект JSON до 64 КБ (`413`, `400`). Запрос с cookie — только с `Origin` из `https://{PUBLIC_HOST}` (и `https://{DEV_LAN_HOST}{порт}` не в проде, `ALLOWED_ORIGINS`); чужой `Origin` — `403` всегда, с Bearer тоже.
- `requires: ['phone', 'consent']` — `403 phone_required` / `403 consent_required`.
- `idempotent: true` — `Idempotency-Key` (UUID) обязателен; повтор с тем же ключом (пользователь, ключ, маршрут) 24 часа — тот же ответ с `Idempotent-Replayed: true` без исполнения; тот же ключ с другим телом — `409 idempotency_conflict`; параллельный повтор ждёт коммита первого. Ошибка, брошенная обработчиком, не сохраняется.
- Ограничение частоты — в памяти, на IP и маршрут (по умолчанию 600 в минуту, `rateLimit` маршрута), `429 rate_limited` с `Retry-After`. IP: адрес сокета; `X-Forwarded-For` (последний адрес) — только если соединение пришло из `TRUSTED_PROXY_CIDRS` (по умолчанию loopback и частные сети — Caddy в сети Compose).
- Заголовки ответов: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cross-Origin-Resource-Policy: same-origin`. Внешних ресурсов сервер не отдаёт и не подключает.

## Вход (`auth/`, `api/routes/auth.mjs`, контракт §4)

| Маршрут | Суть |
|---|---|
| `POST /api/auth/dev {phone}` | только `NODE_ENV ≠ production` и `ALLOW_DEV_LOGIN=1`; иначе маршрут не регистрируется |
| `POST /api/auth/telegram {init_data}` | HMAC-SHA256: секрет = HMAC(«WebAppData», токен), `hash` за постоянное время, `auth_date` ≤ 24 ч (и не из будущего > 5 мин); `{token, user, needs_phone}` |
| `POST /api/auth/max` | `501 not_configured` до документации MAX |
| `POST /api/auth/bot-link {channel}` | nonce 32 байта (в базе sha256, 10 минут), `deep_link = https://t.me/<бот>?start=<nonce>`, cookie `bl_link` с секретом браузера; `max` — 501 |
| `GET /api/auth/bot-link/{nonce}` | `pending` / `expired` / `done` + токен — один раз и только браузеру с `bl_link` |
| `POST /api/bots/telegram/webhook` | `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET`; `/start <nonce>` → кнопка «Поделиться контактом» (телефон уже известен — сразу вход); свой контакт → телефон (`bl.auth_attach_phone`), nonce → done; ответы бота — после коммита, через прокси |
| `POST /api/auth/consent {version}` | версия = `CONSENT_VERSION` (по умолчанию `2026-10-21`) |
| `POST /api/auth/logout`, `GET /api/me` | выход (токен отзывается, cookie стирается); `{user, clubs, session}` — телефон только маской |
| `POST /api/staff/terminal {club_id, name}` | владелец, управляющий (личный вход): `{terminal_token, terminal_id}`, журнал `auth.terminal_register` |
| `GET /api/staff/terminal` | терминал: персонал клуба с маской телефона и признаком PIN (для выбора сотрудника) |
| `POST /api/staff/pin {user_id, pin}` | терминал: токен PIN на 12 ч только в клубе терминала, предыдущий сотрудник терминала выходит; журнал `auth.pin_switch {terminal_id}`; 5 ошибок подряд — блок 15 минут (`429`) |
| `PUT /api/staff/pin {club_id, pin}` | сотрудник сам задаёт PIN (4–6 цифр, scrypt N=16384 с солью и «перцем» из `SECRETS_ENC_KEY`), журнал `auth.pin_set` |

Вход персонала через бота или `dev` пишет `auth.staff_login` в журнал каждого клуба, где он сотрудник. Телефон из контакта уже есть у другой учётки (сотрудник из сида, вход через другой мессенджер) — учётка мессенджера вливается в неё (`merged_into`), её токены перестают действовать; у той учётки другой Telegram — `phone_conflict`, бот сообщает. Telegram — только через `TELEGRAM_PROXY_URL` (`http://` — CONNECT, `socks5://`), `lib/http-client.mjs`; без токена или прокси канал выключен.

## Outbox (`outbox.mjs`, контракт §2.2)

`enqueue(db, topic, payload[, { clubId }])` — в транзакции вызывающего (клуб — из контекста). `subscribe(topic, handler, { name })` — обработчик в своей транзакции с контекстом клуба события, вместе с отметкой `bl.outbox_done`; ошибка — повтор через 1, 2, 4 … 300 с, после 5 неудач — тревога `outbox_failed` (critical) клубу. Доставка «хотя бы один раз»; сбой одного подписчика не держит остальных. Задержка — `LISTEN bl_outbox` (NOTIFY триггера вставки) и опрос раз в 1 с; обработанные события старше 7 дней удаляются. В `last_error` и логе — только код ошибки, длинные номера маскируются.

## Тревоги и уведомления (`alarms/`, `notify/`, контракт §7)

- `raise(db, clubId, {type, level, resourceId?, data})` — в контексте клуба: `bl.alarms`, журнал `alarm.raised`, уведомление владельцам и управляющим, после коммита SSE `alarm` в `club:{id}`. Повтор открытой тревоги того же типа по тому же столу — только `count` (без журнала и уведомлений). `ack` — `alarm.ack`.
- `send(db, userId, {kind, text, data, level})`, `sendToClubStaff(db, clubId, roles, msg)` — строка `bl.notifications` и событие outbox `notify.deliver`. Доставка — в контексте платформы по цепочке: основной канал пользователя, затем max → telegram → webpush; `critical` — во все доступные. MAX — `skipped` до документации; Telegram без токена или прокси — `skipped`; лог `notify_skipped`. В тексте и `data` последовательности из 10+ цифр заменяются на `***` (decisions №53).
- Web Push (`notify/webpush.mjs`): RFC 8291 `aes128gcm` и VAPID RFC 8292 ES256 на `node:crypto`; тело — `{kind, text, tag, url}`. Подписки только на `https` известных push-сервисов (FCM, Mozilla, Apple, WNS; `WEBPUSH_ALLOWED_HOSTS`), 404/410 — подписка отзывается.
- SSE (`http/sse.mjs`): `publish(channel, event, data)`, каналы `club:{id}`, `session:{id}`, `user:{id}`; `GET /api/stream?club=` — ресепшн и выше, `?session=` — участник или персонал клуба сессии; свой `user:{id}` всегда; keep-alive 25 с, раз в минуту проверка токена и роли, до 10 потоков на пользователя.

## Маршруты владельца (`api/routes/owner.mjs`)

`GET /api/clubs/{club}/now` (зал — сервис light, выручка `succeeded` по способам за рабочие сутки клуба с `day_start_local`, открытые тревоги), `GET …/audit?from&to&actor&action&resource&cursor&limit` (`action` с точкой на конце — префикс; курсор — `seq`), `GET …/audit/verify` (только владелец), `GET …/alarms?state=open|acked|all`, `POST /api/alarms/{id}/ack`, `POST /api/push/subscribe` (тело — `PushSubscription.toJSON()`), `GET /api/push/vapid-public-key` (`{public_key}` для `applicationServerKey`; без ключей — 501), `GET …/qr-stickers.pdf` — A4, четыре наклейки A6 на лист: номер стола крупно, QR `https://{PUBLIC_HOST}/t/{code}` (уровень Q), код `XXXXX XXXXX`; шрифт JetBrains Mono Bold встроен целиком (`qr/fonts`, лицензия OFL в `qr/fonts/OFL.txt`), QR — пакет `uqr` (MIT).

## Переменные окружения

M0: `DATABASE_URL` (роль `app_api`), `MQTT_URL`, `MQTT_CA_FILE`, `MQTT_SERVER_USER`, `MQTT_SERVER_PASSWORD`, `SECRETS_ENC_KEY`, `PORT` (3000), `LOG_LEVEL`. M1: `NODE_ENV`, `PUBLIC_HOST` (`localhost:8443`), `DEV_LAN_HOST`, `ALLOW_DEV_LOGIN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_PROXY_URL`, `MAX_BOT_TOKEN`; необязательные: `TRUSTED_PROXY_CIDRS`, `ALLOWED_ORIGINS`, `CONSENT_VERSION`, `WEBPUSH_ALLOWED_HOSTS`, `DEV_STAFF_PIN` (provision). Client id сервера в MQTT — всегда `bl-server`. Сервер `.env` не читает: окружение даёт Compose или systemd.

## HTTP

`GET /health` → `200 {"ok":true,"db":true,"mqtt":true}`; если база не ответила за 2 с или нет связи с брокером — `503` того же вида. Прочие пути — роутеру API (`404 {"error":"not_found"}`, `405 {"error":"method_not_allowed"}`).

## Мост MQTT (`mqtt.mjs`, protocol v1 §2, §6)

M1: мост создаёт модуль light (`sessions/index.mjs`) — очередь команд `bl.device_commands`, актуальное состояние стола, события в журнал один раз, сверка `state` и тревоги; подробно — `sessions/README.md`. Ниже — поведение M0, которое сохраняется.

- Подключение `bl-server` по TLS с CA из файла, `clean session`, подписка `bl/v1/+/+/{state,status,event,ack}` (QoS 1). Входящие сообщения больше 4096 байт отбрасываются с записью в лог (`message_too_large`).
- Клуб устройства — по `device_id` из базы (`bl.device_club`), а не из топика. Расхождение — лог `device_club_mismatch` (тревога) и запись `device.topic_mismatch` в журнал клуба; сообщения такого топика не обрабатываются.
- Онлайн: `status = online` и получен `state` (после `offline` нужен свежий `state`). Офлайн: `status = offline` или нет `state` больше 150 с.
- Одна неподтверждённая команда на устройство, остальные ждут в очереди. Команда: в одной транзакции под `app_api` с контекстом клуба — `SELECT … FOR UPDATE`, `seq`, расшифровка `device_key`, подпись, запись `device.cmd` (`data = {cmd_id, seq, type}`). Публикация после коммита. Без `ack` 3 с — повтор той же команды байт в байт, до 5 раз, затем `cmd_no_ack` (уровень `error`, тревога «контроллер не отвечает») и отказ от команды; следующая из очереди уходит. Повтор журнал не пишет. Устройство без ключа — `cmd_skipped`, ни `seq`, ни журнала.
- Пока устройство офлайн, повторов и `cmd_no_ack` нет: неподтверждённая команда бросается (`cmd_abandoned`), очередь чистится (`cmd_dropped`); досылается только `config.set` тем же `id` и `seq`. Команды офлайн-устройству не ставятся (`command()` → `offline`).
- После выхода онлайн и после события `boot` — актуальное состояние стола (`actualState`). В M0 это `ping`: сессий нет, симулятор M0 исполняет только `ping` и `identify`. В M1 сюда встаёт `session.resume`, `service.start`, `state.pending`/`state.reserved` или `state.free`. `boot` в течение 10 с после выхода онлайн — та же загрузка, второй раз состояние не шлётся.
- Сверка: `seq = greatest(devices.last_seq, state.last_seq) + 1`. Подъём по `state` — запись `device.seq_sync` (`{from, to}`) и лог `device_seq_sync`. Разрыв больше 1 000 000 — лог `device_seq_gap` (уровень `error`, тревога) без подъёма.
- `ack` сопоставляется по `cmd_id` и устройству. `ack` с `cmd_id: null` (команда не разобрана, `bad_format`) относится к неподтверждённой команде: её не повторяют.

Логи — строки JSON в stdout без персональных данных:

```
{"t":"…","level":"info","msg":"devices_online","online":8,"total":8}      при изменении и раз в 60 с
{"t":"…","level":"info","msg":"cmd_ack","device_id":"…","type":"ping","seq":1,"ok":true}
```

Также: `device_online`, `device_offline` (`reason`: `status` или `no_state`), `device_event` (только `type`, `boot`, `boot_id`, `n`), `device_unknown`, `cmd_no_ack`, `cmd_abandoned`, `cmd_skipped`, `device_seq_sync`, `device_seq_gap`, `message_too_large`, `mqtt_connected`, `mqtt_disconnected`, `db_error`. При `ok:false` строка `cmd_ack` идёт с уровнем `warn` и полем `error` (код из `ack`).

## Модули `lib/`

- `protocol.mjs` — строгий и канонический JSON, подпись HMAC-SHA256, проверка команды (`bad_format` → `bad_sig`), сборка команды, топики; проходит все 38 векторов. `bad_format`: команда длиннее 2048 байт, обратная косая черта где угодно, повторяющиеся ключи, числа не по исходному тексту (`context.source` в reviver `JSON.parse`: `1.0`, `9e5`, `-0`, ведущие нули, вне ±(2^53−1)), поля не по §3 (`id` — UUID в нижнем регистре, `seq` ≥ 1, `issued_at` — целое ≥ 0, `body` — объект). `bad_sig`: `sig` не ровно 44 символа канонического base64 или не совпадает.
- `secrets.mjs` — AES-256-GCM (decisions №23): `v1:` + base64(iv 12 ‖ tag 16 ‖ шифртекст), AAD `bl.secret/device_key/<device_id>` — ключ одного устройства, переложенный в строку другого, не расшифруется.
- `store.mjs` — транзакции с контекстом клуба (`withContext`), выделение `seq` и журнал.
- `dynsec.mjs` — команды Dynamic Security, роли устройства и сервера.

## `npm run provision:dev`

Только разработка (отказ при `NODE_ENV=production`). Через `MQTT_ADMIN_USER` в Dynamic Security: роль `bl-server` (`bl/v1/#`: подписка, приём, публикация) и клиент `MQTT_SERVER_USER` с паролем из `.env` и закреплённым client id `bl-server` (второе подключение с другим client id брокер отвергает). Для каждого устройства в базе: роль `bl-device-<device_id>` с точными топиками протокола §2 (подписка и приём только своего `cmd`; публикация своих `ack`, `state`, `event`, `status`), клиент с логином и обязательным client id = `device_id`, новый пароль MQTT и новый `device_key`. Ключ пишется в `bl.devices.device_key_enc` (через `DATABASE_ADMIN_URL`), всё вместе — в `deploy/dev/devices.json` (или `SIM_DEVICES_FILE`) с правами 0600; `mqtt_url` и `ca_file` в файле — значения `MQTT_URL` и `MQTT_CA_FILE`.

После устройств: PIN `DEV_STAFF_PIN` (по умолчанию `1234`) владельцу, управляющему и ресепшну тестового клуба, у кого PIN ещё нет (хеш зависит от `SECRETS_ENC_KEY`, поэтому не в сиде), и `provisionPayments` из `server/payments/provision-dev.mjs` (money), если модуль есть.

Повторный запуск выдаёт новые ключи и пароли и согласованно обновляет брокер, базу и файл. Порядок в `scripts/dev.mjs`: остановить `server` и `device-sim` → `db:migrate` → `db:seed` → `provision:dev` → поднять `server`, затем `device-sim` заново (`--force-recreate`). Запущенный при провижининге симулятор брокер отключает (новый пароль), а его старый ключ дал бы `bad_sig`.
