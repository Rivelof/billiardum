# Сети клубов (`server/networks`, M5.5)

Контракт — `docs/contracts/m5-5-8.md` (решения №190–195), план подписки — `docs/contracts/m5-3.md` (№180). Маршруты — `api/routes/networks.mjs`, миграция — `supabase/migrations/1350_networks.sql`. Франшиза (№195) — не делается.

| Файл | Что делает |
|---|---|
| `service.mjs` | сеть, клубы сети, управляющие сети, `GET /api/clubs/{club}/network`, привязка приглашений при входе (`acceptNetworkInvites`, зовёт `server/auth`) |
| `templates.mjs` | шаблоны тарифов и меню: запись в клубы, мягкий и жёсткий режим, сброс клуба к шаблону, ручные действия в live |
| `compare.mjs` | вкладка «Сеть» дашборда: клубы по плиткам, рейтинг |
| `lock.mjs` | сеть клуба из контекста для `server/setup/tariffs.mjs` и `server/catalog/service.mjs` (без их импортов) |

## Модель

- **Сеть** (`bl.networks`) — группа клубов одного владельца (№190). Создаёт вошедший пользователь (`bl.network_create`, не больше 5 сетей). Клуб добавляет только владелец сети и только клуб, где он сам — активный владелец (`bl.network_add_club` проверяет это в базе, сервер — до базы). Клуб — не больше чем в одной сети: уникальный индекс по активным строкам `bl.network_clubs`; во вторую сеть — `409 club_in_network`. Не больше 100 клубов в сети. Удаление — архив (`DELETE`): клубы выходят, управляющие отзываются.
- **Управляющий сети** (№192) — приглашение по телефону на 7 дней (`bl.network_members`), привязывается при входе с этим номером (как приглашение персонала, №158: текст без телефона, `invite_url` и `invite_text`). Доступ к клубам даёт членство в сети: узкая функция `bl.network_sync_access` держит в каждом клубе сети строку `club_members` с `role = 'manager'` и `network_id` сети. RLS по `club_id` не меняется — управляющий сети работает в контексте клуба, как управляющий клуба. Прямое активное членство в клубе (любая роль) главнее: такую строку сеть не трогает. Вывод клуба из сети и отзыв управляющего снимают доступ сразу (строка гаснет, PIN стирается, PIN-токены клуба отзываются).
  - Роутер ставит `ctx.networkManager` (id сети), если членство в клубе выдано сетью. Маршрут с `networkManager: false` отвечает такому пользователю `403`.
  - **Без денег по способам оплаты и экспорта (как №166):** `403` — вкладка дашборда `tab=money` (и у «Все мои клубы» — если в выборке только такие клубы, иначе они выпадают), все `…/export.csv` (дашборд — и так только владелец, истории, смены, касса управляющего). Разбивка по способам оплаты скрыта (`null`, итоги остаются) в: `…/dashboard/now` (`revenue_today.by_method`), `GET /api/clubs/{club}/now` (`revenue_today_kopecks: null`, итог — `revenue_today_total_kopecks`), отчёте смены `GET /api/shifts/{id}/report` (`methods_hidden: true`, см. «Отчёт смены» ниже), утренней сводке (текст без «СБП …, наличные …»). Остальное — как у управляющего клуба (зал, тарифы, меню, смены, истории, касса, «Кто играл»), но и там способ оплаты отдельной записи — `null` (см. Н-3 ниже).
  - **Деньги по способам для управляющего сети — на всех маршрутах (Н-3):** JSON-ответ любого маршрута, где в запросе участвует клуб, в котором пользователь управляющий сети, и события SSE канала клуба проходят `hideMoneyMethods` (`server/lib/network-view.mjs`, подключён в роутере `api/router.mjs` и в `api/routes/stream.mjs`): поля `method`, `methods`, `payment_method`, `by_method`, `cash_sales_kopecks`, `cash_refunds_kopecks`, `received_kopecks`, `change_kopecks` на любой глубине — `null` (форма ответа не меняется, экран не падает). Это закрывает смены (`shifts/current`, `/shifts`, `/api/shifts/{id}`, закрытие), продажи кассы (`pos/sales`, `pos/sales/{id}`: способ, принято, сдача), заказы, «Кто играл», историю заказов, журнал (`data.method` у `pos.sale`) и SSE `pos_sale`; новые поля с такими именами закрываются сами. Остаются итоги без разбивки (выручка, сумма продажи, `revenue_total_kopecks`) и сверка кассы смены — `expected_cash_kopecks`, `actual_cash_kopecks`, `discrepancy_kopecks`, размен (не разбивка по способам, как у управляющего клуба, №94). В «Все мои клубы» с клубом сети способы скрыты во всём ответе. Проверка — обход всех GET-маршрутов роли manager (`server/orders/test/db/network-guards.test.mjs`).
  - **Группы модификаторов шаблона (Н-4, заход 2):** в жёстком меню группа, привязанная к товару шаблона (в том числе до включения жёсткого режима), и её модификаторы не правятся клубом — `409 network_locked` (`server/catalog/README.md`).
  - **Терминалы (Н-2):** управляющий сети терминал ресепшена не заводит (`POST /api/staff/terminal` — `403`, `networkManager: false`); терминалы, заведённые им раньше, гаснут вместе с его доступом — вывод клуба из сети, отзыв управляющего и архив сети (всё через `bl.network_sync_access`, миграция 1352) отзывают терминалы клуба, `created_by` которых — этот управляющий и чьё членство выдала сеть. Прямое членство в клубе (`network_id` пуст) терминалы не теряет. PIN-токены других сотрудников на отозванном терминале перестают работать сами.
  - Клуб не меняет роль и не отзывает управляющего сети (`PATCH|DELETE /api/clubs/{club}/staff/{user}` → `409 network_locked`); `app_api` не выдаёт и не меняет такие строки (триггер `club_members_network_guard`, `BLN10`). В списке персонала — `network_id`.
  - Шаблоны и состав сети меняет только владелец сети; управляющий — читает.
- **План «Сеть»** (№194) — строка `bl.billing_plans` (`code: 'network'`, 1 190 ₽ за стол — гипотеза PRODUCT §17; цену меняет Андрей: `PUT /api/platform/plans/bf000000-0000-4000-8000-000000000002`). Включается клубам сети из **двух и более** клубов (`bl.network_sync_billing` при изменении состава; подписка, созданная позже, получает его триггером). Выход из сети (или сеть из одного клуба) — снова «Клуб». Персональная цена клуба главнее плана. Логика счетов M5.3 не менялась: счёт = столы × цена плана на дату счёта.

## Шаблоны (№191)

Режим у каждого шаблона свой: `tariffs_mode`, `menu_mode` — `soft` (по умолчанию) или `hard`.

**Тарифы.** Шаблон — правила мастера тарифов (`server/setup/tariffs.mjs`, `normalizeRules`: те же поля и проверки, цена — копейки строго > 0, №163; в базе `price_per_hour > 0`). Шаблон записывается в правила каждого клуба тем же путём, что мастер (`replaceClubRules`): движок тарифов не меняется, а время правил — местное, поэтому в каждом клубе правило действует **по его поясу и рабочим суткам**. Перед записью шаблон проверяется по неделе каждого клуба (его `day_start_local` и типы столов в работе): `400 tariff_gap | tariff_overlap {club_id, kind?, weekday, from, to}` — ничего не записывается.
- Корты (M5.8): правило корта в шаблоне — как в мастере, слотом (`kind: 'padel_court'`, `slot_minutes` 60/90/120, `price_per_slot_kopecks` > 0; в базе — миграция 1351). `kind: null` — только столы. Шаблон заменяет все правила клуба, поэтому клубу с кортами в работе шаблон без правил корта не подходит: `400 tariff_gap {kind: 'padel_court', club_id}`. Клубу без кортов правила корта из шаблона записываются впрок (как в мастере).
- **Клуб, добавленный в сеть**, получает действующие шаблоны сразу (`POST /api/networks/{id}/clubs`): тарифы шаблона **заменяют** тарифы клуба (как первый шаблон сети, в любом режиме — `override` у нового клуба сбрасывается) и товары шаблона меню записываются в каталог клуба (режим меню сети — как при новой версии). Правила те же, что у новой версии шаблона: неделя клуба проверяется до записи — дыра или пересечение дают `400 tariff_gap | tariff_overlap {club_id, kind?, weekday, from, to}`, добавление откатывается целиком (клуб не в сети, правил не записано); клуб в `live` (или приостановленный бывший `live`) — ручное действие: `reason` в теле запроса добавления (`400 reason_required`, клуб не добавляется), журнал `manual.network_tariff_change` / `manual.network_menu_change` с `data.added: true` в цепочке клуба и тревога `manual_action` владельцу («Клуб добавлен в сеть …»); клуб в `test` — `network.tariffs_applied` / `network.menu_applied` (`data.added`). Нет шаблона тарифов (или меню) — соответствующая часть не применяется. Повторное добавление клуба, уже состоящего в этой сети, — `200` без изменений.
- `soft`: клуб может сохранить свои тарифы (`PUT /api/clubs/{club}/tariffs`) — он «переопределил» шаблон, новые версии шаблона его не меняют (в его журнале — `network.tariffs_template {applied: false}`). Первый шаблон сети применяется ко всем клубам.
- `hard`: шаблон — во все клубы; `PUT /api/clubs/{club}/tariffs` → `409 network_locked {network_id}`. Переход сети в `hard` возвращает переопределивших к шаблону.
- Клуб возвращается к шаблону сам: `POST /api/clubs/{club}/network/reset {scope: 'tariffs', reason?}`.
- `DELETE /api/networks/{id}/tariffs` — шаблона нет, тарифы клубов остаются как есть.

**Меню.** Шаблон — товары (категория по имени, название, артикул, цена в копейках, единица, алкоголь, НДС, предмет расчёта, описание, порядок). В клубе товар шаблона — обычный товар `bl.products` со ссылкой `network_product_id`: касса, склад, стоп-лист, QR-меню работают как прежде, **алкоголь гостю в QR-меню не показывается** (фильтр `menuFor` не менялся). Товар клуба ищется по ссылке, затем по артикулу, затем по категории и названию, иначе создаётся (категория — по имени, нет — создаётся). Пустые поля шаблона (описание, артикул, НДС, категория) значения клуба не стирают. Товар убран из шаблона — в клубах снимается с продажи. Шаблон задаёт поля `MENU_TEMPLATE_FIELDS` (категория, название, описание, артикул, цена, единица, алкоголь, НДС, предмет, продаётся ли); стоп-лист, учёт склада, фото, порядок, модификаторы — клуб ведёт сам в любом режиме.
- `soft`: клуб меняет поле шаблона у товара — товар становится переопределённым (`network_override: true`), шаблон его больше не меняет. **Признак алкоголя шаблона клуб не снимает ни в каком режиме** (`409 network_locked`); у переопределённого товара шаблон алкоголь всё равно ставит.
- `hard`: поле шаблона у товара шаблона — `409 network_locked`; привязка и отвязка групп модификаторов у товара шаблона (`modifier_group_ids`) — тоже (от неё зависит цена строки, Н-1; надбавка модификатора — только 0 и больше, `server/catalog/README.md`); импорт CSV/xlsx по такому товару — ошибка строки `network_template` (импорт целиком не применяется, видно и в предпросмотре). Свои товары клуба — можно.
- Сброс клуба: `POST /api/clubs/{club}/network/reset {scope: 'menu', reason?}`.

**Боевой режим.** Изменение шаблона, которое затрагивает клуб в `live` (или приостановленный бывший `live`, `isLiveClub`), — ручное действие (инвариант 8): `reason` обязателен (`400 reason_required`, ничего не записывается), журнал `manual.network_tariff_change` / `manual.network_menu_change` в цепочке **каждого** затронутого клуба и тревога `manual_action` владельцу (`ctx.manual`). Клуб в `test` — журнал `network.tariffs_applied` / `network.menu_applied`. Не затронутый (переопределил) — `network.tariffs_template` / `network.menu_template`.

**Журнал сети.** Своей цепочки у сети нет: всё пишется в цепочку каждого клуба, которого касается: `network.club_added`, `network.club_removed`, `network.updated` (`changes`), `network.manager_invited` (маска телефона), `network.manager_added`, `network.manager_revoked`, `network.archived`, `network.tariffs_template_removed`, `network.menu_template_removed`.

## Вкладка «Сеть» (№193)

`GET /api/networks/{id}/dashboard?from&to&compare` — владелец и управляющие сети. Числа — те же, что у дашборда клуба (`collect` и `metrics` из `server/dashboard/service.mjs`: агрегаты `stats_daily`/`stats_hourly` и текущие сутки на лету), каждый клуб — по своим рабочим суткам и поясу (даты периода общие), `is_test` не входит никуда. Денег по способам оплаты нет. Клубы в `test` показываются (их деньги — нули), но в рейтинг не входят (`ranked: false`, места `null`). Рейтинг: `utilization` (загрузка) и `revenue_per_table_day` (выручка на столо-день, сравнимо между клубами разного размера); равные — одно место. (До правки ключ назывался `ranking.revenue_per_table` и место — `place_revenue_per_table`, хотя считались по `revenue_per_table_day`; теперь имена совпадают со считаемым. Плитка `revenue_per_table` — выручка за период / среднее число столов — осталась плиткой, в рейтинг не входит.)

Столы и корты (M5.8): `revenue`, `games`, `play_hours`, `guests`, `no_staff_share`, `avg_check_bar` — по клубу целиком (как дашборд без фильтра). Плитки, зависящие от числа столов, — `utilization`, `avg_check_game`, `revenue_per_table_day`, `revenue_per_table`, `avg_hour_price`, `tables_avg` — только столы, как дашборд клуба с `kind=table` (выручка столов / столо-дни). Рейтинг — по столам. Корты — блок `courts: {courts_avg, games, play_hours, utilization, revenue_kopecks, revenue_per_court_day_kopecks}` у клуба и итога (`null`, если кортов в периоде не было). Среднее число столов и кортов — по прошедшим суткам периода (будущие сутки его не занижают). Подписка «Сеть» считает «столы в работе» как billing M5.3 (корты сейчас — тоже, решение за Андреем).

## API — формы ответов для frontend

Ошибки — только кодом. Деньги — копейки, время — ISO UTC, даты периода — `YYYY-MM-DD`. Сеть — **только личный вход** (не PIN терминала, иначе `403`). Нет доступа к сети (чужая, нет такой) — `404`; управляющий на действии владельца — `403`.

### Сеть

`GET /api/networks` → `{ items: [{ network_id, name, role: 'owner'|'manager', clubs, tariffs_mode, menu_mode }] }`. То же — в `GET /api/me` полем `networks`; у клубов `/api/me`, выданных сетью, — `network_id`.

`POST /api/networks {name}` → `201`; `GET /api/networks/{id}`; `PATCH /api/networks/{id} {name?, tariffs_mode?, menu_mode?, reason?}` (владелец; переход в `hard` в live-клубах — с `reason`):

```json
{
  "id": "…", "name": "Сеть Урал", "role": "owner", "tariffs_mode": "soft", "menu_mode": "hard",
  "tariffs": { "template": true, "version": 2 }, "menu": { "template": true, "version": 3 },
  "clubs": [ { "club_id": "…", "name": "Клуб Калининград", "city": "Калининград", "timezone": "Europe/Kaliningrad", "day_start_local": "06:00",
               "mode": "live", "tariffs_override": false, "tariffs_version": 2, "menu_version": 3, "added_at": "…" } ],
  "plan": { "id": "bf000000-…-000000000002", "code": "network", "title": "Сеть", "price_per_table_kopecks": 119000, "active": true, "applies": true },
  "created_at": "…", "updated_at": "…"
}
```

`DELETE /api/networks/{id}` → `{ ok: true, clubs_removed }`. `POST /api/networks/{id}/clubs {club_id, reason?}` → `201` сеть (повтор — `200`); шаблоны сети применяются к клубу сразу (см. «Шаблоны»): клуб в live — `reason` обязателен (`400 reason_required`), дыра или пересечение недели клуба — `400 tariff_gap | tariff_overlap {club_id, …}`; `403` — не свой клуб; `409 club_in_network`, `409 networks_limit`, `409 duplicate {club_id, field, value}` (артикул товара шаблона занят другим товаром клуба). `DELETE /api/networks/{id}/clubs/{club_id}` → сеть.

### Управляющие сети (владелец)

`GET /api/networks/{id}/managers` → `{ items: [{ id, status: 'invited'|'active', user_id, name, phone_masked, created_at, expires_at, accepted_at }] }`.
`POST /api/networks/{id}/managers {phone}` (E.164 с «+») → `201 { id, status: 'invited', phone_masked, expires_at, invite_url, invite_text }`; уже управляющий или свой номер — `409 duplicate`. Повтор на тот же номер продлевает приглашение.
`DELETE /api/networks/{id}/managers/{member_id}` → `{ ok: true }` (и приглашение, и управляющего).

### Шаблон тарифов

`GET /api/networks/{id}/tariffs` (владелец, управляющий):

```json
{
  "network_id": "…", "role": "owner", "mode": "soft", "template": true, "version": 2,
  "rules": [ { "kind": null, "days": [1,2,3,4,5,6,7], "from": "06:00", "to": "18:00", "start_local": "06:00", "end_local": "18:00",
               "price_per_hour_kopecks": 55000, "min_minutes": 30, "step_minutes": 1 } ],
  "clubs": [ { "club_id": "…", "name": "…", "timezone": "Asia/Yekaterinburg", "day_start_local": "06:00", "mode": "live", "live": true,
               "override": false, "applied_version": 2, "kinds": ["pool", "padel_court"], "problem": null } ]
}
```

`kinds` — виды ресурсов клуба в работе (коды API: `pyramid | pool | snooker | mixed | padel_court`, порядок как в справочнике видов): экрану не нужен запрос на каждый клуб. `problem` — `{type: 'gap'|'overlap', kind, weekday, from, to}`, если шаблон не покрывает неделю этого клуба (например, после добавления стола нового типа); `type` — первая проблема (пересечение важнее дыры), `kind` — вид, у которого она найдена (`null` — правила «для всех столов», когда видов в клубе нет), `weekday` — ISO-день недели (1 — понедельник) **рабочих суток** клуба, `from`/`to` — местное время (`HH:MM`; `24:00` — конец суток при `day_start_local` `00:00`). **Дыра на весь день** — у вида нет цены ни на один час (например, в клубе появился снукер, а шаблон — только на пул): `type: 'gap'` и `from` равно `to` равно `day_start_local` клуба (`06:00`–`06:00`; при суточных рабочих сутках с `00:00` — `00:00`–`24:00`), `weekday` — первый такой день (`1`, если цены нет совсем). Дыра в части суток: `from < to` внутри суток (или через полночь по часам рабочих суток). Экран может показать «нет цены для вида {kind}» целиком, если `from === to`. `PUT /api/networks/{id}/tariffs {rules, reason?}` — правила как у `PUT /api/clubs/{club}/tariffs` (`kind`, `days`, `from`, `to`, `price_per_hour_kopecks`, `min_minutes`, `step_minutes`), ответ — как `GET`. `DELETE` — шаблон снят.

### Шаблон меню

`GET /api/networks/{id}/menu`:

```json
{
  "network_id": "…", "role": "owner", "mode": "soft", "template": true, "version": 1,
  "products": [ { "id": "…", "category": "Бар", "name": "Пиво", "sku": "BEER-1", "price_kopecks": 25000, "unit": "шт", "is_alcohol": true,
                  "vat_code": null, "payment_subject": "excise", "description": null, "sort": 0, "active": true, "updated_at": "…" } ],
  "clubs": [ { "club_id": "…", "name": "…", "mode": "live", "applied_version": 1, "overrides": 0 } ]
}
```

`PUT /api/networks/{id}/menu {products, reason?}` — шаблон целиком (до 300 товаров; дубль в самом списке — `400 bad_request`; запись в клуб, где артикул (`field: 'sku'`) или название (`field: 'name'`) занят другим товаром клуба, — `409 duplicate {club_id, field, value}`: `value` — артикул или название товара шаблона, ничего не записано): товар с `id` — тот же товар шаблона, без `id` — ищется по артикулу, затем по категории и названию; не попавший в список снимается. Поля товара: `name` (обязательно), `price_kopecks` (обязательно, > 0), `category?`, `sku?`, `unit?` (`шт|порц|л|мл|кг|г`), `is_alcohol?`, `vat_code?` (1–12), `payment_subject?` (по умолчанию `excise` у алкоголя, иначе `commodity`), `description?`, `sort?`, `active?`. Ответ — как `GET`. `DELETE` — шаблон снят, товары клубов становятся своими товарами клуба.

Товар каталога клуба (`GET /api/clubs/{club}/catalog`, `PATCH /api/catalog/products/{id}`) дополнен полями `network_product_id` (`null` — свой товар клуба) и `network_override`.

### Клуб

`GET /api/clubs/{club}/network` (владелец, управляющий клуба):

```json
{ "network": { "id": "…", "name": "Сеть Урал",
  "tariffs": { "template": true, "mode": "hard", "locked": true, "override": false, "version": 2, "applied_version": 2 },
  "menu": { "template": true, "mode": "soft", "locked": false, "overrides": 1, "version": 3, "applied_version": 3 } } }
```

или `{ "network": null }`. `locked` — «Тарифы задаёт сеть» (кнопки правки скрыть или показать причину), `override` / `overrides` — «Свои тарифы клуба» / «N товаров изменены клубом», кнопка «Вернуть как в сети» — `POST /api/clubs/{club}/network/reset {scope: 'tariffs'|'menu', reason?}` (в live — с причиной). Ответ: `{scope: 'tariffs', tariffs: <как GET /api/clubs/{club}/tariffs>}` или `{scope: 'menu', created, updated, deactivated, price_changes, skipped_override}`.

### Вкладка «Сеть»

`GET /api/networks/{id}/dashboard?from&to&compare=0|1` (без `from`/`to` — текущие сутки первого клуба; период до 366 суток):

```json
{
  "network": { "id": "…", "name": "Сеть Урал" }, "role": "manager",
  "period": { "from": "2026-10-23", "to": "2026-10-26", "days": 4 }, "compare_period": null,
  "clubs": [ {
    "club_id": "…", "name": "Клуб Калининград", "timezone": "Europe/Kaliningrad", "day_start_local": "06:00", "mode": "live",
    "today": "2026-10-25", "includes_today": true, "ranked": true, "tables_avg": 1.5,
    "tiles": [ { "id": "revenue", "value": 60000, "unit": "kopecks", "prev": null, "delta_pct": null }, … ],
    "courts": null, "place_utilization": 1, "place_revenue_per_table_day": 1 } ],
  "totals": { "tables_avg": 6.5, "tiles": [ … ], "courts": { "courts_avg": 2, "games": 3, "play_hours": 4.5, "utilization": 6.3, "revenue_kopecks": 900000, "revenue_per_court_day_kopecks": 112500 } },
  "ranking": { "utilization": [ { "club_id": "…", "name": "…", "value": 4.2, "place": 1 } ], "revenue_per_table_day": [ … ] },
  "missing_days": [], "generated_at": "…"
}
```

Плитки (`id` и `unit` — как у дашборда клуба, `docs`: `server/dashboard/README.md`): `revenue`, `games`, `play_hours`, `utilization`, `avg_check_game`, `avg_check_bar`, `revenue_per_table_day`, `revenue_per_table` (выручка за период / среднее число столов в работе), `avg_hour_price`, `guests`, `no_staff_share`. `null` — «нет данных».

### Отчёт смены управляющему сети

`GET /api/shifts/{id}/report` для управляющего сети (`ctx.networkManager`) — тот же отчёт без денег по способам оплаты: `methods_hidden: true`; `shift.cash_sales_kopecks`, `shift.cash_refunds_kopecks` и то же в `cash` — `null`; `revenue.*.by_method` (общий и по `tables`, `bar`, `packages`, `tournaments`, `other`, `refunds`, `late_returned`) — `null`, итоги (`total_kopecks`, `tables_kopecks`, возвраты, `net_kopecks`) остаются; в `reconciliation.kkt` `by_method`, `system_kopecks`, `kkt_kopecks` и `amount_kopecks` в `receipts.*` — `null`, а `ok`, `diff_kopecks`, счётчики и списки `missing`/`missing_refunds` (у записей `method: null`) остаются; в `reconciliation.online` суммы `system_*`, `yookassa_*` — `null`, статус, `ok`, `diff_kopecks` остаются; в `cash` остаются размен, ожидалось, факт и расхождение — сверка кассы, не разбивка по способам (как у управляющего клуба, №94). Управляющему клуба и владельцу отчёт отдаётся целиком.

## Тесты

- `node --test server/networks/test/*.test.mjs` (входит в `npm test -w @billiardum/server`) — разбор шаблона меню, текст приглашения, ошибки узких функций, опция роутера `networkManager`.
- На базе (`scripts/ci-test-db.mjs` подхватывает `server/networks/test/db`):
  - `networks.test.mjs` — состав сети (чужой клуб — 403, во вторую сеть — 409, база проверяет владение), T41 (тарифы в трёх поясах — цена по местному времени, live — причина, журнал и тревога в каждом клубе, test — журнал; мягкий шаблон и переопределение, сброс, жёсткий шаблон и 409; меню — алкоголь не в QR-меню, переопределение, жёсткий, импорт, снятие), T42 (управляющий сети: приглашение и вход, как управляющий, экспорт и деньги по способам — 403; вкладка «Сеть» = дашборд клуба, рейтинг, тестовый клуб без рейтинга; изоляция чужой сети), RLS таблиц сети во всех контекстах, снятие доступа.
  - `server/orders/test/db/network-guards.test.mjs` — находки pentester Н-1…Н-3: модификатор без отрицательной надбавки и замок групп модификаторов, терминалы управляющего сети, обход всех GET-маршрутов без способов оплаты.
  - дополнено (пакет после M5.5/M5.8): «Сейчас», отчёт смены и утренняя сводка управляющего сети без способов оплаты; добавление клуба в сеть (live — причина и откат, `test`, дыра `400 tariff_gap`, `kinds` и `problem` на весь день, `409 duplicate {field, value}`).
  - `billing.test.mjs` — T42 подписка «Сеть»: план в базе, сеть из 2+ клубов, счёт по цене «Сети», цену меняет только Андрей, выход из сети — «Клуб».

```
DATABASE_ADMIN_URL=postgres://… node --test --test-concurrency=1 server/networks/test/db/*.test.mjs
```
