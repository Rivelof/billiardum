# Каталог клубов и сайт-агрегатор (backend-directory, M4)

Контракт — `docs/contracts/m4.md` §1 п. 2–6, 12, §3, §4 и `docs/contracts/m4-api.md`; решения №131–135, №139. Папки: `server/directory/`, маршруты `api/routes/directory.mjs`, `api/routes/leads.mjs`, миграция `supabase/migrations/0800_directory.sql`, сид `supabase/seed.d/0800_directory.sql`.

| Файл | Что внутри |
|---|---|
| `index.mjs` | `init(ctx)`/`stop()`/`directory()`/`tick()`: соседи (light — статус стола, plus — ник, tournaments — турниры клуба, все необязательные), планировщик передачи заявок оператору (30 с, `ctx.clock`) |
| `public.mjs` | публичный API сайта: города, каталог города с фильтрами, страница клуба, карточка для заявки |
| `requests.mjs` | заявки гостей в клубы без программы (T25) |
| `listings.mjs` | «Подтвердить/Добавить клуб», карточка клуба в программе, карточки и заявки на карточки у оператора |
| `leads.mjs` | заявки клубов на программу, антиспам, воронка |
| `reviews.mjs` | отзывы, ответ клуба, жалобы, модерация |
| `api.mjs` | §3: `publicClub`, `publicCity`, `clubLiveStatus` |
| `common.mjs`, `slug.mjs` | ввод, уведомления платформе (`bl.platform_recipients`), `safely` (необязательный шаг в точке сохранения), транслит слагов |

## База (`0800_directory.sql`)

- `cities` (слаг-транслит, часовой пояс), `club_public` (`listed` | `claimed` | `platform`, `club_id` у клуба в программе, контакт для заявок `contact_user_id` не публикуется; статус, слаг, город, видимость и контакт меняет только платформа — триггер), `club_requests` (телефон гостя — снимок на момент заявки, ответ клуба — одноразовый токен, в базе sha256, `escalate_at`), `directory_claims`, `leads` (IP — только sha256 с секретом сервера), `reviews` (один на гостя и клуб; оценку и текст меняет только автор, ответ — только клуб, скрывает — платформа — триггер), `review_reports`.
- RLS: ENABLE + FORCE на всех. Публично читаются города, видимые карточки и опубликованные отзывы. Клуб — свои строки по `bl.ctx_club_id()`. Оператор и администратор платформы — `bl.ctx_platform_role()` (core 0710, маршруты `auth: 'platform'`), фоновые задачи — `bl.ctx_is_platform()` (`bl.ctx_platform_staff()`). Гость — свои заявки (создаёт, закрывает), свои заявки на карточки, свой отзыв. Новых функций `SECURITY DEFINER` нет.

## Публичный API (без входа; кэш 60 с и 120 запросов в минуту с IP — роутер core)

`GET /api/public/cities` →
```json
{ "items": [{ "slug": "ekaterinburg", "name": "Екатеринбург", "name_in": "в Екатеринбурге", "region": "Свердловская область", "clubs": 2, "online_clubs": 1, "free_now": 8 }] }
```

`GET /api/public/cities/{slug}?disciplines=pyramid,pool&free_now=1&online=1&around_the_clock=1&price_max=60000&sort=recommended|free|price|rating|name` →
```json
{ "city": { "slug", "name", "region", "timezone" },
  "filters": { "disciplines": ["pool"], "free_now": true, "online": true, "around_the_clock": true, "price_max": 60000, "sort": "recommended" },
  "updated_at": "ISO",
  "items": [ClubSummary] }
```
`ClubSummary`: `{ id, slug, path: "/ekaterinburg/testovyy-klub/", name, status: "listed"|"claimed"|"platform", club_id: "uuid"|null (только platform), booking: "online"|"request", address, location: {lat, lng}|null, hours_text, around_the_clock, disciplines: ["pyramid","pool","snooker"], tables_count, free_now: n|null (только platform), price_from_kopecks: n|null (за час; platform — минимум тарифов), rating: { avg: 4.5|null, count } }`. `name_in` — город с предлогом из справочника (миграция 0801), `free_now` в городах — сумма свободных столов клубов на программе. Сортировка `recommended`: сначала онлайн-бронь, затем больше свободных, затем по названию. `disciplines` — клуб должен иметь все выбранные. Неверный фильтр — `400`, нет города — `404`.

`GET /api/public/clubs/{city}/{slug}` →
```json
{ "club": { ...ClubSummary, "city": { "slug", "name", "timezone" }, "club_id": "uuid|null (только platform — для брони в приложении)",
            "phone": "+7… клуба", "url", "max_url", "telegram_url", "description" },
  "live": null | { "updated_at", "free_now", "total", "plan": { "width_cm", "height_cm" } | null,
                   "tables": [{ "id", "number", "title", "discipline", "plan": { "x", "y", "rotation" },
                                "status": "free"|"busy"|"reserved"|"unavailable", "busy_until": "ISO|null" }] },
  "prices": [{ "discipline", "days": [1,2,3,4], "from": "17:00", "to": "00:00", "price_per_hour_kopecks": 80000, "min_minutes": 30 }],
  "tournaments": [ /* server/tournaments publicTournaments(db, {clubId}), если модуль есть */ ],
  "reviews": { "avg", "count", "items": [{ "id", "rating", "text", "author_nick": "ник Бильярдум+|null", "created_at", "reply": { "text", "at" } | null }] },
  "updated_at": "ISO" }
```
`live`, `prices`, `tournaments` — только у клубов в программе (`status: platform`). Время цен — местное время клуба, `days` — ISO (1 = пн). Персональных данных нет: ни гостей, ни сессий, ни броней.

`GET /api/public/listings/{id}` → `{ id, name, city, address, status }` (экран заявки `/app/request/{listing_id}`).

## Заявка гостя в клуб без программы (T25)

| Маршрут | Кто | Ответ |
|---|---|---|
| `POST /api/clubs/requests {listing_id, starts_at, minutes 30–720, people 1–20, comment?}` | гость (телефон, согласие), 10/мин | `201 {id, status: 'sent'}`; клуб в программе — `409 online_booking`; больше 3 открытых — `409 limit_exceeded` |
| `GET /api/clubs/requests`, `GET /api/clubs/requests/{id}` | гость, свои | `{items}` / `{id, status: 'sent'|'accepted'|'declined'|'operator'|'closed', club: {name}, starts_at, minutes, people, answer_text, updated_at}` |
| `POST /api/clubs/requests/{id}/cancel` | гость | заявка `closed` |
| `GET /api/clubs/requests/{id}/answer?t=` | клуб по ссылке из уведомления (без входа) | `{id, status, club, starts_at, minutes, people, comment, guest_phone, created_at}` |
| `POST /api/clubs/requests/{id}/answer {t, decision: 'accept'|'decline', text?}` | клуб по ссылке (одноразовая) | заявка для гостя |
| `GET /api/clubs/{club}/requests`, `POST /api/clubs/{club}/requests/{id}/answer {decision, text?}` | персонал клуба в программе | список / заявка |

Уведомление клубу — контакту карточки, `kind: club.request`, кнопка «Ответить на заявку» → `/app/club-request/{id}?t={токен}` (24 часа, одноразово). Нет контакта — заявка сразу оператору; нет ответа 15 минут — оператору (`status: operator`, уведомление `platform.club_request` операторам и `club.request_operator` гостю). Ответ — гостю `club.request_answer`.

## Карточки, leads, отзывы

- `POST /api/directory/claim {listing_id, comment?}`, `POST /api/directory/add {city, name, address, phone?, hours_text?, url?, max_url?, telegram_url?, disciplines?, tables_count?, comment?}` — гость (телефон, согласие) → `201 {id, status: 'new'}`, операторам `platform.listing_claim|listing_add`. Карточка уже подтверждена — `409 already_claimed`. Оператор одобряет «Подтвердить клуб» только пока карточка `listed` (иначе `409 already_claimed`, M4-4); при одобрении остальные открытые заявки на карточку отклоняются с причиной «права подтверждены другому заявителю» (журнал `platform.listing_reject` с `auto: true`), заявителям — уведомление `directory.claim_decision`. Телефоны в отзывах маскируются и с разделителями `.`, `/`, пробелами, скобками, дефисами (M4-5, `maskPhones`), а также с невидимыми знаками и любыми 1–3 знаками не-буквами между цифрами (`· , : ~ ...`, M4-8). Отзыв, ответ клуба и жалоба хранятся уже нормализованными (`normalizeText`: без `\p{Cf}`, цифры в ASCII) и с маской; текст из одних невидимых знаков — `400 bad_request`.
- `GET/PATCH /api/clubs/{club}/listing` — владелец, управляющий: `{id, status, name, city, city_slug, slug, path, address, phone, description, hours_text, around_the_clock, url, max_url, telegram_url, disciplines, tables_count, price_from_kopecks, visible, club_id, updated_at}`; меняет описательные поля (статус — только платформа).
- `POST /api/leads {name, club_name, city, phone, tables_count?, comment?, consent: true, website: '' (скрытое поле), elapsed_ms}` — без входа, 5 за 10 минут и 5 за сутки с IP → `201 {ok: true}`; бот (заполнено скрытое поле или форма заполнена быстрее 3 с) получает тот же ответ без записи; без согласия — `403 consent_required`. Администраторам — `platform.lead` (без телефона в тексте).
- `POST /api/reviews {club_id, rating 1–5, text ≤ 1000}` → отзыв; нет игры или брони за 90 дней — `403 review_not_allowed`; повтор — изменение. `GET /api/reviews/mine?club_id=` → отзыв | null. `GET /api/clubs/{club}/reviews` → `{items: [{id, rating, text, author_nick, created_at, reply, reported, status}]}`. `POST /api/reviews/{id}/reply {text}` — владелец, управляющий. `POST /api/reviews/{id}/report {reason}` — любой вошедший → операторам `platform.review_report`.

## Экран оператора (`auth: 'platform'`, оператор и администратор)

`GET /api/platform/requests?status=` → `{items: [{id, status, listing: {id, name, city, status}, starts_at, minutes, people, comment, guest: {phone, phone_masked}, answer_text, answered_via, escalated_at, created_at, updated_at}]}`, `PATCH …/{id} {status: 'accepted'|'declined'|'closed', reason}`.
`GET /api/platform/listings?status=new|approved|rejected` → `{items: [{id, kind: 'claim'|'add', status, listing, payload, user: {id, phone, phone_masked}, reason, created_at, updated_at}]}`, `PATCH …/{id} {action: 'approve'|'reject', reason?, city_slug?}`; `POST /api/platform/cards`, `PATCH /api/platform/cards/{id}` (поля, `visible`, `status`, `club_id`).
`GET /api/platform/cities` → `{items: [{id, slug, name, name_in, region, timezone, active, clubs, created_at}]}` (и неактивные); `POST /api/platform/cities {name, name_in, timezone, region?, slug?, active?}` → `201` город (слаг — транслит названия, если не задан; `name_in` начинается с «в»/«во»/«на»; пояс — IANA из Intl, `server/lib/timezone.mjs`; занятый слаг — `409 duplicate`); `PATCH …/{id} {name?, name_in?, region?, timezone?, active?}` — слаг не меняется (адреса сайта). Одобрение «Добавить клуб» в городе вне справочника — `409 city_required`, либо в том же PATCH `new_city: {name, name_in, timezone, region?, slug?}`.
`GET /api/platform/leads?status=` → `{items: [{id, name, club_name, city, phone, tables_count, comment, status, note, created_at, updated_at}]}`, `PATCH …/{id} {status, note|reason}`.
`GET /api/platform/reports?status=new|hidden|kept` → `{items: [{id, status, reason, review: {id, rating, text, status, reply, club: {id, name}}, decision_reason, created_at}]}`, `PATCH …/{id} {action: 'hide'|'keep', reason}` (скрыть — причина обязательна).
Действия — в журнал платформы (`platform.*`, `actor_type: support`, от имени сотрудника).

## Коды ошибок

`bad_request` 400, `reason_required` 400, `city_required` 409, `unauthorized` 401, `forbidden` 403, `consent_required`/`phone_required` 403, `review_not_allowed` 403, `not_found` 404, `online_booking` 409, `already_claimed` 409, `already_decided` 409, `request_closed` 409, `duplicate` 409, `limit_exceeded` 409, `rate_limited` 429.

## Тесты

```sh
DATABASE_ADMIN_URL=… node --test --test-concurrency=1 "server/directory/test/db/*.test.mjs"
```
`test/db/harness.mjs`: временная база, настоящий `createApp` (роутер с публичным кэшем и ролями платформы), настоящий сервис light без MQTT (статус стола), поддельные часы.
