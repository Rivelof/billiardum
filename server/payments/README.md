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

Телу не верим: берётся только `object.id` (и вид события — платёж или возврат). Платёж запрашивается `GET /v3/payments/{id}` ключами клуба из пути, сверяются `id`, сумма (у заморозки после списания — не больше заморожённой), валюта `RUB`, `metadata.club_id`, `metadata.quote_id`; расхождение — тревога `payment_mismatch` (critical) и никаких действий. `succeeded` или `waiting_for_capture` — в одной транзакции: статус, `confirmed_at` (ставится один раз, триггер `payments_guard`), журнал `payment.succeeded`, outbox `payment.confirmed` (§13). `canceled` — журнал `payment.canceled`, `releasePending`. Повтор вебхука — `200` без действий. ЮKassa недоступна или ответила 5xx — `503`, ЮKassa повторит. Неизвестный платёж: если у магазина клуба его нет — `200`; если есть с нашим `metadata` (запись ещё не закоммичена) — `503`.

Подстраховка от потерянных вебхуков: планировщик раз в 10 с сверяет по API платежи, которые больше минуты в `pending` (`bl.money_due`).

### Списание «Без лимита» и возвраты

- Подписка outbox `session.closed` (`money.capture`): заморозки сессии (`session_payments` light или `payments.session_id`) списываются на `amountForActual(started_at, min(ended_at, paid_until))` с чеком на фактическую сумму; остаток размораживается ЮKassa; лишние заморозки отменяются; уже списанное учитывается (идемпотентно). Журнал `payment.captured`. Не хватило заморозок — тревога `unlimited_overrun`.
- `server/payments/api.mjs` — `receiptStatus(db, { paymentIds })` для чека сессии (light, §14): `{ [paymentId]: pending | succeeded | receipt_pending | failed | canceled | none }` — действующий чек продажи (отменённый чек заморозки не в счёт), платежи чужого клуба — `none`.
- `server/payments/api.mjs` — `refund(db, { paymentId, amountKopecks, reason, key? })` для light: ЮKassa `POST /v3/refunds` с чеком возврата; незаписанная заморозка — отмена или списание за вычетом; наличные и терминал — возврат `manual` и задание на чек возврата ККТ. Не больше оплаченного, идемпотентно по ключу. Журнал `payment.refunded` с причиной, outbox `payment.refunded`, уведомление владельцу (инвариант 8).

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
