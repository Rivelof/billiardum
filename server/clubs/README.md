# Подключение клуба без выезда (`server/clubs`, M5.1 backend-A)

Контракт — `docs/contracts/m5-1.md` (решения №152, 153, 154, 160). Модуль `clubs` в `server/http/app.mjs` (последним), маршруты — `api/routes/clubs.mjs`, миграции `supabase/migrations/1000–1003`.

| Файл | Что делает |
|---|---|
| `service.mjs` | создание клуба (`bl.create_club`), мастер `GET …/onboarding` (шаги и чек-лист), переход в live (`bl.club_go_live`), приостановка платформой (`bl.club_suspend`, `bl.club_resume`), карточка каталога при live (`linkCatalogCard`, outbox `club.went_live`) |
| `shops.mjs` | магазины ЮKassa `test` и `live`: проверка `GET /v3/me`, маска секрета, правка в live — ручное действие; проверочный платёж 1 ₽ с возвратом; тревога «вебхук ЮKassa не настроен» |
| `neighbors.mjs` | функции backend-B для чек-листа: `resources.activeCount`, `tariffs.coversWeek`, `qr.printedAt` — из `server/setup/index.mjs`, пока его нет — запасные (TODO backend-B) |
| `index.mjs` | `init(ctx)`, `stop()`: подписка outbox `club.went_live`, планировщик раз в 15 с (`bl.onboarding_due`) |

## Режим клуба (`clubs.mode`, №153)

`test` | `live` | `suspended`. Новый клуб пользователя — всегда `test`; клубы, заведённые администратором базы (сид, тесты, клубы до M5.1), — `live` (значение столбца по умолчанию; `app_api` клубов не вставляет). Режим меняют только узкие функции: владелец — `test → live` (`bl.club_go_live`), Андрей (`platform_admin`) — приостановка и возобновление в `test` или `live`. Обратно в `test` клуб сам не переходит.

В запросе: `ctx.clubMode` (роутер; в транзакции — `app.club_mode`, ставят `withContext`, `setContext` и `enterClub` модулей). В базе опираться на `bl.ctx_club_mode()` (по таблице клубов), а не на `app.club_mode`. Отклонение от §3 контракта: `ctx.club` остаётся строкой UUID (как во всех модулях), режим — отдельным полем `ctx.clubMode`.

### Тестовые записи (`is_test`)

Ставит триггер `bl.set_is_test()` при вставке (присланное значение игнорируется, изменить нельзя — `bl.is_test_guard`), по режиму клуба в этот момент (`test` или `suspended` после `test`):

| Таблица | Откуда признак |
|---|---|
| `sessions`, `payments`, `orders`, `pos_sales`, `shifts`, `bookings`, `tournaments` | режим клуба |
| `refunds` | платёж (`payments.is_test`) |
| `receipts` | платёж, иначе возврат, иначе режим клуба (продажа кассы без платежа) |
| `tournament_entries` | турнир |
| `matches` | турнир (турнирная партия), иначе сессия, иначе режим клуба |

После перехода в `live` старые записи остаются тестовыми. Тестовые записи не входят:

- в отчёт смены, выручку списка смен, наличные смены, «Сейчас» владельца и утреннюю сводку (`server/reports/queries.mjs`: `shiftPayments`, `shiftRefunds`, `playStats`, `REVENUE_TOTAL_SQL`; `server/shifts/service.mjs` `cashTotals`; `api/routes/owner.mjs`); сверка онлайн — только боевой магазин; клубу в `test` утренняя сводка не отправляется;
- в рейтинг и достижения (`server/plus/service.mjs`: тестовая партия остаётся `confirmed`, Эло не считается; достижения — без тестовых сессий и партий);
- в каталог и публичные страницы: `bl.public_clubs()` — только `live`; карточка `platform` клуба не в `live` показывается как без программы (`server/directory/public.mjs`); турниры `is_test` — не в афише (`server/tournaments/service.mjs`).

Журнал пишется как обычно. Смена ККТ в `test` не открывается, отчёт о закрытии смены — нефискальный «ТЕСТ» (`server/kkt/README.md`, миграция 1003 `kkt_ops.is_test`). Касса ресепшена в `test`: чек продажи (`receipts.is_test`) уходит мосту ККТ нефискальным документом «ТЕСТ» (`server/kkt/atol-task.mjs` `testReceiptTask`, задание с `test: true`), закрывается `printed` без ФД (`fiscal.test = true`, журнал `kkt.receipt_test_printed`). Онлайн-оплаты в `test` идут в тестовый магазин клуба.

`suspended`: новая игра не начинается — `409 club_suspended` у `POST /api/quotes` (kind `start`), депозита на ресепшене и брони (гость и ресепшн). Оплаченная игра доигрывает (инвариант 3), продление идущей игры работает. `GET /api/t/{code}` отдаёт `club.mode` (плашка «Тестовый режим клуба — деньги не списываются»), `GET /api/me` — `clubs[].mode`.

## Магазины ЮKassa (№154)

Пары: `live` — прежние `club_payment_settings.shop_id`, `secret_key_enc` (контекст шифрования `yookassa_secret/<club_id>`), `test` — `test_shop_id`, `test_secret_key_enc` (контекст `yookassa_secret/<club_id>/test`). Какая пара работает: новый платёж — по режиму клуба; всё о существующем платеже (вебхук, сверка, списание, возврат, чек зачёта) — по `payments.is_test` (`server/payments/settings.mjs`: `loadPaymentSettings(db, club, { mode | isTest })`). Вебхук один на клуб: пара — по нашей записи, неизвестный объект ищется в обоих магазинах.

Сохранение пары проверяет `GET /v3/me`: `account_id` = `shop_id`, у `test` — `test: true`, у `live` — `test: false` и `fiscalization_enabled: true`. Иначе ничего не сохраняется. Ответы — без секрета, маска `{last4, length}`. Клуб в `live` (или приостановлен после `live`): правка — ручное действие (`ctx.manual`: причина, `manual.payment_settings`, тревога `manual_action` владельцу); в `test` — журнал `club.payment_settings`.

Проверочный платёж 1 ₽ (`bl.shop_checks`, не в `bl.payments` и не в отчётах): чек продажи и возврата формирует ЮKassa (receipt в запросе, телефон владельца). Подтверждение — вебхуком или сверкой планировщика; затем возврат (ключ `chk-ref-<id>`). Платёж (проверочный или гостя) подтверждён сверкой, а вебхука по нему нет 10 минут — тревога `yookassa_webhook_missing` (одна на пару клуба; для платежей гостей окно — час после подтверждения).

## Чек-лист и `go-live` (№160)

`checklist(db, {clubId, now, neighbors})` → `{items: [{id, ok, detail}], ready}`; пункты: `tables`, `devices` (контроллер у каждого стола в работе, на связи за 10 минут), `tariffs`, `shop_live` (при переходе — перепроверка `GET /v3/me`), `kkt` (касса ресепшена включена → мост на связи за 10 минут и `last_status.fiscal = true`; выключена — пункт выполнен), `stickers`, `offer`. `detail` — короткий текст по-русски или `null`.

Переход: `409 checklist_incomplete {failed}` или `bl.club_go_live` (оферта `CLUB_OFFER_VERSION`, по умолчанию `2026-10-23`), журнал `club.go_live`, outbox `club.went_live`, уведомление Андрею и операторам. Обработчик outbox в контексте платформы связывает карточку: своя (`club_id`) → `platform`; `clubs.listing_id` (одобренная заявка) → `platform` и `club_id`; иначе создаётся карточка в городе клуба; города нет в справочнике — уведомление операторам `platform.club_city_required` (журнал `club.card_city_required`).

## API

| Маршрут | Кто | Ответ |
|---|---|---|
| `POST /api/clubs {name, city_id \| city_name, timezone, listing_id?}` | вошедший с телефоном | `201 {club_id, mode: 'test'}`; `409 clubs_limit`; `404` — карточка недоступна; без `city_id` пояс обязателен |
| `GET /api/clubs/claimable-listings` | вошедший | `{items: [{listing_id, name, address, city, city_id, timezone}]}` |
| `GET /api/clubs/{club}/onboarding` | владелец, управляющий | `{club, mode, steps: [{id, done}], checklist, payment_checks: {test, live}, shops: {test, live} (только владельцу, управляющему — null), payment_settings, kkt_enabled, webhook_url, offer: {version, accepted_at, accepted_version}, day_start_local, hall}` |
| `POST /api/clubs/{club}/go-live {accept_offer: true}` | владелец | `{mode: 'live', went_live_at}`; `409 checklist_incomplete {failed}`; `409 club_suspended` |
| `GET /api/clubs/{club}/payment-settings` | владелец | `{settings: {reception_enabled, sbp_enabled, card_enabled, vat_code, tax_system_code}, shops: {test, live}}` |
| `PATCH /api/clubs/{club}/payment-settings {…, reason?}` | владелец | `settings`; в live — причина обязательна (ручное действие) |
| `GET \| PUT /api/clubs/{club}/payment-settings/{test\|live} {shop_id, secret_key?, reason?}` | владелец | `{mode, shop_id, secret_mask: {last4, length}, verified_at, test, fiscalization, account_id}`; `400 shop_invalid`, `shop_mode_mismatch`, `fiscalization_off`, `reason_required`; `503 yookassa_unavailable` |
| `POST /api/clubs/{club}/payment-settings/{test\|live}/check` | владелец | `201 {payment_id, status, confirmation_url}`; `409 not_configured` |
| `POST /api/platform/clubs/{club}/suspend {reason}`, `…/resume {reason, mode?}` | `platform_admin` | `{club_id, mode, changed}` |

`steps[].id`: `club`, `hall`, `tariffs`, `menu`, `staff`, `payments` (тестовый магазин проверен, проверочный платёж прошёл и вебхук пришёл), `devices`, `stickers`, `test` (была тестовая игра), `go_live`. `payment_checks[mode]` — `{payment_id, status, refunded, refund_status, webhook_at, confirmed_at, confirmed_via, confirmation_url, created_at}` или `null`.

`ctx.manual(entry)` (роутер, `server/lib/manual.mjs`) — ручное действие для модулей M5.1 (тарифы и столы backend-B): `{action: 'manual.*', reason, objectType?, objectId?, data?, text, level?}` → журнал и тревога владельцу; без причины — `400 reason_required`.

## Тесты

- `npm test -w @billiardum/server` — `clubs/test/clubs-unit.test.mjs`: коды ошибок и `failed`, маска и контексты шифрования, `GET /v3/me` на эмуляторе (все отказы), `ctx.manual`, «ТЕСТ» для ККТ, подмена соседей.
- `npm run test:db` — `clubs/test/db/clubs.test.mjs` (Postgres и эмулятор ЮKassa): создание и лимит (в том числе гонка 5 запросов), листинг только своей одобренной заявки, права `app_api` на режим, `ctx.clubMode`, `is_test` и наследование, исключение из отчётов, магазины и маска, роли, ручное действие в live, проверочный платёж с вебхуком и без (тревога через 10 минут), тревога по платежу гостя, чек-лист (контроллеры, ККТ), go-live с карточкой каталога, приостановка и возобновление, нефискальный чек ККТ.
