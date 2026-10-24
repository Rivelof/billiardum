# Подписка клубов (`server/billing/`, M5.3)

Клуб в боевом режиме платит платформе за программу автоплатежом с карты владельца в **магазин ЮKassa платформы**. Это отдельный поток от денег гостей: свои таблицы (в `bl.payments`, отчёты и сводки клуба не входят), свой магазин (ключи только в `.env`), свой вебхук. Контракт — `docs/contracts/m5-3.md`, решения №180–186.

| Файл | Что делает |
|---|---|
| `config.mjs` | настройки из окружения; секрет магазина платформы — неперечисляемое поле (в JSON и лог не попадает) |
| `period.mjs` | периоды по поясу клуба, повторы, состояние подписки, плашка |
| `core.mjs` | клиент магазина платформы, чек, шифрование способа оплаты, применение ответа ЮKassa, оплата счёта, неудача списания, уведомления |
| `scheduler.mjs` | проход планировщика: счета, автосписания, повторы, напоминания, уведомление Андрею, сверка |
| `webhook.mjs` | `POST /api/webhooks/yookassa-platform` |
| `service.mjs` | API §3 |
| `index.mjs` | `init(ctx)` / `stop()`: подписчик outbox `club.went_live`, таймер раз в минуту |

Маршруты — `api/routes/billing.mjs`, вебхук — `api/routes/webhooks.mjs`. Миграция — `supabase/migrations/1150_billing.sql`.

## Настройки (`.env`)

| Переменная | Что задаёт |
|---|---|
| `PLATFORM_YOOKASSA_SHOP_ID`, `PLATFORM_YOOKASSA_SECRET` | магазин платформы. Без пары планировщик стоит, API и вебхук отвечают `503 billing_unavailable` |
| `PLATFORM_VAT_CODE` | ставка НДС позиции чека (1–12, по умолчанию 1 — без НДС) |
| `PLATFORM_TAX_SYSTEM_CODE` | система налогообложения платформы в чеке (1–6, по желанию) |
| `PLATFORM_BILLING_RETURN_URL` | куда ЮKassa вернёт владельца (по умолчанию `https://{PUBLIC_HOST}/club/subscription`); `return_url` из запроса — только с этого адреса или `https://{PUBLIC_HOST}` |

Адрес API и таймаут — общие с деньгами гостей (`YOOKASSA_API_URL`, `YOOKASSA_TIMEOUT_MS`; в проде только `https://api.yookassa.ru/v3`). Способ оплаты шифруется `SECRETS_ENC_KEY` (контекст `billing_method/<club_id>`). В кабинете магазина платформы адрес уведомлений — `https://{PUBLIC_HOST}/api/webhooks/yookassa-platform`.

## Как это работает

- **Пробный период (№181)** — 60 дней (`trial_days` плана) с перехода клуба в `live`; клубы, работавшие в `live` до M5.3, — с даты применения миграции (`bl.billing_settings.released_at`). Конец — местная полночь клуба через 60 суток после местной даты начала. Подписку создаёт `bl.billing_ensure_subscription`: подписчик outbox `club.went_live`, планировщик и `GET …/subscription`. Клуб в `test` подписки не имеет и не платит.
- **Счёт (№182)** — раз в месяц вперёд в местную полночь клуба. Первый счёт — в день окончания пробного периода; день месяца этой даты (`anchor_day`) — день всех следующих счетов (29–31 в коротком месяце — последний день). Сумма = столы в работе (`resources.active`) на момент счёта × цена клуба (персональная или плана), без перерасчёта внутри месяца. Сумма 0 (нет столов, персональная цена 0) — счёт сразу оплачен (`paid_via: 'free'`). Один счёт на период (`unique (club_id, period_start)`), пока срок не продлён оплатой, новый счёт не выставляется (кроме возобновления после приостановки — тогда прежний долг остаётся открытым рядом с новым счётом). Списывается старейший открытый счёт, у которого наступил срок попытки.
- **Оплата (№183)** — автосписание по сохранённому способу (`payment_method_id`, без участия владельца), `capture: true`, чек 54‑ФЗ: одна услуга «Подписка на программу „Бильярдум“» на email владельца. Ключ идемпотентности — счёт и номер попытки (`bl-sub-{invoice_id}-{n}`), id нашей записи платежа тоже выводится из них: сбой связи повторяется тем же ключом и не даёт второго списания. Оплаченный счёт продлевает `paid_until` до конца периода — только узкой функцией `bl.billing_settle_invoice`, один раз.
- **Карта** — владелец вводит её на странице ЮKassa (`save_payment_method: true`):
  - есть неоплаченный счёт — это оплата счёта (сумма счёта, чек);
  - счёта нет («Привязать карту», «Сменить карту») — заморозка 1 ₽ (`capture: false`), которая сразу снимается: денег клуб не платит, чека нет.
  - Способ оплаты хранится зашифрованным; наружу — только `•• 4477`, тип и срок.
- **Неоплата (№184)** — неудачное списание повторяется через 1 и 3 дня после первой неудачи (всего 3 попытки). При каждой неудаче — уведомление владельцу и управляющему и плашка. За 7 дней до конца пробного или оплаченного периода, если автоплатёж не настроен, — уведомление (один раз за период) и плашка. Через 14 дней после конца периода без оплаты — уведомление Андрею (один раз за счёт). **Автоматически ничего не отключается**: режим клуба, свет и игры планировщик не трогает; приостановка — только Андреем (`POST /api/platform/clubs/{club}/suspend`). Клуб, вернувшийся в `test`, счетов и списаний не получает.
- **Приостановка (№188)** — пока клуб приостановлен, счета не выставляются, не списываются и не начисляются задним числом. Начало и конец приостановки планировщик отмечает по своим часам (`suspended_since`, погрешность — один проход). При возобновлении (`bl.billing_resume`):
  - срок (пробный или оплаченный) кончался после начала приостановки — он сдвигается на длительность приостановки (целые сутки вверх, граница — местная полночь);
  - срок кончился ещё до приостановки — неоплаченные счета остаются долгом как были, следующий счёт — с даты возобновления (`paid_until` = местная полночь этой даты).
  - День счёта — день новой границы. Журнал платформы `billing.suspended`, `billing.resumed` (`kind: shift | restart`).
- **Магазин клуба ≠ магазин платформы (№188)** — сохранение пары магазина клуба с `shop_id` = `PLATFORM_YOOKASSA_SHOP_ID` — 400 `shop_invalid` (`server/clubs/shops.mjs`).
- **Вебхук** телу не верит: берёт только `object.id`, запрашивает платёж ключами платформы и сверяет id, `metadata.billing_payment_id`, `metadata.club_id`, сумму и магазин. Обработка один раз по `provider_payment_id` (уникальный индекс). Платёж гостя по адресу платформы — 404 у магазина платформы → 200 без действий; платёж платформы по адресу клуба — 404 у магазина клуба. Наша запись ещё не закоммичена — 503 (ЮKassa повторит). Вебхука нет — планировщик сверяет платёж сам через 30 секунд.
- **Двойная оплата** одного счёта (владелец заплатил и автосписание прошло) — счёт оплачивается один раз, вторая оплата — запись журнала `billing.double_payment` и уведомление Андрею (вернуть — в кабинете ЮKassa).

## База (1150)

| Таблица | Суть | Права `app_api` |
|---|---|---|
| `billing_settings` | одна строка: `released_at` — выкатка M5.3 | чтение |
| `billing_plans` | тарифы платформы: `code`, `title`, `price_per_table_kopecks`, `trial_days`, `active`; старт — «Клуб», 79 000 коп. | чтение всем; изменение — только при `bl.ctx_platform_role() = 'platform_admin'` |
| `club_subscriptions` | одна на клуб: план, персональная цена с причиной, `trial_started_at`, `trial_until`, `anchor_day`, `paid_until`, `autopay`, `payment_method_enc`, `card` (маска), `receipt_email`, `reminder_for` | чтение — свой клуб и платформа; служебные поля (карта, автоплатёж, напоминание) — только контекст платформы; цены, пробного периода и `paid_until` в правах нет вовсе |
| `billing_invoices` | счёт: период (даты и моменты), столы, цена, сумма, `status` `open`/`paid`, `paid_via` `card`/`manual`/`free`, ручная отметка (причина, платёжка, кто), попытки, `next_attempt_at`, `last_error`, `platform_notified_at` | чтение — свой клуб и платформа; выставляет и ведёт попытки только контекст платформы; «оплачен» — только узкой функцией |
| `billing_payments` | платёж в магазин платформы: `purpose` `bind`/`invoice`, `initiated_by` `owner`/`autopay`, попытка, `provider_payment_id` (уникален), `idempotence_key` (уникален), сумма, статус, чек, вебхук | чтение — свой клуб и платформа; владелец создаёт только `pending`; итог — только контекст платформы |

Узкие функции (`bl_definer`, `search_path` закреплён):

| Функция | Кто | Что |
|---|---|---|
| `bl.billing_ensure_subscription(club)` | свой клуб, платформа, фоновые задачи | подписка с пробным периодом, если клуб в боевом режиме и её нет |
| `bl.billing_settle_invoice(invoice, via, payment, reason, document, now)` | `card`, `free` — фоновые задачи; `manual` — `platform_admin` с причиной и платёжкой | счёт оплачен один раз, `paid_until` продлён; повтор — `false` |
| `bl.billing_set_price(club, price, reason, now)` | `platform_admin` | персональная цена (NULL — цена плана) |
| `bl.billing_disable_autopay(club, now)` | владелец клуба из контекста | автоплатёж выключен, способ оплаты забыт |
| `bl.billing_resume(club, now)` | фоновые задачи | возобновление после приостановки: сдвиг срока или счёт с даты возобновления (№188) |
| `bl.billing_clubs()` | платформа, фоновые задачи | клубы для подписки: название, город, пояс, режим, приостановлен с, столы в работе |

Журнал: действия владельца — в цепочке клуба (`billing.card_start`, `billing.autopay_off`), всё остальное — в цепочке платформы (`club_id IS NULL`): `billing.invoice_issued`, `billing.charge`, `billing.invoice_paid`, `billing.payment_failed`, `billing.card_saved`, `billing.overdue`, `billing.suspended`, `billing.resumed`, `billing.double_payment`, `billing.plan_update`, ручные действия Андрея `manual.billing_mark_paid` и `manual.billing_price` (с причиной).

## API (§3) — формы ответов для frontend

Ошибки — только кодом: `card_required` (409), `invoice_paid` (409), `billing_unavailable` (503 — нет ключей магазина платформы; 409 — `POST …/card` у клуба в `test`), а также `reason_required`, `bad_request`, `payment_pending`, `yookassa_unavailable`, `payment_failed`, `forbidden`, `not_found`. Деньги — копейки, время — ISO UTC, даты счёта — `YYYY-MM-DD` по поясу клуба.

### `GET /api/clubs/{club}/subscription` — владелец, управляющий

Владелец:

```json
{
  "mode": "live",
  "state": "trial",
  "trial_until": "2026-12-22T19:00:00.000Z",
  "paid_until": null,
  "banner": { "kind": "trial_ending", "days_left": 5, "days_overdue": 0, "until": "2026-12-22T19:00:00.000Z", "last_error": null },
  "plan": { "id": "bf000000-0000-4000-8000-000000000001", "code": "club", "title": "Клуб" },
  "price_per_table_kopecks": 79000,
  "personal_price": false,
  "tables": 8,
  "trial_days": 60,
  "next_invoice": { "date": "2026-12-23", "amount_kopecks": 632000, "invoice_id": null },
  "open_invoice": null,
  "card": { "mask": "•• 4477", "type": "MasterCard", "expiry": "12/30" },
  "autopay": true,
  "receipt_email": "owner@club.ru",
  "card_pending": false
}
```

- `state`: `trial` — пробный период; `active` — оплачено; `past_due` — есть неоплаченный счёт (или период кончился); `unpaid` — старейшему неоплаченному счёту 14 дней и больше; `canceled` — клуб вернулся в `test`. Клуб ещё в `test`: `mode: 'test'`, `state: 'trial'`, `trial_until: null`, `next_invoice: null` — «Пробный период 60 дней начнётся после перехода в боевой режим».
- `banner` (или `null`) — плашка «Оплаченный период истекает через N дней»:
  - `trial_ending` и `period_ending` — до конца пробного или оплаченного периода `days_left` ≤ 7, а автоплатёж не настроен;
  - `invoice_due` — счёт выставлен (или период кончился), а списание ещё ни разу не отказало (не пробовали или попытка идёт): `next_attempt_at` — когда спишется (срок попытки, не раньше «сейчас»), `until` — начало периода счёта; дату показывать по поясу клуба;
  - `payment_failed` — только после реального отказа: попытка списания не прошла или карты нет (`last_error`: `insufficient_funds`, `card_required` …), `days_overdue`.
- `next_invoice` — открытый счёт (`invoice_id` задан) или ближайший будущий (сумма по текущим столам и цене).
- `open_invoice` — `{id, period_start, period_end, amount_kopecks, attempts, next_attempt_at, last_error}` или `null`.
- `autopay` — автоплатёж сработает сам (включён и карта сохранена); `card_pending` — владелец начал оплату или привязку на странице ЮKassa меньше часа назад, итога ещё нет (показать «Проверяем оплату…», опрашивать GET).

Управляющий — только `{mode, state, trial_until, paid_until, banner}`. Ресепшн, бар — 403.

### `POST /api/clubs/{club}/subscription/card {return_url?, email?}` — владелец → 201

`{"payment_id": "…", "purpose": "bind" | "invoice", "amount_kopecks": 100, "confirmation_url": "https://yoomoney.ru/…"}` — открыть `confirmation_url`. `purpose: 'invoice'` — есть неоплаченный счёт, это его оплата; `bind` — привязка 1 ₽ заморозкой (сразу снимается). `email` — для чека; обязателен, если раньше не сохранён (400 `bad_request`). Пока по открытому счёту идёт оплата — 409 `payment_pending`. После возврата со страницы — опрашивать `GET …/subscription` (`card`, `card_pending`, `state`).

### `DELETE /api/clubs/{club}/subscription/autopay {reason?}` — владелец

`{"autopay": false, "card": null}`; карты нет — 409 `card_required`.

### `GET /api/clubs/{club}/subscription/invoices` — владелец

```json
{ "items": [ {
  "id": "…", "period_start": "2026-12-23", "period_end": "2027-01-23", "tables": 8, "price_per_table_kopecks": 79000,
  "amount_kopecks": 632000, "status": "paid", "paid_at": "…", "paid_via": "card",
  "receipt": { "status": "succeeded", "email": "owner@club.ru" }, "document": null,
  "attempts": 1, "next_attempt_at": null, "last_error": null
} ] }
```

Новые сверху, до 120. `paid_via`:
- `card` — с `receipt` (чек ЮKassa ушёл на email);
- `manual` — оплата по счёту юрлица, `document` — номер платёжки;
- `free` — сумма 0.

### Платформа

- `GET /api/platform/subscriptions` — оператор и Андрей:

  ```json
  {
    "items": [ {
      "club_id": "…", "name": "Тестовый клуб", "city": "Екатеринбург", "timezone": "Asia/Yekaterinburg", "mode": "live", "state": "past_due",
      "plan": { "id": "…", "code": "club", "title": "Клуб" }, "price_per_table_kopecks": 79000,
      "personal_price": false, "personal_price_reason": null, "tables": 8, "monthly_kopecks": 632000,
      "went_live_at": "…", "trial_until": "…", "paid_until": "…", "debt_kopecks": 632000,
      "open_invoice": { "id": "…", "period_start": "…", "period_end": "…", "amount_kopecks": 632000, "attempts": 2, "next_attempt_at": "…", "last_error": "insufficient_funds" },
      "autopay": true, "card": true
    } ],
    "plans": [ { "id": "…", "code": "club", "title": "Клуб", "price_per_table_kopecks": 79000, "trial_days": 60, "active": true } ],
    "totals": { "mrr_kopecks": 632000, "paid_this_month_kopecks": 0, "payments_this_month": 0, "debt_kopecks": 632000,
                "clubs": { "trial": 0, "active": 0, "past_due": 1, "unpaid": 0, "canceled": 0 } }
  }
  ```

  Поля:
  - MRR — сумма `monthly_kopecks` боевых клубов вне пробного периода;
  - «оплаты за месяц» — оплаченные счета (кроме `free`) с начала месяца по Москве.
- `POST /api/platform/subscriptions/{club}/mark-paid {invoice_id, reason, document}` — Андрей → `{invoice_id, status: 'paid', paid_via: 'manual', paid_until}`. Без причины — 400 `reason_required`, без `document` — 400, уже оплачен — 409 `invoice_paid`. Журнал `manual.billing_mark_paid`, уведомление владельцу.
- `PUT /api/platform/subscriptions/{club}/price {price_per_table_kopecks | null, reason}` — Андрей → `{club_id, price_per_table_kopecks, personal_price}`. `null` — вернуть цену плана; действует со следующего счёта; журнал `manual.billing_price`, уведомление владельцу.
- `PUT /api/platform/plans/{id} {title?, price_per_table_kopecks?, active?, reason?}` — Андрей → план. Новая цена — со следующих счетов клубов без персональной цены.

## Уведомления

| Вид | Кому | Когда |
|---|---|---|
| `billing.reminder` | владелец, управляющий | за 7 дней до конца периода без автоплатежа |
| `billing.card_required` | владелец, управляющий | выставлен счёт, карты нет |
| `billing.payment_failed` | владелец, управляющий | неудачное списание (с датой повтора или «попыток больше не будет») |
| `billing.payment_succeeded` | владелец | счёт оплачен (картой или отмечен Андреем) |
| `billing.card_saved` | владелец | карта привязана |
| `billing.price` | владелец | Андрей изменил цену |
| `platform.billing_overdue` | Андрей | 14 дней без оплаты |
| `platform.billing_double_payment` | Андрей | счёт оплачен дважды |

## Проверка

```
npm test -w @billiardum/server                       # юнит: периоды, состояние, плашка, чек, настройки
npm test -w @billiardum/yookassa-emu                 # эмулятор: save_payment_method, автоплатёж, отказ списания
DATABASE_ADMIN_URL=… DATABASE_URL=… node --test --test-concurrency=1 server/billing/test/db/billing.test.mjs   # T31, T32
```

`server/billing/test/db/` подхватывает `npm run test:db` (`scripts/ci-test-db.mjs`).
