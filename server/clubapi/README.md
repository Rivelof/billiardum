# Публичный API клуба (M5.7)

Контракт — `docs/contracts/m5-5-8.md`, раздел M5.7, решения №199–202. Описание для интеграторов (OpenAPI 3.1, curl, проверка подписи) — `docs/api/club-api-v1.md`.

Модуль `server/clubapi` (ключи, вход по ключу, маршруты чтения, вебхуки, доставка), маршруты `api/routes/clubapi.mjs`, миграции `supabase/migrations/1200_clubapi.sql` и `1201_clubapi_failing.sql`, модуль `clubapi` в `server/http/app.mjs` (MODULES).

## Ключи API (№199)

- Ключ — `blk_` + 32 случайных байта base64url (47 символов). Показывается один раз в ответе на выпуск. В базе — `key_hash` = HMAC-SHA256 ключа с перцем `HMAC(SECRETS_ENC_KEY, 'bl.api-key-pepper.v1')` и префикс `blk_` + 8 символов для показа. Ключа нет ни в базе, ни в журнале, ни в логах, ни в таблице идемпотентности (маршрут выпуска без `Idempotency-Key`: повтор ответа хранил бы ключ).
- Смена `SECRETS_ENC_KEY` делает все ключи недействительными — владелец выпускает новые.
- Выпуск, отзыв — только владелец; выпуск — только личным входом (не PIN на терминале ресепшена, `403 forbidden`). Не больше 5 активных ключей на клуб: проверка сервера под `pg_advisory_xact_lock` клуба и триггер `bl.api_keys_guard` (страховка). Отзыв необратим; имя, права и хеш не меняются (триггер, права по столбцам: `app_api` не читает `key_hash`, меняет только `revoked_at`, `revoked_by`).
- Журнал: `api_key.create {key_id, name, prefix, scopes}`, `api_key.revoke {key_id, name, prefix}` — без ключа.
- Права (`scopes`): `tables:read`, `tariffs:read`, `availability:read`, `sales:read`, `bookings:read`.

## Вход по ключу

Маршруты `auth: 'api_key'` (`/api/v1/club/…`) — отдельный путь роутера (`server/clubapi/auth.mjs`):

1. `Authorization: Bearer blk_…` (cookie и токены пользователей не читаются) → `bl.clubapi_key_auth(hash)` (SECURITY DEFINER): ключ, клуб, права, режим клуба; `last_used_at` — не чаще раза в минуту. Нет, не тот вид, отозван — `401 unauthorized`.
2. Лимиты (№202): 600 запросов в минуту на ключ (`api_key|<id>`), у продаж — ещё 60 в минуту (`keyRateLimit`); плюс общий лимит роутера по IP и маршруту. Превышение — `429 rate_limited` с `Retry-After`.
3. Клуб приостановлен платформой — `403 club_suspended`. Нет права маршрута — `403 scope_required`.
4. Транзакция `READ ONLY` (repeatable read) с `app.club_id` клуба ключа, `app.actor_type = 'api'`, пустым `app.user_id`: никаких прав сотрудника, запись в любую таблицу (и в журнал) отклоняет база (`25006`). `?club=` и `X-Club-Id` ключ не подменяют.

В логе `http` у запроса по ключу — `api_key_id` и `club_id` (без ключа).

## Маршруты чтения (№200)

Без ПДн гостей: ни телефонов, ни имён, ни `user_id`, ни id игр (`session_id`) — только столы, время, статусы и деньги агрегатами. Деньги — копейки, время — ISO UTC, `*_local` — местное время клуба.

| Маршрут | Право | Суть |
|---|---|---|
| `GET /api/v1/club/tables?kind` | `tables:read` | `{club, at, tables: [{resource_id, number, title, type, status, busy_until, hold_until}]}`; `status`: `free` · `busy` · `reserved` · `service` · `offline` · `fault` (как «Статус зала» дашборда) |
| `GET /api/v1/club/tariffs?kind` | `tariffs:read` | `{club, at, holiday_iso_day, rounding_kopecks, holidays: [{date, kind}], rules: [{rule_id, resource_type, resource_id, days, start_local, end_local, price_per_hour_kopecks, step_minutes, min_minutes, priority}], tables: [{resource_id, number, title, type, price_now, price_next}]}` — праздники на 90 дней вперёд |
| `GET /api/v1/club/availability?date&kind` | `availability:read` | расчёт страницы брони (`server/bookings/availability.mjs`): `{club, date, from, to, open_at, close_at, now, step_minutes, min_minutes, max_minutes, lead_minutes, max_days, tables: [{resource_id, number, title, type, free, busy: [{from, to, kind}], rates}]}` |
| `GET /api/v1/club/sales?from&to&kind` | `sales:read` | свёртка дашборда (`collect`, `dailyRows`) — столбцы CSV `revenue_daily` числами: `{club, period: {from, to, today, includes_today, missing_days}, kind, totals, days: [{date, today, total_kopecks, refunds_kopecks, net_kopecks, tables_kopecks, bar_kopecks, other_kopecks, by_method: {cash, card_terminal, sbp, card}, games, avg_check_game_kopecks, avg_check_bar_kopecks, utilization_pct}]}`; период — рабочие сутки клуба, до 366; лимит 60 в минуту |
| `GET /api/v1/club/bookings?from&to&kind&status&limit&cursor` | `bookings:read` | `{club, period, items: [{booking_id, resource_id, resource_number, resource_type, starts_at, ends_at, status, source, created_at, canceled_at, test}], next_cursor}`; период — сутки начала брони, до 93; `limit` до 1 000 (по умолчанию 500) |

## Вебхуки (№201)

- Адрес — только `https://` на порту 443, без учётных данных и фрагмента. **SSRF:** имя резолвится при регистрации, и все адреса должны быть публичными (`server/clubapi/ssrf.mjs`: внутренние, локальные, link-local и metadata `169.254.169.254`, CGNAT, multicast, зарезервированные и документационные IPv4; `::1`, `::`, ULA, link-local, multicast, NAT64, 6to4, Teredo, IPv4-mapped `::ffff:a.b.c.d` — по адресу IPv4); имена `localhost`, `*.local`, `*.internal`, `*.home.arpa` и т. п. — отказ. При **каждом** соединении IP проверяется снова (`lookup` в `https.request`) — DNS rebinding не пускает во внутреннюю сеть; IP-адрес в URL проверяется до соединения. Редиректы не выполняются (`3xx` — неудача `redirect`). Ответ читается не больше 64 КБ, таймаут 10 с.
- События: `session.started`, `session.ended` (из `session.closed`), `booking.created`, `booking.canceled`, `shift.closed`; тестовое — `ping`. Тело собирается по белому списку полей (`webhooks.mjs: eventData`), игра — псевдонимом `game_id` (HMAC id игры с перцем клуба, вид UUID): начало и конец одной игры совпадают, но это не id сессии. Адрес получает события, случившиеся после его регистрации; событие старше суток не шлётся.
- Подпись: `X-Bl-Signature: v1=<hex HMAC-SHA256(secret, "<X-Bl-Timestamp>.<тело>")>`, `X-Bl-Timestamp` — Unix-секунды; ещё `X-Bl-Event`, `X-Bl-Event-Id` (для идемпотентности у получателя), `X-Bl-Delivery`. Секрет `whsec_…` показывается один раз, хранится AES-256-GCM (`SECRETS_ENC_KEY`, контекст `webhook_secret/<id>`).
- Доставка: обработчик outbox (подписчики `clubapi.webhooks.<тема>`) только пишет строки `bl.webhook_deliveries` в транзакции события; сеть — в воркере вне транзакций (как уведомления, №130): медленный или зависший получатель не держит outbox, деньги и свет. Воркер — раз в 5 с и сразу после новой доставки; захват `for update skip locked` в контексте платформы, аренда 2 минуты; не больше 4 запросов одновременно.
- Повторы: через 1, 5, 15, 30 минут, 1, 2, 4, 8 часов и последняя — ровно через 24 часа после события; затем `failed`. Успех — `2xx`. Каждая попытка — строка `bl.webhook_attempts` (время, HTTP-статус или код ошибки, длительность). Доставки старше 30 суток удаляются (кроме ждущих).
- Доставка перешла в `failed` — владельцу клуба уведомление (не тревога, уровень `important`, вид `webhook.failing`): «Вебхук <хост> не принимает события с <дата, время по поясу клуба>…», действие «Журнал доставок» → `/club/api/webhooks/<webhook_id>` (тот же путь в `data.url`). Не чаще раза в сутки на адрес (`webhooks.failure_notified_at`, миграция `1201_clubapi_failing.sql`). В тексте только хост: в пути и запросе адреса могут быть токены получателя.
- Не больше 10 включённых адресов на клуб. Выключение необратимо и отменяет ждущие доставки. Журнал: `webhook.create {webhook_id, host, events}`, `webhook.disable {webhook_id, host, canceled}`.

Коды ошибок доставки (`error`): `http` (ответ не 2xx), `redirect`, `timeout`, `dns`, `connect_refused`, `connect_reset`, `unreachable`, `tls`, `url_forbidden` (адрес стал внутренним), `url_invalid`, `secret`, `net:<код>`.

## Маршруты владельца (для экрана «API и вебхуки»)

Все — `auth: staff`, роль только `owner`. Ошибки: `400 bad_request` (поле), `401`, `403 forbidden` (не владелец, чужой клуб, выпуск не личным входом), `404 not_found`, `409 api_keys_limit` · `webhooks_limit` · `webhook_disabled`, `400 url_invalid` · `url_forbidden`, `429 rate_limited` (выпуск и регистрация — 20 в минуту, тестовое событие — 10).

| Маршрут | Ответ |
|---|---|
| `GET /api/clubs/{club}/api-keys` | `{items: [ключ], active, limit: 5, scopes: [...]}` |
| `POST /api/clubs/{club}/api-keys` `{name, scopes}` | `201` ключ + `key: "blk_…"` (один раз) |
| `POST /api/clubs/{club}/api-keys/{id}/revoke` | `200` ключ (`active: false`); повтор — тот же |
| `GET /api/clubs/{club}/webhooks` | `{items: [адрес], active, limit: 10, events: [...]}` |
| `POST /api/clubs/{club}/webhooks` `{url, events, description?}` | `201` адрес + `secret: "whsec_…"` (один раз) |
| `POST /api/clubs/{club}/webhooks/{id}/disable` | `200` адрес (`active: false`); повтор — тот же |
| `GET /api/clubs/{club}/webhooks/{id}/deliveries?status&limit&cursor` | `{webhook_id, items: [доставка], next_cursor}`; новые сверху, `limit` до 200 (по умолчанию 50) |
| `POST /api/clubs/{club}/webhooks/{id}/test` | `202 {delivery_id, event_id, event: "ping", status: "pending"}` |

```json
// ключ
{ "key_id": "…", "name": "CRM", "prefix": "blk_AbCdEfGh", "scopes": ["tables:read", "sales:read"],
  "created_at": "2026-10-24T09:00:00.000Z", "created_by": "…", "created_by_name": "Андрей",
  "last_used_at": null, "revoked_at": null, "active": true }

// адрес вебхука
{ "webhook_id": "…", "url": "https://crm.example.ru/hooks/bl", "host": "crm.example.ru",
  "events": ["session.started", "session.ended"], "description": "CRM", "created_at": "…", "created_by": "…",
  "created_by_name": "Андрей", "active": true, "disabled_at": null,
  "last_delivery": { "status": "delivered", "http_status": 200, "error": null, "at": "…" } , "pending": 0, "failed": 0 }

// доставка
{ "delivery_id": "…", "event_id": "…", "event": "session.started", "status": "pending", "attempts": 2,
  "created_at": "…", "last_attempt_at": "…", "next_attempt_at": "…", "delivered_at": null, "http_status": 503, "error": "http",
  "log": [ { "attempt": 1, "at": "…", "http_status": 500, "error": "http", "duration_ms": 41 },
           { "attempt": 2, "at": "…", "http_status": 503, "error": "http", "duration_ms": 38 } ] }
```

`status` доставки: `pending` (ждёт попытки) · `delivered` · `failed` (24 часа без 2xx) · `canceled` (адрес выключен). `last_delivery: null` — доставок ещё не было.

## Тесты

- `node --test server/clubapi/test/*.test.mjs` (входит в `npm test -w @billiardum/server`) — адреса SSRF (IPv4, IPv6, IPv4 в IPv6, NAT64, 6to4, Teredo), синтаксис адреса, имя во внутренний адрес, проверка IP при соединении и DNS rebinding на настоящем HTTPS-приёмнике, отказ от редиректа, подпись, расписание повторов, ключи, `game_id`.
- На базе (`scripts/ci-test-db.mjs` подхватывает `server/clubapi/test/db`): `api.test.mjs` — T45 (выпуск и показ один раз, права, вход и изоляция клубов, отзыв, лимит 5, лимиты 600 и 60, ответы без ПДн, продажи = CSV дашборда до копейки, транзакция только для чтения); `webhooks.test.mjs` — T46 (регистрация и SSRF-адреса, события без ПДн и подпись, чужой клуб, ping, повторы 500 → 200 и до 24 часов, уведомление владельцу о failed раз в сутки, rebinding при доставке, выключение, зависший получатель не держит outbox). Изоляция таблиц и узкая функция — `supabase/tests/isolation.test.mjs`.

```
DATABASE_ADMIN_URL=postgres://… node --test --test-concurrency=1 server/clubapi/test/db/*.test.mjs
```
