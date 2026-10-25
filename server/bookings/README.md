# Бронь и лист ожидания (backend-booking, M3)

Контракт — `docs/contracts/m3.md` §1 п. 1–6, §3, §4; решения №104–109; PRODUCT §6. Папки: `server/bookings/`, `server/waitlist/`, маршруты `api/routes/bookings.mjs`, `api/routes/waitlist.mjs`, миграция `supabase/migrations/0600_bookings.sql`, сид `supabase/seed.d/0600_bookings.sql`.

| Файл | Что внутри |
|---|---|
| `bookings/index.mjs` | `init(ctx)`/`stop()`/`bookings()`/`tick()`: подписки outbox `payment.confirmed`, `session.closed`, `session.started`; планировщик раз в 10 с на `ctx.clock` |
| `bookings/service.mjs` | создание (гость, телефон), предоплата, подтверждение, старт, «гость пришёл», отмена, шаг планировщика, события light |
| `bookings/availability.mjs` | `GET /api/clubs/{club}/availability` |
| `bookings/api.mjs` | интерфейс §3 для light и money: `nextBookingStart`, `nextBooking` (`{id, starts_at, ends_at, source, status}` без ПДн), `bookingForArrival`, `markStarted` |
| `bookings/deps.mjs` | соседи по одной функции: `ctx.bookingDeps` → модуль соседа → заглушка (`not_configured` 501; у `setReserved`/`clearReserved` — предупреждение в лог) |
| `bookings/settings.mjs`, `queries.mjs`, `errors.mjs` | правила клуба, запросы, ошибки |
| `waitlist/index.mjs`, `waitlist/service.mjs` | лист ожидания: подписки `session.closed`, `booking.expired`, `booking.canceled`; планировщик предложений |

## База (`0600_bookings.sql`)

- `bl.bookings`: клуб, стол, гость (`user_id`) или имя и телефон брони по телефону, `source` (`app`, `site`, `phone`, `staff`), `created_by`, `starts_at`/`ends_at` и `period tstzrange` (вычисляемый), статус, режим и суммы предоплаты (`amount_kopecks`, `prepayment_kopecks`, `prepaid_kopecks`), `prepayment_id` (мягкая ссылка на `bl.payments`), `start_quote_id`, `hold_minutes`, `session_id`, отметки планировщика `notified`, отметки времени и причины.
- **`exclude using gist (resource_id with =, period with &&)`** для `pending_payment`, `confirmed`, `reserved`, `started` (№105); расширение `btree_gist` — в схеме `extensions` (в образе `supabase/postgres:15.8.1.085` есть, миграции идут суперпользователем). Гонки — `SELECT … FOR UPDATE` строки стола до проверки; ограничение — страховка (`23P01` → `booking_conflict`).
- `bl.waitlist`: стол, гость, `seq` (порядок очереди), статус `waiting → offered → accepted | expired | canceled`, `offer_until`, `hold_until`, `missed`; одна живая запись гостя на стол.
- RLS: ENABLE + FORCE, `club_id = bl.ctx_club_id()`; гость читает свои строки в любом контексте (`user_id = bl.ctx_user_id()`), меняет — только в контексте клуба брони. `app_api`: `SELECT`, `INSERT`, `UPDATE` только столбцов состояния; `DELETE` нет.
- `bl.booking_due(now, lead, stale, limit)` — `SECURITY DEFINER` (`bl_definer`, видит только id, клуб, статус и времена): дела планировщика всех клубов. Добавлена в список `supabase/tests/isolation.test.mjs`.

## Состояния брони

`pending_payment` (ждёт предоплаты `booking_pay_minutes`) → `confirmed` → `reserved` (за 15 минут до начала: `setReserved` light с `userId` гостя, стол синий, если свободен) → `started` → `completed`; `expired` (`unpaid` — не оплачена; `no_show` — не пришёл за 15 минут без предоплаты или 30 с предоплатой, №107: `clearReserved`, `forfeitPrepayment` без `percent` — процент клуба у money); `canceled`.

Планировщик (`tick`): за час — `booking.reminder`, за 15 минут — `booking.soon` (оба с кнопкой «Моя бронь» `/app/bookings/{id}`; не шлются, если бронь сделана позже порога), `reserved`, после удержания — сгорание и `booking.expired`; идущая бронь после конца без живой сессии — `completed`. Стол освободился (`session.closed`) — ожидающая бронь сразу получает `reserved`. Предложение листа ожидания держит стол `setReserved` за гостем до конца предложения (№122); отказ, истечение, неудачное принятие — `clearReserved`, принятие — `holdPending`.

## Деньги

- `POST /api/bookings/{id}/pay` → `createPrepayment` money (платёж `kind: booking`, id детерминирован по брони); `payment.confirmed {kind: 'booking', booking_id}` → `confirmed`, уведомление. Платёж за сгоревшую или отменённую бронь — `forfeitPrepayment(percent: 0)` (вернуть всё).
- Старт: предоплата зачитывается `settlePrepayment(paymentId, sessionId)`; light получает `paidUntil` = конец брони (№123), игра кончается ровно в этот момент. `setReserved` — с `source: 'booking'` или `'waitlist'` и `userId` гостя.
- Бронь ближе 5 минут к оплаченному концу текущей игры стола — `booking_conflict`, пересечение с игрой — `table_busy` (№123). Минуты опоздания и раннего прихода считаются вниз.
- Корт (M5.8, находка pentester Н-1): сама бронь и обычный старт считаются целыми слотами, а **доплата раннего прихода и цена опоздавшего** — неполный слот по минутам (`exact`: цена слота пропорционально минутам, одно округление до рубля; как у стола, №113, №44): 61 минута до начала при слоте 90 минут за 2 400 ₽ — 1 627 ₽, 80 оставшихся минут опоздавшего — 2 133 ₽.
- Нужна доплата (ранний приход больше чем за `booking_early_free_minutes` до начала при свободном столе; остаток при депозите) — `createBookingQuote` money (№116; пока функции нет — 501 `not_configured`) → `{status: 'payment_required', quote}`; гость платит `POST /api/quotes/{id}/pay`; `payment.confirmed {kind: 'booking_start', quote_id, booking_id}` → старт. Стол успели занять — `refund` доплаты.
- Опоздавший (пришёл после начала) платит только с прихода до конца брони за вычетом внесённого (№113).
- Бронь без предоплаты: при старте гость платит тем же платежом брони (`createPrepayment`, флаг `start_on_pay`); подтверждение сразу начинает игру; не оплатил за 10 минут — бронь снова `confirmed`.
- Отмена гостем раньше `booking_free_cancel_minutes` до начала — `forfeitPrepayment(percent: 0)`; позже — процент клуба. Управляющий и владелец — любую бронь, ресепшн — только брони `phone`/`staff` без предоплаты (№115); всегда с причиной, журнал `manual.booking_cancel`, тревога `manual_action` владельцу, предоплата возвращается целиком.

## API

| Метод и путь | Кто | Ответ |
|---|---|---|
| `GET /api/clubs/{club}/availability?date=YYYY-MM-DD` | без входа, 120/мин с IP | `{club, date, from, to, open_at, close_at, now, step_minutes, min_minutes, max_minutes, lead_minutes, max_days, rules, resources: [{id, number, type, title, plan, busy: [{from, to, kind}], free: [{from, to}], rates: [{from, to, per_hour_kopecks}]}]}`; `kind`: `session`, `pending`, `service`, `booking`, `closed` (нет тарифа). Без ПДн и id броней |
| `POST /api/bookings {resource_id, starts_at, minutes, source?}` | гость (телефон, согласие) | `201` бронь |
| `GET /api/bookings/{id}`, `GET /api/me/bookings` | гость (свои), персонал клуба (`X-Club-Id`) | бронь / список |
| `POST /api/bookings/{id}/pay {method?, return_url?}` | гость, `Idempotency-Key`; `return_url` — только путь своего сайта (`/app/…`), иначе 400 | `{booking, payment_id, confirmation}` |
| `POST /api/bookings/{id}/start {code, method?}` | гость-владелец у стола | `{status: 'started', session_id, booking}` или `{status: 'payment_required', amount_kopecks, quote? , payment_id?, confirmation?, booking}` |
| `POST /api/bookings/{id}/cancel {reason?}` | гость (свою); владелец, управляющий, ресепшн — брони `phone`/`staff` без предоплаты (`X-Club-Id`, причина обязательна) | бронь + `refund_kopecks` |
| `POST /api/bookings/{id}/arrive` | ресепшн и выше | гость брони по телефону пришёл: `reserved` снят, бронь `started` |
| `GET /api/clubs/{club}/bookings?date=` | ресепшн и выше | `{date, from, to, bookings}` с `guest: {name, phone_masked, user}` и `can_cancel` — может ли запрашивающий отменить по №115 |
| `POST /api/clubs/{club}/bookings {resource_id, starts_at, minutes, name, phone, source?}` | ресепшн и выше | `201` бронь по телефону (`confirmed`, без предоплаты), телефон маской |
| `POST /api/waitlist {resource_id}` | гость (согласие) | `201 {id, status, position, …}`; повтор — та же запись |
| `GET /api/me/waitlist`, `DELETE /api/waitlist/{id}` | гость | записи / выход из очереди |
| `POST /api/waitlist/offers/{id}/release {reason}` | ресепшн и выше | снять удержание стола предложением (№122): журнал `manual.waitlist_release`, тревога владельцу, гостю уведомление |
| `POST /api/waitlist/{id}/accept` | гость | `{status: 'accepted', resource: {id, number, title}, resource_id, hold_until}` — стол удержан на 3 минуты; код стола не отдаётся (№119), игра — сканированием QR |

Бронь: `{id, club: {id, name, timezone}, resource: {id, number, title, type}, status, source, starts_at, ends_at, minutes, hold_until, amount_kopecks, prepayment_mode, prepayment_kopecks, paid_kopecks, pay_until, payment_id, session_id, expire_reason, created_at, cancel: {allowed, refund_kopecks, free_until}}`.

### Коды ошибок

`bad_request` 400, `reason_required` 400, `unauthorized` 401, `forbidden` 403 (не тот код стола, нет роли), `phone_required`/`consent_required` 403, `not_found` 404, `booking_conflict` 409 (пересечение с бронью, в том числе ранний приход), `table_busy` 409, `table_service` 409, `table_pending` 409, `table_offline` 409 (принятие из очереди), `no_tariff` 409, `limit_exceeded` 409 (живых броней гостя или очередей больше предела), `booking_expired` 409, `booking_not_active` 409, `payment_pending` 409 (старт до предоплаты), `already_paid` 409, `too_early` 409, `table_free` 409 (очередь на свободный стол), `offer_expired` 409, `idempotency_conflict` 409, `rate_limited` 429, `not_configured` 501 (нет функции соседа).

## События outbox

`booking.created`, `booking.confirmed`, `booking.reserved`, `booking.started`, `booking.expired`, `booking.canceled` — `{booking_id, club_id, resource_id, user_id, status, starts_at, ends_at, …}`; `waitlist.offered`, `waitlist.accepted` — `{waitlist_id, club_id, resource_id, user_id, offer_until | hold_until}`. SSE (№120): имя события SSE — только `[a-z0-9_]`, поэтому вид события — в поле `type`. `club:{id}` `booking` — `{type: 'booking.*', booking_id, …}`; гостю `user:{id}` `booking` — `{type: 'booking.confirmed'|'booking.reserved'|'booking.started'|'booking.expired'|'booking.canceled', id, status, starts_at, ends_at, resource: {id, number}}`; `user:{id}` `waitlist` — `{type: 'waitlist.offered', offer_id, resource: {id, number, title}, expires_at}`, `{type: 'waitlist.accepted', offer_id, resource, hold_until}`, `{type: 'waitlist.updated', …запись}`; у записи `close_reason`: `expired` | `released` | `declined` | `accepted` | `canceled` | `table_taken` (стол заняли при принятии — запись снова в очереди); кода стола нет (№119). Журнал: `booking.create`, `booking.confirm`, `booking.reserve`, `booking.start`, `booking.arrive`, `booking.cancel`, `manual.booking_cancel`, `booking.expire`, `booking.complete`, `booking.late_payment`, `booking.pay_timeout`.

## Настройки клуба (`clubs.settings`)

`booking_prepayment` (`none`/`deposit`/`full`, по умолчанию `none`), `booking_deposit_kopecks` (50 000), `booking_free_cancel_minutes` (120), `booking_min_minutes`/`booking_max_minutes` (60/240), `booking_step_minutes` (30), `booking_lead_minutes` (15), `booking_max_days` (30), `booking_pay_minutes` (15), `booking_hold_minutes`/`booking_hold_prepaid_minutes` (15/30), `booking_early_max_minutes` (120), `booking_early_free_minutes` (5), `booking_max_open_per_guest` (3). Процент удержания — `club_payment_settings.booking_forfeit_percent` (money).

## Тесты

```sh
DATABASE_ADMIN_URL=postgres://supabase_admin:…@127.0.0.1:PORT/postgres \
  node --test --test-concurrency=1 "server/bookings/test/db/*.test.mjs"
```

`test/db/harness.mjs`: временная база, настоящий `createApp` (роутер, outbox, уведомления, журнал), настоящий сервис light без MQTT (`startFromBooking`, `setReserved`, `holdPending` …), заглушка money с журналом вызовов, поддельные часы. CI подхватывает каталог сам (`scripts/ci-test-db.mjs`).

## Правки по ревью M3 (№128, №129)

- Бронь не принимается, пока на столе ждёт оплаты котировка (старт или продление), конец которой с зазором 5 минут заходит в её интервал (`booking_conflict`). Источник — `payments.pendingPlayUntil(db, {resourceId, now})`, если money его даст; до этого — чтение `bl.quotes`/`bl.payments` в точке сохранения.
- Сгорание: если в окне удержания стол был недоступен гостю (чужая игра, сервис, чужой pending или reserved, без связи, неактивен, бронь не показалась на столе) — `expire_reason = 'table_unavailable'` (миграция 0601), `forfeitPrepayment(percent: 0)`, тревога `booking_table_unavailable`. Проверка — на каждом тике в окне и по истории сессий и удержаний при сгорании; связь со столом и остальное по истории — `light.availabilityDuring(db, {resourceId, from, to, userId, source: 'booking', refId})` → `{unavailable, reasons, intervals}` (своё удержание и игра гостя не в счёт; `from = to` — «сейчас»), пока её нет — статус стола light. Тревоги `booking_table_unavailable` и `booking_step_failed` склеиваются по брони (`dedupeKey: booking:{id}`).
- `reserved` ставится, только если `setReserved` показал бронь на столе (`applied`); иначе — повтор на следующих тиках. `clearReserved` — с `source` и `refId` (своё удержание).
- «Гость пришёл» — только бронь `phone`/`staff` без предоплаты и только в окне [начало − `booking_early_max_minutes`, начало + удержание); иначе `403`.
- Доплата при старте: повтор старта отдаёт ту же живую котировку, оплаченную без подтверждения — `payment_pending`; лишняя оплаченная доплата при идущей игре возвращается целиком (журнал `booking.extra_refund`, уведомление гостю).
- Удержание не длиннее брони; старт после конца брони — `booking_expired`.
- Лимит живых броней гостя — под `pg_advisory_xact_lock` (клуб, гость).
- Планировщик: шаг брони, падающий раз за разом, ставится на паузу (10 с → 10 мин), после 5 неудач подряд — тревога `booking_step_failed`.
- Очередь: принятое предложение без игры после удержания оплаты — `expired` и предложение следующему; столы с очередью без предложения планировщик проверяет сам (кроме 10 минут после снятия удержания ресепшном); блокировки — всегда стол, затем запись.

## M4: бронь на двоих и турниры

- `createBooking(db, { userId, resourceId, startsAt, minutes, participants, source? })` (`api.mjs`) — для «Сыграем?» Бильярдум+: участники (до 3, миграция 0602 `bookings.participants`) видят бронь в `GET /api/me/bookings` (`my_role: 'participant'`, `participants_count`), могут начать игру у стола (платит начавший), получают уведомления брони; платит и отменяет владелец. Через HTTP участников не передать.
- Брони не принимаются на интервалы `tournamentHolds(db, { resourceId, from, to })` (`server/tournaments/api.mjs`, необязательная зависимость) — `409 table_busy {reason: 'tournament', busy_until}` (Д7 приёмки M4; `busy_until` — конец окна вместе с примыкающими удержаниями матчей; проверка раньше пересечения с бронями); ранний приход по брони, если до её начала на столе турнир, — то же; в доступности такие интервалы — `kind: 'tournament'`.
- Необязательные шаги (уведомления, данные соседей) — в точке сохранения (`safely`): ошибка соседа не оставляет транзакцию в состоянии ошибки, при котором COMMIT молча стал бы ROLLBACK.

## M5.8: бронь корта блоками слота (№204)

- Корт (`resourceBilling` тарифов: `billing: 'slot'`) бронируется на 1…N слотов: `minutes` кратно слоту, от слота до
  `booking_max_minutes` (округлённого вниз до слота, но не меньше слота); иначе — `400 bad_request`. Начало — по сетке брони клуба
  (`booking_step_minutes`). Цена — по тарифу слотов (граница расписания внутри брони — по минутам). Корт без правил слота — `409 no_tariff`.
- Доступность: у ресурса — `kind`, `family`, `slot_minutes` (у стола `null`); в `rates` корта — `per_slot_kopecks` и `slot_minutes`
  (точная цена — по цене слота, `per_hour_kopecks` у корта справочная). Ресурсы — столы, затем корты.
- Тексты уведомлений — «корт 1», «на корте 1»; очередь — «Корт 2 свободен…», «Занять корт».
- Очередь: `resource` в `GET /api/me/waitlist`, ответе `POST /api/waitlist` и SSE `waitlist.offered`/`waitlist.accepted` — `{id, number, title, type, family}`.
