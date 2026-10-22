# Бар и касса M2: заказы, касса POS, счёт стола (backend-pos)

Контракт — `docs/contracts/m2.md` §1, §3–§5; решения №76, №79–83; инварианты 7, 8, 10. Папки backend-pos: `server/orders/` (этот модуль), `server/catalog/`, `server/stock/`, маршруты `api/routes/{orders,pos,catalog,stock}.mjs`, миграции `supabase/migrations/0400–0430`, сид `supabase/seed.d/0400_pos.sql`.

ЮKassa проверена **только на эмуляторе** (`tools/yookassa-emu/`); QR для СБП на кассе — через тестовый прокси (эмулятор M1 знает только `redirect`, см. «Что нужно от соседей»).

## Файлы

| Файл | Что внутри |
|---|---|
| `index.mjs` | `init(ctx)`/`stop()`: подписки outbox `payment.confirmed` (`pos.settle`) и `payment.canceled` (`pos.cancel`), подстраховка — планировщик раз в 10 с (`bl.pos_due`) |
| `api.mjs` | `openTab(db, sessionId)` → `{orders, total_kopecks}` (контракт §5); `shiftLinkProblems(db, {clubId})` — сверка №92: `shift_id` продаж и возвратов указывает на смену своего клуба |
| `service.mjs` | заказ со стола, статусы, экран бара, счёт стола, оплата счёта |
| `pos.mjs` | продажа кассы, оплата гостем, завершение и отмена, двойная оплата, возврат |
| `payments.mjs` | платежи бара — только функции money `server/payments/api.mjs`: `recordOfflinePayment` (наличные, терминал), `createOnlinePayment` (СБП/карта, redirect и QR), `refund` с позициями чека возврата |
| `money.mjs` | копейки: скидка, раскладка по строкам, позиции чека, доли возврата (чистые функции) |
| `core.mjs`, `settings.mjs`, `deps.mjs`, `errors.mjs`, `route.mjs` | контекст клуба и виды API, настройки кассы клуба, зависимости, ошибки, обёртка маршрутов |

## Модель (миграции)

- `0400_pos_catalog.sql` — `platform_settings` (без клуба; `qr_alcohol_allowed`, у `app_api` только чтение), `product_categories`, `products`, `modifier_groups`, `modifiers`, `product_modifier_groups`.
- `0410_pos_payments.sql` — **правка таблицы money** `bl.payments`: `kind` += `bar`; для `bar` нет стола, гостя, минут и котировки (`resource_id`, `user_id` — NULL допустим только у `bar`).
- `0420_pos_orders.sql` — `orders`, `order_items` (снимок цены, модификаторов, НДС, предмета расчёта; `position` — порядок строк), `pos_sales`, `pos_sale_items`, `pos_sale_requests`, `pos_refunds`; триггеры `orders_guard` (отмена конечна, оплаченный заказ — только возвратом, оплата ставится один раз), `pos_sales_guard`; узкие функции `bl.pos_object_club(kind, id)` и `bl.pos_due(limit)` (`SECURITY DEFINER`, владелец `bl_definer`).
- `0430_pos_stock.sql` — `stock_movements` (только INSERT), `stock_audits`.

Все таблицы с `club_id`: `ENABLE` + `FORCE RLS` по `bl.ctx_club_id()`; у `app_api` нет `DELETE`/`TRUNCATE`; суммы и состав после вставки не меняются (права по столбцам).

## Заказ со стола и счёт стола

- `POST /api/orders` (гость, телефон и согласие, `Idempotency-Key`): участник идущей сессии (`active`, `ending`, `grace`), `{session_id, items: [{product_id, qty, modifier_ids?}], pay: tab|online, method?: sbp|card, comment?}` → `201 {order, payment?}`.
  - `tab` — заказ сразу на экране бара (`committed_at`), склад списан; предел счёта — `pos_tab_limit_kopecks`.
  - `online` — платёж ЮKassa (`confirmation.redirect`, `return_url` `https://{PUBLIC_HOST}/app/orders/{order_id}`), заказ на экране бара только после оплаты.
  - Алкоголь (`is_alcohol`) со стола — `404 not_found`, даже прямым запросом, пока `qr_alcohol_allowed` выключен (№76). Стоп-лист и «кончился» — `409 stop_list`.
- Статусы (`POST /api/orders/{id}/status`, ресепшн и выше): вперёд `new → preparing → ready → served` (можно пропускать), `canceled` — с причиной; отмена заказа, который уже в счёте или на экране бара, — тревога `order_canceled` владельцу (ручное действие); оплаченный заказ — `409 already_paid` (только возврат). Гость статусы не меняет (`403`).
- Счёт стола (№79) — заказы `pay_mode = tab`, не оплаченные и не отменённые; живёт после закрытия сессии. `GET /api/sessions/{id}/tab` (участник или персонал) → `{orders, total_kopecks, pending_payment}`; `GET /api/clubs/{club}/tabs` — открытые счета клуба.
- `POST /api/sessions/{id}/tab/pay` (`Idempotency-Key`): гость — `{method: sbp|card}` → платёж ЮKassa (`return_url` `/app/sessions/{id}/tab`); ресепшн — `{method: cash|card_terminal, received_kopecks?, discount?}` или `{method: sbp, at_reception: true}` → продажа кассы со счётом этого стола.
- Двойная оплата: два гостя одновременно — один платёж (блокировка счёта, тот же платёж для того же состава в течение 15 минут); две кассы одновременно — вторая `409 already_paid` (строки заказов `FOR UPDATE`); наличные на кассе, пока шла онлайн-оплата, — онлайн-платёж при подтверждении возвращается (ЮKassa, чек возврата), тревога `bar_double_payment`.
- SSE после коммита: `bar` в `club:{id}` (заказ, который видит бар), `order` в `session:{id}`, `pos_sale` в `club:{id}` (продажа завершена или отменена).

## Касса (`POST /api/pos/sales`, ресепшн и выше, `Idempotency-Key`)

Тело: `{items?, tabs?: [session_id], requests?: [reception_request_id], discount?: {percent | amount_kopecks, reason?}, method: cash|card_terminal|sbp, received_kopecks? (cash), customer_phone? (sbp), to_bar?, comment?}`.

- Без открытой смены (`currentShift` kkt) — `409 shift_closed` (для всех способов; возврат наличных — тоже).
- Скидка: в пределах `pos_discount_limit_percent` (по умолчанию 10 %) — ресепшн; выше — только управляющий и выше с причиной (`limit_exceeded`, `reason_required`), журнал `manual.discount`, тревога `discount_over_limit` владельцу (№82). Скидка раскладывается по строкам до копейки; строка не дешевле копейки за единицу.
- `cash`: `received_kopecks ≥ сумма`, сдачу считает сервер; `card_terminal` — сразу; `sbp` — платёж ЮKassa с `confirmation.type = qr`, ответ `status: pending` и `confirmation {type: qr, confirmation_data}`; завершение по `payment.confirmed` (или `GET /api/pos/sales/{id}`, сверка с ЮKassa через 10 с). Контакт для чека ЮKassa — `customer_phone` или `pos_receipt_email` клуба (`phone_required`).
- Заявки стола M1 (`requests`) принимает **функция ресепшена money** `acceptRequest` (её платёж `start`/`extend`, её чек ККТ, её `payment.confirmed` для света); СБП для заявки — `400` (money принимает наличные и терминал). Наличные: заявке — её сумма, сдача — у последнего платежа.
- Завершение (`completeSale`): заказы оплачены, склад `sale`, чек бара — `enqueueReceipt` kkt (`sell`; без модуля kkt — строка `bl.receipts` `receipt_pending`), outbox `sale.completed`, журнал `pos.sale`, SSE.
- Стоп-лист переключает ресепшн и выше: `POST /api/catalog/products/{id}/stop-list {stop_list}` (№88, журнал `catalog.stop_list`); цены и состав — управляющий.
- `GET /api/pos/sales/{id}`, `GET /api/clubs/{club}/pos/sales` — продажа и список; `GET|PATCH /api/clubs/{club}/pos/settings` — настройки (изменение — владелец, журнал `pos.settings`).

## Волна B (decisions №95, №97, №98)

- **Скидка по PIN управляющего (№95):** `GET /api/clubs/{club}/staff/approvers` → `[{user_id, name, role}]` (управляющие и владельцы с PIN); `POST /api/pos/discount-approvals {user_id, pin, reason_code, reason_text, percent | amount_kopecks}` → `201 {approval_id, expires_at}` — PIN проверяет core `checkStaffPin` (своя транзакция, общая блокировка 5 ошибок → 15 минут; 401/403/429). Подтверждение одноразовое, 5 минут, таблица `bl.pos_discount_approvals` (миграция 0440); в продаже `discount: {percent|amount_kopecks, approval_id}` — та же скидка, иначе `403 forbidden`; журнал `pos.discount_approval` и `manual.discount` — от имени управляющего с его причиной, тревога `discount_over_limit` владельцу.
- **Отмена неоплаченной СБП-продажи (№98):** `POST /api/pos/sales/{id}/cancel {reason?}` (ресепшн и выше) — продажа и ждавшие её заказы отменены, QR снят (платёж ЮKassa в `pending` через API не отменяется — истечёт сам); оплата, пришедшая после отмены, возвращается автоматически (`refund` money, `pos_refunds.kind = late`, тревога `bar_late_payment`; планировщик `bl.pos_due` — подстраховка). Оплаченная — `409 already_paid`.
- **Ответ продажи:** `receipt_status`, `receipt_fd`, `receipt_fp` из `bl.receipts` (после пробития ККТ).
- **Роль `bar` (№97):** очередь бара, статусы заказов (без отмены), стоп-лист (SSE `stop_list` в `club:{id}`), меню персонала; без кассы, возвратов, счетов, настроек.

## Возврат (`POST /api/pos/sales/{id}/refund`, управляющий и выше, `Idempotency-Key`)

`{reason, items?: [{order_item_id, qty}]}` (без `items` — всё оставшееся). Сумма единиц — доли строки после скидки (`money.mjs`, все возвраты строки в сумме дают строку до копейки). Деньги — функция `refund` money с позициями чека возврата: наличные и терминал — `bl.refunds` `manual` и чек возврата ККТ (`receipt_pending`), СБП и карта — возврат ЮKassa с чеком; журнал и outbox `payment.refunded`, уведомление — у money. Склад — `return`; журнал `pos.refund` с причиной; тревога `pos_refund` (критично, владельцу сразу). Ресепшн — `403`, без причины — `reason_required`, больше проданного — `limit_exceeded`, всё возвращено — `already_paid`.

## События и интерфейсы

- outbox `sale.completed`: `{sale_id, club_id, channel: pos|guest, payment_id, method, amount_kopecks (бар + столы), bar_kopecks, tables_kopecks, table_payment_ids, discount_kopecks, shift_id, completed_at}`.
- Задание на чек: `enqueueReceipt(db, {clubId, kind: sell|sell_refund, lines, payments: [{method: cash|electronically, amount_kopecks}], operatorName, paymentId, saleId, refundId?})`; `lines` — позиции в формате `bl.receipts.items` M1 (как ЮKassa: `description`, `quantity`, `amount.value` — цена единицы, `vat_code`, `payment_mode: full_payment`, `payment_subject`).
- Журнал: `order.create`, `order.status`, `order.cancel`, `tab.pay`, `pos.sale`, `pos.discount`, `manual.discount`, `pos.sale_canceled`, `pos.refund`, `payment.refunded`, `pos.settings`, `catalog.*`, `stock.*`.
- Тревоги: `discount_over_limit` (важно), `order_canceled` (важно), `pos_refund` (критично), `bar_double_payment` (важно) — все с текстом уведомления.

## Настройки клуба (`clubs.settings`)

`pos_discount_limit_percent` (10), `pos_stop_at_zero` (false), `pos_tab_limit_kopecks` (null), `pos_receipt_email` (null). Настройка платформы `bl.platform_settings.qr_alcohol_allowed` (false) — меняет только суперпользователь (README 0400).

## Тесты

```sh
node --test server/orders/test/*.test.mjs server/catalog/test/*.test.mjs server/stock/test/*.test.mjs   # без базы
DATABASE_ADMIN_URL=postgres://supabase_admin:…@127.0.0.1:55436/postgres \
  node --test --test-concurrency=1 "server/orders/test/db/*.test.mjs"                                     # временные базы bl_test_*
```

`test/db/harness.mjs` — настоящий `createApp` (роутер, outbox, тревоги, журнал), маршруты вход/бар/касса/склад/ресепшн/вебхук, модуль заказов, эмулятор ЮKassa за прокси с `confirmation.type = qr`; соседи M2 по контракту: `currentShift` — открытая смена из `bl.shifts` (kkt 0510), `enqueueReceipt` — строка `bl.receipts` и журнал вызовов. Файлы: `pos` (касса, смена, скидка, заявка стола, СБП, возврат, 20 продаж до копейки), `orders` (заказ со стола, алкоголь, статусы и права, онлайн-оплата, счёт стола и гонки), `catalog` (меню, управление, CSV, склад, ревизия, стоп-лист), `rls` (RLS, права, триггеры, узкие функции, ограничения `bl.payments`).
