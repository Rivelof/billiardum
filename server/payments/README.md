# Деньги M1: тарифы, котировки, оплата, ресепшн (backend-money)

Контракт — `docs/contracts/m1.md` §5, §13; решения №23, №26, №43–48, №52, №54, №55. Папки: `server/tariffs/`, `server/payments/`, `server/reception/`, маршруты `api/routes/{quotes,payments,reception,webhooks}.mjs`, миграции `supabase/migrations/0200_money.sql`, `0201_holidays.sql`, сид `supabase/seed.d/0200_money.sql`, эмулятор `tools/yookassa-emu/` (свой README).

ЮKassa в этой среде проверена **только на эмуляторе**: `api.yookassa.ru` закрыт. Поля, которые нужно сверить с настоящим магазином, перечислены в `tools/yookassa-emu/README.md`.

## Тарифы (`server/tariffs/`)

`engine.mjs` — чистые функции, `index.mjs` — обёртки с `db` (контракт §13, money → light):

| Функция | Что возвращает |
|---|---|
| `pricesAround(db, { resourceId, at })` | `{ price_now: {price_per_hour_kopecks, until_local, until} \| null, price_next: {price_per_hour_kopecks, from_local, from} \| null }` |
| `amountFor(db, { resourceId, from, minutes, minimum = true, exact = false })` | `{ amount_kopecks, breakdown, minutes, step_minutes, min_minutes, ... }` |
| `amountForActual(db, { resourceId, from, to })` | то же и `actual_minutes` («Без лимита», `interrupted`) |

Правила расчёта:

- каждая реальная минута (по UTC) оценивается по правилу `bl.tariff_rules`, действующему в её **местное** время клуба (IANA); переход на летнее время не теряет и не добавляет минут;
- тип дня — по **рабочим суткам** клуба: сутки начинаются в `clubs.settings.day_start_local` (по умолчанию `06:00`), ночь Пт→Сб 00:00–06:00 — пятничная (№43); `days` правила — ISO-день рабочих суток;
- праздник из `bl.holidays` считается выходным: его рабочие сутки сопоставляются с правилами как день `clubs.settings.holiday_iso_day` (по умолчанию 7, воскресенье);
- интервал правила `start_local`–`end_local`; `end ≤ start` — через полночь, `end = start` — круглые сутки; интервал, пересекающий начало рабочих суток (04:00–08:00), принадлежит суткам, в которых начался;
- одна минута — одно правило: сначала правило конкретного стола, затем больший `priority`, затем более новое;
- сумма = Σ цена часа / 60 по минутам, округляется **один раз** до `clubs.settings.price_rounding_kopecks` (по умолчанию 100) «половина вверх» (№44); разбивка — отрезки с одной ценой, их суммы — разности округлённых нарастающих итогов (кратны округлению и в сумме дают итог);
- шаг и минимум — из правила минуты начала: оплачиваемые минуты = вверх до шага, не меньше минимума (минимум — для старта и «Без лимита», не для продления); фактические минуты — начатая минута целая (доли секунды отбрасываются);
- минута без правила: в котировке — ошибка `no_tariff` (клуб «закрыт» по тарифу), в фактической сумме — по соседнему правилу (игра уже шла).

## Маршруты

| Метод и путь | Кто | Суть |
|---|---|---|
| `GET /api/t/{code}` | без входа, 120 в минуту с IP (`rateLimit` роутера, §14: гости клуба за общим NAT; от перебора защищает длина кода) | клуб, стол, статус (light), цены сейчас и дальше, `options` (`unlimited` — если у клуба есть СБП или карта), `my_session_id` |
| `POST /api/quotes` | гость, `requires: phone, consent` | `{quote_id, amount_kopecks, minutes, valid_until, breakdown}`; `start` — `holdPending` на 3 минуты (второй гость — `409 table_pending`); `extend` — от `paid_until`, любой участник (`getSessionForExtend`); `minutes: null` — дополнительно `unlimited: {hold_minutes, hold_amount_kopecks, sbp_block_minutes, sbp_block_amount_kopecks}` |
| `POST /api/quotes/{id}/pay` | гость, `idempotent` | `sbp`, `card` → `{payment_id, status, confirmation: {type: "redirect", url}}`; `reception` → `{reception_request_id, status: "waiting_reception"}` |
| `GET /api/payments/{id}` | плательщик | `{payment_id, status, session_id}`; платёж дольше 10 с в `pending` сверяется по API ЮKassa |
| `POST /api/webhooks/yookassa/{club_id}` | ЮKassa, `actor: system` | см. ниже |
| `GET /api/clubs/{club}/reception/requests` | ресепшн и выше | `[{id, resource_number, minutes, amount_kopecks, created_at, expires_at, guest_masked_phone}]` |
| `POST /api/reception/requests/{id}/accept` | ресепшн и выше, `idempotent` | `{method: cash \| card_terminal, received_kopecks?}` → `{payment_id, change_kopecks, session_id}` |
| `POST /api/reception/requests/{id}/decline` | ресепшн и выше | `{reason_code}` — `guest_left`, `guest_cancelled`, `payment_failed`, `table_problem`, `other` (иное — `bad_request`, пусто — `reason_required`) → `{ok: true}` |
| `GET /api/reception/requests/{id}` | гость, автор заявки | `{id, status, minutes, amount_kopecks, expires_at, payment_id, session_id, reason_code}` (`reason_code` — у отклонённой, иначе `null`) |

Ошибки — коды словаря §3 и `no_tariff` (`409`, нет тарифа на это время — дополнение к словарю). Ошибка модуля под роутером бросается (`status`, `code`): роутер откатывает транзакцию целиком, в том числе ключ идемпотентности, — повтор после сбоя ЮKassa выполняется заново.

## Оплата

- Платёж ЮKassa: `capture: true`, чек 54-ФЗ (позиция «Игра, стол N, X ч», `quantity: 1`, `vat_code` клуба, `payment_mode: full_payment`, `payment_subject: service`, `customer.phone` — телефон гостя без `+`, `tax_system_code` клуба, если задан), `metadata: {club_id, quote_id, kind, payment_id}`, `payment_method_data.type` `sbp` или `bank_card`, `return_url` = `https://{PUBLIC_HOST}/app/wait/{payment_id}` (или `PAYMENT_RETURN_URL`).
- `Idempotence-Key` ЮKassa детерминирован: `q-<quote_id>-<method>` (создание), `cap-`/`rel-<payment_id>` (списание и отмена заморозки), `r-…` (возврат). `Idempotency-Key` клиента хранится в `payments.request_key` и `reception_requests.request_key`.
- «Без лимита»: карта — `capture: false`, заморозка за `unlimited_hold_minutes` (120); СБП — блок `sbp_block_minutes` (30) одностадийно (№26), дальше гость продлевает блоками; ресепшн — в M1 предоплата за 120 минут как обычное время (депозит с возвратом остатка — вместе с ККТ, M2).
- Секрет магазина: `bl.club_payment_settings.secret_key_enc`, AES-256-GCM (`server/lib/secrets.mjs`), контекст `yookassa_secret/<club_id>`; расшифровывается только для запроса.

### Вебхук

Телу не верим: берётся только `object.id` (и вид события — платёж или возврат). Платёж запрашивается `GET /v3/payments/{id}` ключами клуба из пути, сверяются `id`, сумма (у заморозки после списания — не больше заморожённой), валюта `RUB`, `metadata.club_id`, `metadata.quote_id`; расхождение — тревога `payment_mismatch` (critical) и никаких действий. `succeeded` или `waiting_for_capture` — в одной транзакции: статус, `confirmed_at` (ставится один раз, триггер `payments_guard`), журнал `payment.succeeded`, outbox `payment.confirmed` (§13). `canceled` — журнал и outbox `payment.canceled` `{payment_id, club_id, kind, method, quote_id, resource_id, user_id, amount_kopecks, reason, previous_status}` (`previous_status`: `pending` — гость не оплатил, `waiting_for_capture` — заморозка снята), `releasePending` (только `start`). Повтор вебхука — `200` без действий. ЮKassa недоступна или ответила 5xx — `503`, ЮKassa повторит. Неизвестный платёж: если у магазина клуба его нет или `metadata` не наши — `200`; если есть с `metadata.club_id` этого клуба и нашим `payment_id` (или `quote_id`) — запись ещё не закоммичена, `503`.

Подстраховка от потерянных вебхуков: планировщик раз в 10 с сверяет по API платежи, которые больше минуты в `pending` (`bl.money_due`).

Платёж, которого ЮKassa не знает (404 на `GET /v3/payments/{id}`: сбой при создании, чужой магазин, перезапущенный эмулятор; `0653_money_not_found.sql`, `onProviderNotFound` в `pay.mjs`): первый 404 ставит `payments.provider_missing_at` и пишет `payment_not_found_at_provider` в лог один раз (дальше сверка молчит, `payment_reconcile_failed` не пишется). `pending` старше часа отменяется через `cancelLocal` с причиной `not_found_at_provider` (журнал, outbox `payment.canceled`, pending со стола снят, сессия и бронь не запускаются; поздний `succeeded` такой платёж уже не подтвердит) и тревога `payment_not_found_at_provider` (important, `action: canceled`) — один раз. Если у нас платёж уже `succeeded`/`waiting_for_capture` — не трогаем, только тревога (critical, `action: kept`), тоже один раз.

Оплачен после отмены у нас (находка B-L1, `late.mjs`, `0655_money_late_paid.sql`): любой платёж, отменённый локально (404, сгоревшая заявка, отмена по таймауту), который ЮKassa всё же провела. Вебхук отменённого платежа теперь тоже перезапрашивает его в ЮKassa; `applyRemote` при локальном `canceled` и удалённом `succeeded` делает возврат всей суммы с чеком возврата (позиции — из чека продажи; ключ `late-<payment_id>`, повтор не дублирует), при `waiting_for_capture` — отмену заморозки (`late-rel-<payment_id>`). Игра и бронь не запускаются (статус `canceled` окончательный, `payment.confirmed` не уходит). Тревога `payment_paid_after_cancel` (critical, `action`: `refunded` | `released` | `refund_failed`) и уведомление гостю `payment_returned` — один раз (`payments.late_paid_at`). ЮKassa недоступна — откат, повторит вебхук. Перед отменой по 404 сверка запрашивает платёж ещё раз; нашёлся — обычный путь `applyRemote`. Гонка вебхука со сверкой (B-R1): вебхук берёт строку платежа `FOR UPDATE`, а `applyRemote`, если `confirmPayment` не прошёл, перечитывает строку и при `canceled` уходит в тот же автовозврат.

### Списание «Без лимита» и возвраты

- Подписка outbox `session.closed` (`money.capture`): заморозки сессии (`session_payments` light или `payments.session_id`) списываются на `amountForActual(started_at, min(ended_at, paid_until))` с чеком на фактическую сумму; остаток размораживается ЮKassa; лишние заморозки отменяются; уже списанное учитывается (идемпотентно). Журнал `payment.captured`. Не хватило заморозок — тревога `unlimited_overrun`.
- Касса и бар (M2, `kind = 'bar'`, миграция pos `0410`): `createOnlinePayment(db, { clubId, saleId, method: sbp|card, amountKopecks, items, customer, confirmation: qr|redirect, returnUrl?, description, metadata?, phone?, userId?, resourceId?, requestKey? })` → `{ payment, confirmation }` (СБП по QR на экране кассы — `{type: 'qr', confirmation_data}`; id `stableUuid('bl.payment/bar/<sale>')`, ключ ЮKassa `bar-<sale>`, повтор — тот же платёж); `recordOfflinePayment(db, { clubId, saleId, method: cash|card_terminal, amountKopecks, receivedKopecks?, staffId, userId?, requestKey? })` → платёж `succeeded` со сдачей, без `payment.confirmed` (продажу завершает касса, чек ККТ ставит `server/kkt`). Общий путь создания платежа ЮKassa — `createYooKassaPayment` (`pay.mjs`), им же пользуется оплата стола.
- `server/payments/api.mjs` — `onlineMethodAvailable(db, { clubId, method })` → `boolean`: у клуба есть магазин ЮKassa и способ (`sbp` | `card`) включён; другой способ — `false`, неверный `clubId` — `bad_request`. Без платежа и без запросов к ЮKassa; касса зовёт до поиска гостя.
- `server/payments/api.mjs` — `receiptStatus(db, { paymentIds })` для чека сессии (light, §14): `{ [paymentId]: pending | succeeded | receipt_pending | failed | canceled | none }` — действующий чек продажи (отменённый чек заморозки не в счёт), платежи чужого клуба — `none`.
- `server/payments/api.mjs` — `refund(db, { paymentId, amountKopecks, reason, key?, items?, customer?, requestedBy?, description? })` для light и кассы (у платежа бара `items` — позиции чека возврата — обязательны, сумма позиций = сумме возврата): ЮKassa `POST /v3/refunds` с чеком возврата; незаписанная заморозка — отмена или списание за вычетом; наличные и терминал — возврат `manual` и задание на чек возврата ККТ. Не больше оплаченного, идемпотентно по ключу. Журнал `payment.refunded` с причиной, outbox `payment.refunded`, уведомление владельцу (инвариант 8).

## Ресепшн (`server/reception/`)

Заявка живёт `reception_request_minutes` (15) минут и держит стол в `pending` (`holdPending` до `expires_at`); SSE `reception_request` в `club:{id}` и `user:{id}` — после коммита. Принятие: платёж `cash` (сдача = полученное − сумма) или `card_terminal`, задание на чек ККТ `receipt_pending` в `bl.receipts` (мост ККТ — M2), журнал `reception.accept`, outbox `payment.confirmed`. Отказ — `reason_code` обязателен, журнал `reception.decline`, `releasePending`. Сгорание — планировщик (`bl.money_due`), `releasePending`, SSE.

## Таблицы (`0200_money.sql`, `0201_holidays.sql`)

`club_payment_settings` (магазин, НДС, СНО, способы оплаты, минуты заморозки, блока и заявки), `quotes`, `payments` (`provider_payment_id` уникален глобально, `quote_id` — один платёж на котировку), `refunds`, `reception_requests`, `receipts` (`yookassa` или `kkt`, `customer_phone` — контакт для чека списания и возврата), `holidays` (федеральные — `club_id NULL`, свой день клуба — с `club_id`). Все: `ENABLE` + `FORCE RLS` по `bl.ctx_club_id()`, владелец `bl_owner`; у `app_api` нет `DELETE`/`TRUNCATE`, `UPDATE` — только изменяемых столбцов (сумма, клуб, плательщик, способ оплаты неизменны). Узкие функции `SECURITY DEFINER` (владелец `bl_definer`): `bl.money_object_club(kind, id)` — клуб котировки, платежа или заявки по UUID; `bl.money_due(now, limit)` — заявки к сгоранию и платежи к сверке. Внешние ключи на `bl.sessions` — `0390_money_fks.sql` (light).

Праздники 2026–2027 — ст. 112 ТК РФ, постановления Правительства № 1466 от 24.09.2025 и № 1187 от 17.09.2026; следующий год — новой миграцией.

## Настройки

`YOOKASSA_API_URL` (в проде только `https://api.yookassa.ru/v3`), `YOOKASSA_TIMEOUT_MS` (10000), `PUBLIC_HOST`, `PAYMENT_RETURN_URL`, `DEV_ALLOW_ANY_MINUTES` (только не в проде, №54), `SECRETS_ENC_KEY`. Клуб: `clubs.settings.day_start_local`, `price_rounding_kopecks`, `holiday_iso_day`.

Разработка: `node server/payments/provision-dev.mjs` (или из `server/bin/provision-dev.mjs` core: `provisionPayments({ client, env, log })`) записывает магазин тестового клуба из `YOOKASSA_EMU_SHOP_ID`/`YOOKASSA_EMU_SECRET` (секрет шифруется `SECRETS_ENC_KEY`). Сид `seed.d/0200_money.sql`: настройки чеков тестового клуба (без секретов), `day_start_local`, округление и утро 06:00–12:00 (только разработка, чтобы сценарии шли в любое время).

## Тесты

- `node --test 'server/tariffs/test/*.test.mjs' 'server/payments/test/*.test.mjs'` — без базы: движок тарифов (47), клиент ЮKassa на эмуляторе, чек, настройки, разбор котировки, провижининг (21).
- `npm run test:db` — `supabase/tests/money_rls.test.mjs` (RLS, права, неизменяемость платежа, узкие функции, праздники) и `money_flow.test.mjs` (стол, котировки и гонка, оплата и идемпотентность, вебхук: подделка, повтор, сумма, чужой клуб, недоступная ЮKassa; «Без лимита»; ресепшн; возвраты; сверка). Соседи — заглушки по контракту (`money_harness.mjs`).

## M3: предоплата, пакеты часов, депозит (контракт m3.md §1 п. 5, 10, 11; №106, №108, №112)

Миграция `0650_money_m3.sql`: `payments.kind` += `booking`, `package`; `provider`/`method` += `balance`; поля `booking_id`, `package_id`, `balance_minutes`, `deposit`, `settlement_status` (`open` → `settled` | `forfeited`), `settled_kopecks`; `quotes.balance_minutes`; `receipts.settles_payment_id`, `settlement_kopecks`, `provider_receipt_id` (чек зачёта); `club_payment_settings.booking_forfeit_percent` (100); таблицы `tariff_packages`, `balance_lots` (минуты по покупкам со сроком), `balance_debits` (списания и их стоимость). `bl.money_object_club` знает `package`.

- **Лимит перед бронью** (`quotes.mjs`, №106): `nextBookingStart(db, { resourceId, after })` (bookings); играть можно до начала брони минус 5 минут — ответ котировки `extend_limit_until`, больше — `409 booking_conflict` (и для старта, и для продления; «Без лимита» замораживается только до брони). Депозитная сессия сама не продлевается (`bad_request`).
- **Чек зачёта** (`settle.mjs`): предоплата ЮKassa → строка `receipts` (`receipt_pending`) и outbox `money.receipt_settle` → `POST /v3/receipts` `{type: payment, payment_id, send: true, customer, items (full_payment), settlements: [{type: prepayment, amount}], tax_system_code}`, ключ `st-<receipt_id>`; отказ — `failed` и тревога `settlement_receipt_failed`. Наличные (депозит, пакет на кассе) → `kkt.enqueueReceipt` с оплатой `{method: 'prepayment'}` и `settlesPaymentId`.
- **Бронь** (`prepayments.mjs`, через `api.mjs`): `createPrepayment(db, { clubId, bookingId, resourceId, userId, amountKopecks, method?, returnUrl?, description?, requestKey? })` → `{ payment, confirmation }` (`returnUrl` — путь своего сайта «/app/…» или полный адрес на своём хосте с таким путём, иначе `bad_request`; та же проверка у `POST /api/packages/{id}/buy` в поле `return_url`, функция `ownReturnUrl` в `pay.mjs`; без значения — экран ожидания `/app/wait/{payment_id}`) (чек `full_prepayment`, outbox `payment.confirmed` с `kind: booking, booking_id`); `settlePrepayment(db, { paymentId, sessionId })` → чек зачёта; `forfeitPrepayment(db, { paymentId, percent?, reason })` → удержание `percent` % (по умолчанию настройка клуба) с чеком зачёта, остаток — возврат ЮKassa с чеком возврата предоплаты. Журнал `payment.settled`, `payment.forfeited`.
- **Пакеты** (`server/packages/`, `api/routes/packages.mjs`): список, создание и снятие (управляющий, причина, журнал `tariff.package_*`, уведомление владельцу), покупка гостем (`kind package`, чек `full_prepayment`; минуты начисляются в подтверждении платежа), баланс `GET /api/clubs/{club}/balance`. Котировка `use_balance: true` покрывает минуты балансом (`balance_minutes`, доплата за остальные); оплата `method: balance` (всё балансом, сразу подтверждено) или картой/СБП за остаток (минуты резервируются, отказ возвращает их). Чек зачёта — по платежу покупки, на долю цены пакета. Для соседей: `debitBalance(db, { userId, clubId, minutes, sessionId, paymentId? })`; касса pos: `packageSaleLine(db, { packageId })` и `creditPackageForSale(db, { payment, packageId, userId, index? })`.
- **Депозит** (`deposits.mjs`): `POST /api/reception/deposits` `{resource_id, amount_kopecks, received_kopecks?, user_id?}` (ресепшн, смена обязательна) — light `startFromDeposit`, затем `takeDeposit` (платёж cash `deposit`, сдача, чек ККТ `full_prepayment`, журнал `reception.deposit`; без `payment.confirmed`). Подписка `session.closed` (`money.deposit`) → `settleDeposit(db, { sessionId, usedKopecks })`: чек ККТ зачёта на сыгранное, остаток — возврат наличными (`refunds` manual, чек ККТ возврата предоплаты, уведомление ресепшену), идемпотентно. Наличные смены = размен + депозит − возврат.

Сверить с документацией ЮKassa: `POST /v3/receipts` (обязательность `send`, `customer`, формат `settlements`, можно ли несколько зачётов частями по одному платежу), `payment_subject` позиций предоплаты (`service` или `payment`). С бухгалтером: удержание при неявке — чек зачёта на удержанное.

### Возврат пакета часов (№118, миграция `0652_money_package_refund.sql`)

Только целиком и пока партия не тронута: из неё ничего не списано (иначе `409 package_used`), повтор — `409 already_refunded`. Партия отзывается (`minutes_left = 0`, `revoked_at`, `revoked_by`), журнал `manual.package_refund` с причиной, тревога `manual_action` владельцу.

- Пакет из приложения: `POST /api/packages/lots/{id}/refund` `{reason}` (управляющий, владелец) или `revokePackageLot(db, { lotId, reason, staffId })` → `{ lot_id, payment_id, amount_kopecks, refund_id }` — отзыв и возврат ЮKassa с чеком возврата предоплаты (ключ `pkr-<lot>`).
- Экран возврата: `GET /api/clubs/{club}/package-lots?phone=+7…` (управляющий, владелец) → `[{ id, package_id, title, source: app|pos, sale_id, idx, price_kopecks, minutes_total, minutes_left, created_at, expires_at, refunded_at, guest: { name, phone_masked } }]`. Только точный телефон (нормализация `normalizePhone`, как при входе: пробелы, скобки и дефисы убираются, `+` добавляется; частичный поиск — 400), гость — через узкую функцию `bl.money_lot_guest(phone)` (`0654`: id, имя, маска; только управляющему или владельцу клуба из контекста и только если у гостя есть партии в этом клубе), партии — под RLS клуба из пути; `sale_id`/`idx` кассовой партии — из `pos_sale_packages` (только чтение); `refunded_at` — `balance_lots.revoked_at`. Телефон наружу и в лог (`package_lots_lookup`) — только маской. Не чаще 30 в минуту на сотрудника (и 30 на IP у роутера) — `429 rate_limited`.
- Пакет, проданный на кассе (платёж `kind bar`): `revokePackageLot` отвечает `bad_request` — деньги возвращает pos своим возвратом, партию отзывает `revokeLotOnly(db, { lotId, reason, staffId })` → `{ lot_id, payment_id, amount_kopecks }` (те же проверки, журнал и тревога, без денег).

Чек зачёта через ККТ: `server/kkt` сам пишет `settles_payment_id` и `settlement_kopecks` (`enqueueReceipt` с `settlesPaymentId`, `settlementKopecks`) и отличает чек зачёта при повторе.
