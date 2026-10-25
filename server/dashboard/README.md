# Дашборд владельца, истории, касса управляющего (M5.2)

Контракт — `docs/contracts/m5-2.md` (§3, §4, §7, §8), решения №166–179. Модуль `server/dashboard` (планировщик и расчёты), `server/history` (истории склада и заказов), маршруты `api/routes/dashboard.mjs`, `history.mjs`, `cashbook.mjs`, `who-played.mjs`, расширение `api/routes/shifts.mjs`. Миграции `1100_stats.sql`, `1101_cashbook.sql`, `1102_guest_lookup.sql`.

## Как считается

- **Сутки** — рабочие сутки клуба: с `settings.day_start_local` (по умолчанию 06:00) в поясе клуба (№167). Даты в API (`from`, `to`, `date`) — такие сутки.
- **Деньги** — те же запросы и та же свёртка, что у отчёта смены и утренней сводки (`server/reports/queries.mjs`: `shiftPayments`, `shiftRefunds`, `revenueOf`, №168). Выручка — платежи, подтверждённые в сутках (`confirmed_at`), заморозка «Без лимита» — списанной суммой; возвраты (`refunds.kind = 'refund'`) уменьшают сутки возврата; игра пакетом минут — не деньги; `is_test` не входит никуда. Плитка `revenue` — **чистая** выручка (выручка − возвраты), как «выручка» утренней сводки; `revenue_total` и `refunds` — отдельно.
- **Игры и часы (№187, уточнение №167)** — одно правило для дашборда, утренней сводки и отчёта смены: игра (количество) относится к суткам (смене) начала; часы игры и загрузка — фактические минуты внутри каждых суток. Игра 05:30–07:00 при начале суток 06:00: одна игра и 30 минут — в прошлых сутках, 60 минут — в следующих. Так же сервисный свет (число — по включению, минуты — внутри суток) и брони (число — по началу брони, минуты удержания — внутри суток). Сравнение «дашборд = сводка» верно всегда; «дашборд = сумма отчётов смен» — когда смены покрывают сутки (ночная оплата по QR без открытой смены есть в дашборде и сводке, но не в отчёте смены).
- **Ёмкость** (№170) = столы в работе × часы работы клуба. Часы работы — `clubs.settings.open_hours = {"open": "10:00", "close": "02:00", "days": {"7": null}}` (`days` — по ISO дню недели суток, `null` — выходной); нет настройки или `open = close` — 24 часа. Стол, выведенный из работы (`resource.deactivate` или `manual.resource_remove` в журнале), не входит с момента вывода. У текущих суток ёмкость — до «сейчас». Ёмкость округляется до минут один раз (Н1 M5.2): по ячейкам стол × час накопленной суммой (столы по номеру, часы по порядку), стол и итог суток — суммы своих ячеек; сумма тепловой карты = кольцу, итог = округлению точной суммы. Загрузка = сыграно / ёмкость; нереализовано = ёмкость − сыграно − сервис (не меньше 0).
- **Гости** (№171) — только количества; гость — участник игры или автор брони, не сотрудник клуба. За период: `total` — играли в периоде или впервые пришли в периоде; `new` — первая игра или бронь в клубе за всё время — в периоде; `repeat` — играли в периоде и играли раньше; `lost` — 3+ игры за всё время, последняя раньше конца периода − 60 дней. Считается запросом за весь период (неаддитивно).
- **Скан → свет** (PRODUCT §21): котировка гостя по QR (`quotes.created_at` — первое действие сервера после скана) → ack контроллера на `session.start` этой игры (`device_commands.acked_at`); только игры по QR с оплатой ЮKassa. Время на форме оплаты ЮKassa входит в метрику. Медиана в секундах.
- **Свет без журнала**: команды включения (`session.start`, `session.resume`, `session.extend`, `service.start`) в статусе `sent`/`acked` без записи `device.cmd` с их `cmd_id` (`commands`) и игры без записи `session.start` (`sessions`). Цель — 0.
- **Доля игр без персонала** = игры `source in (qr, booking)` / все игры, кроме турнирных.
- **Ручные действия** — формула отчёта смены (`manualActions`, №125): `manual.*` и действия персонала с причиной; автоматические — отдельно. Причины — текст сотрудника, телефоны в них маскируются.
- **Реакция на тревоги** (№178): `acked_at − raised_at` по видам и по принявшему; принятые позже 10 минут (`slow`) и не принятые (`unacked`) — проблемные (`problem: true`, список `problems`).
- **С `kind`** (тип стола): метрики столов (игры, часы, ёмкость, загрузка, выручка столов, средние чеки игры и цена часа, тепловая карта, таблицы по столам) — только столы этого типа; бар, пакеты, гости, контроль — по клубу.

## Агрегаты и планировщик

- `bl.stats_daily` (клуб × сутки: итоги числами и вся структура суток в `data`), `bl.stats_hourly` (клуб × стол × сутки × местный час: минуты игры, сервиса, брони, ёмкость, начатые игры). RLS по `club_id`, ENABLE и FORCE; `app_api` только читает; пишет только `bl.stats_put_day(day, gen, version, daily, hourly)` — `SECURITY DEFINER`, клуб из контекста, только `actor_type = system`.
- Планировщик (`server/dashboard/index.mjs`, модуль `dashboard` в `server/http/app.mjs`): через 5 с после старта и раз в минуту — каждому активному клубу (`bl.stats_clubs()`) закрытые сутки (через 5 минут после конца) без агрегата и «грязные». Догоняет пропуск после простоя — до 400 суток назад, по 31 суткам за проход на клуб. Каждые сутки — своя транзакция; повтор даёт то же значение.
- Сутки старой версии формул (`VERSION` в `day.mjs`, сейчас 2 — ёмкость округляется один раз на сутки, Н1) пересчитываются в фоне по всем активным клубам, все сохранённые (без горизонта), свежие первыми: не больше 12 суток за проход на все клубы (`RESTATE_PER_TICK`) и 4 на клуб (`RESTATE_PER_CLUB`), не в часы пик клуба — 17:00–02:00 по его местному времени (`RESTATE_PEAK`; переопределяется `ctx.dashboard.restate = { perTick, perClub, peak }`). До пересчёта экран показывает сохранённые сутки. `VERSION` поднимается при любой правке расчёта суток.
- «Грязные» сутки — `bl.stats_dirty`: триггер `bl.stats_mark_dirty` после вставки и изменения `payments` (`confirmed_at`), `refunds` (`created_at`), `sessions` (с начала до конца игры), `resource_holds` (сервис), `bookings` (начало и создание), `alarms` (`raised_at`) отмечает сутки, если они уже закрыты (раньше текущих по часам базы). Счётчик `gen` растёт при каждой отметке; `stats_put_day` снимает отметку, только если `gen` не изменился за время расчёта. Ошибка отметки не мешает записи денег (предупреждение в лог Postgres).
- Текущие сутки и закрытые без агрегата (до 14 за запрос, остальное — `period.missing_days`) считаются на лету той же `computeDay`.
- Смена настроек клуба (`day_start_local`, `open_hours`) прошлые агрегаты не пересчитывает (новая версия формул — пересчитает).

## API

Ошибки: `400 bad_request` (период, вкладка, тип, поле), `401`, `403` (ресепшн, бар, чужой клуб с UUID), `404` (не UUID, нет объекта). Период — не больше 366 суток. Деньги — копейки, форматирует клиент; проценты и часы — с одним знаком; `null` — «нет данных» (честное пустое состояние).

| Маршрут | Кто | Суть |
|---|---|---|
| `GET /api/clubs/{club}/dashboard?from&to&kind&compare&tab` | владелец, управляющий | вкладка `summary` (по умолчанию) · `money` · `hall` · `guests` · `control`; `compare=0` — без прошлого периода; без `from`/`to` — текущие сутки |
| `GET /api/clubs/all/dashboard?…` | владелец, управляющий | «Все мои клубы»: клубы, где пользователь владелец или управляющий (у PIN — клуб терминала); плюс `tables.clubs` |
| `GET /api/clubs/{club\|all}/dashboard/now` | владелец, управляющий | статус зала сейчас |
| `GET /api/clubs/{club\|all}/dashboard/export.csv?from&to&kind&table` | только владелец | `revenue_daily` · `tables` · `hourly` · `manual` · `shifts` · `bookings`; журнал `owner.export` |
| `GET /api/clubs/{club\|all}/history/{orders\|audits\|writeoffs\|arrivals}?from&to&q&status&sort&cursor&limit` | владелец, управляющий | истории §7 |
| `GET /api/clubs/{club\|all}/history/{kind}/export.csv?…` | владелец, управляющий | CSV истории, журнал `owner.export` |
| `GET /api/clubs/{club}/stock/sheet?blind=1` | владелец, управляющий | ведомость ревизии (№174) |
| `GET /api/clubs/{club}/shifts?from&to&staff&status&cursor&limit` | владелец, управляющий | список смен (№176); `status`: `open` · `closed` · `discrepancy`; `before` — прежнее имя `cursor` |
| `GET /api/clubs/{club}/shifts/export.csv?…` | владелец, управляющий | CSV смен, журнал `owner.export` |
| `GET /api/clubs/{club}/cashbook?from&to` | владелец, управляющий | касса управляющего (№177), по умолчанию — текущий месяц |
| `POST /api/clubs/{club}/cashbook` | владелец, управляющий | `{kind: income\|expense, amount_kopecks, category_id, date?, comment?}`, `Idempotency-Key` |
| `POST /api/clubs/{club}/cashbook/{id}/storno` | владелец, управляющий | `{reason}`, `Idempotency-Key`; повтор — `409 duplicate` |
| `GET /api/clubs/{club}/cashbook/categories` | владелец, управляющий | статьи; у нового клуба — набор по умолчанию |
| `POST /api/clubs/{club}/cashbook/categories`, `PATCH …/categories/{id}` | только владелец | `{kind, name, sort?}` (`Idempotency-Key`), `{name?, sort?, active?}` |
| `GET /api/clubs/{club}/cashbook/export.csv?from&to` | владелец, управляющий | CSV книги с остатками |
| `GET /api/clubs/{club}/resources/{id}/sessions?from&to` | владелец, управляющий | «Кто играл за столом» (№179) |
| `POST /api/clubs/{club}/sessions/{id}/guest-phone` | только владелец | `{reason}` → `{session_id, phone}`; журнал `guest.lookup` (без номера), уведомление владельцу (тревога `manual_action`) |

**Управляющий сети** (M5.5 №192, членство в клубе выдано сетью — `ctx.networkManager`): как управляющий, но `tab=money` — `403` (у «всех клубов» такие клубы выпадают из выборки, нет других — `403`), экспорт — `403` (`clubScope(…, { allowNetwork: false })`, у маршрутов клуба — опция `networkManager: false`), в `…/dashboard/now` — `revenue_today.by_method: null`; ключ кэша — отдельный. Вкладка «Сеть» (сравнение клубов сети, №193) — `GET /api/networks/{id}/dashboard`, `server/networks/README.md`.

**Кэш** ответа дашборда в процессе — 60 с на (клуб или пользователь «всех клубов», период, вкладка, тип, сравнение), период с текущими сутками — 15 с, статус зала — 15 с. Кэш — после проверки прав; ответ из кэша — заголовок `X-Cache: hit`. Ограничение частоты — 60 запросов в минуту с IP на маршрут.

## Формы ответов (для frontend)

Пример — живой ответ на наборе сверки (`test/db/harness.mjs`), сокращён `…`.

### Общая часть

```json
{
  "period": { "from": "2026-10-21", "to": "2026-10-23", "days": 3, "timezone": "Asia/Yekaterinburg", "day_start_local": "06:00",
              "today": "2026-10-24", "includes_today": false, "missing_days": [] },
  "compare_period": { "from": "2026-10-18", "to": "2026-10-20" },
  "club": { "id": "c1000000-…", "name": "Тестовый клуб", "mode": "live" },
  "kind": null,
  "tab": "summary",
  "tiles": [ { "id": "revenue", "value": 1110000, "unit": "kopecks", "prev": 0, "delta_pct": null, "parts": [ … ] } ],
  "series": { },
  "tables": { },
  "generated_at": "2026-10-24T12:46:02.282Z"
}
```

`unit`: `kopecks` · `count` · `hours` · `percent` · `seconds`. `delta_pct` — к прошлому такому же периоду (`null`, если прошлое значение 0 или нет данных; ▲▼ по знаку). У «всех клубов» `club: "all"`, `period.timezone` и `day_start_local` — `null` (у каждого клуба свои сутки), плюс `tables.clubs: [{club_id, name, revenue_kopecks, games, play_hours, utilization_pct, guests}]`. `missing_days: [{club_id, day}]` — сутки, которые планировщик ещё не досчитал (показать «данные досчитываются»).

### Плитки и подсказки «i»

| id | Вкладки | Формула простыми словами |
|---|---|---|
| `revenue` | summary, money | Выручка: все оплаты за период минус возвраты. `parts`: столы (с депозитами и предоплатами броней), бар, прочее (пакеты, турниры) — доля от выручки до возвратов |
| `revenue_total`, `refunds` | money | Оплаты до возвратов; возвраты, сделанные в периоде |
| `games` | summary, hall | Игры, начатые в периоде (игра относится к суткам начала) |
| `play_hours` | summary, hall | Часы игры внутри периода (по фактическим минутам) |
| `utilization` | summary, hall | Сыграно / ёмкость (столы в работе × часы работы клуба) |
| `avg_check_game` | summary, money | Выручка столов / число игр |
| `avg_check_bar` | summary, money | Выручка бара / число продаж бара |
| `revenue_per_table_day` | summary | Выручка / столо-дни в работе |
| `avg_hour_price` | summary | Выручка столов / часы игры |
| `guests` (`parts`: new, repeat) | summary, guests | Гости периода; новые — впервые в клубе, повторные — играли раньше |
| `no_staff_share` | summary, control | Доля игр, запущенных гостем по QR или по брони |
| `expenses`, `profit` | summary, money | Расходы кассы управляющего; прибыль = выручка − расходы (управленческий учёт) |
| `cash_net`, `cashless_net` | money | Наличные и безнал за вычетом возвратов |
| `capacity_hours`, `service_hours`, `unrealized_hours` | hall | Ёмкость; сервисный свет; ёмкость − сыграно − сервис |
| `guests_new`, `guests_repeat`, `guests_lost`, `bookings`, `no_show`, `extensions_from_app_share` | guests | Потерянные — 3+ игры и нет 60 дней; продления из приложения — оплачены гостем (QR или пакет) среди всех продлений, включая бесплатные |
| `manual_actions`, `automatic_actions`, `cash_discrepancy`, `alarms`, `alarms_problem`, `lights_without_journal`, `scan_to_light_median_sec` | control | Ручные действия персонала; действия системы; сумма расхождений касс; тревоги; принятые позже 10 мин и не принятые; свет без журнала (цель 0); медиана скан → свет (цель < 20 с) |

### `tab=summary`

```json
"series": { "revenue_daily": [
  { "date": "2026-10-21", "total_kopecks": 1080000, "net_kopecks": 1080000, "tables_kopecks": 345000, "bar_kopecks": 135000, "other_kopecks": 600000, "today": false },
  { "date": "2026-10-22", "total_kopecks": 40000, "net_kopecks": 30000, "tables_kopecks": 40000, "bar_kopecks": 0, "other_kopecks": 0, "today": false } ] }
```

Мини-«Статус зала» — отдельный запрос `…/dashboard/now`.

### `tab=money`

```json
"tables": {
  "structure": [ { "id": "tables", "kopecks": 285000, "pct": 25.4 }, { "id": "deposits", "kopecks": 100000, "pct": 8.9 }, { "id": "bar", "kopecks": 135000, "pct": 12.1 },
                 { "id": "packages", "kopecks": 600000, "pct": 53.6 }, { "id": "tournaments", "kopecks": 0, "pct": 0 }, { "id": "other", "kopecks": 0, "pct": 0 } ],
  "methods":   [ { "id": "cash", "kopecks": 580000, "refunds_kopecks": 0, "pct": 51.8 }, { "id": "card_terminal", "kopecks": 35000, "refunds_kopecks": 10000, "pct": 3.1 },
                 { "id": "sbp", "kopecks": 480000, "refunds_kopecks": 0, "pct": 42.9 }, { "id": "card", "kopecks": 25000, "refunds_kopecks": 0, "pct": 2.2 } ],
  "sources":   [ { "id": "qr", "kopecks": 465000, "pct": 41.5 }, { "id": "reception", "kopecks": 615000, "pct": 54.9 }, { "id": "booking", "kopecks": 40000, "pct": 3.6 },
                 { "id": "tournament", "kopecks": 0, "pct": 0 } ],
  "refunds":   { "count": 1, "total_kopecks": 10000, "by_method": { "cash": 0, "card_terminal": 10000, "sbp": 0, "card": 0 }, "tables_kopecks": 0, "bar_kopecks": 10000 },
  "cash": { "start_kopecks": 500000, "cash_sales_kopecks": 580000, "cash_refunds_kopecks": 0, "collections_kopecks": 580000, "discrepancy_kopecks": -50000,
            "shifts": [ { "club_id": "…", "shift_id": "…", "number": 1, "opened_at": "…", "closed_at": "…", "opened_by_name": "Ресепшн Анна", "closed_by_name": "Ресепшн Анна",
                          "float_kopecks": 500000, "expected_cash_kopecks": 1080000, "actual_cash_kopecks": 1080000, "discrepancy_kopecks": 0, "status": "closed" } ] },
  "daily": [ { "date": "2026-10-21", "total_kopecks": 1080000, "net_kopecks": 1080000, "refunds_kopecks": 0, "tables_kopecks": 345000, "bar_kopecks": 135000,
               "other_kopecks": 600000, "games": 4, "play_minutes": 330, "capacity_minutes": 7680, "today": false,
               "avg_check_game_kopecks": 86250, "avg_check_bar_kopecks": 67500, "utilization_pct": 4.3 } ]
},
"series": { "revenue_30d": [ { "date": "2026-09-24", "total_kopecks": 0, "net_kopecks": 0, "today": false }, … ] }
```

`cash.start_kopecks` — размен первой смены, открытой в периоде (у «всех клубов» — `null`); `collections_kopecks` — инкассации кассы управляющего; `shifts` — смены, закрытые в периоде (и открытая, если период — текущие сутки), `status`: `open` · `closed` · `discrepancy`. `revenue_30d` — 30 суток по конец периода, `today: true` — текущие сутки.

### `tab=hall`

```json
"series": {
  "heatmap": { "rows": [1,2,3,4,5,6,7], "cols": [0,1,…,23],
               "pct": [[null, …, 12.5, 6.3, 12.5, …]], "play_minutes": [[0, …, 60, 30, …]], "capacity_minutes": [[0, …, 480, 480, …]] },
  "ring": { "capacity_minutes": 23040, "played_minutes": 520, "service_minutes": 20, "unrealized_minutes": 22500 },
  "utilization_daily": [ { "date": "2026-10-21", "pct": 4.3, "by_type": { "billiard_pyramid": 5.6, "billiard_pool": 2.1, "billiard_snooker": null } } ]
},
"tables": {
  "by_type": [ { "type": "billiard_pyramid", "tables": 5, "games": 4, "play_minutes": 340, "capacity_minutes": 14400, "service_minutes": 20, "utilization_pct": 2.4, "revenue_kopecks": 265000 } ],
  "by_resource": [ { "resource_id": "e1000000-…", "number": 1, "title": "Стол 1", "type": "billiard_pyramid", "games": 1, "play_minutes": 90, "play_hours": 1.5,
                     "service_minutes": 0, "revenue_kopecks": 75000, "utilization_pct": 3.1, "cloth_hours": 1.5, "cloth_since": null, "cloth_threshold_hours": 1500, "cloth_due": false } ]
}
```

Тепловая карта — 7 × 24: строки — ISO день недели суток (1 = пн), столбцы — местный час; `pct` — загрузка в % (до 100; `null` — клуб закрыт или столов нет), рядом минуты для таблицы-дубля. Минуты игры лежат в часах и сутках своего фактического времени (№187). M5.6: рядом с картой — `series.forecast` (прогноз 7 × 24, медиана за 8 недель) и `hints` (подсказки по цене); в `by_resource` — `cloth_hours` (часы игры с замены сукна, текущий счётчик), `cloth_since`, `cloth_threshold_hours`, `cloth_due`. Формы и правила — `server/maintenance/README.md`.

### `tab=guests`

```json
"tables": {
  "guests": { "total": 3, "new": 3, "repeat": 0, "lost": 0, "new_pct": 100, "repeat_pct": 0 },
  "bookings": { "total": 2, "came": 1, "no_show": 1, "canceled": 0, "upcoming": 0, "came_pct": 50, "lead_minutes_avg": 540 },
  "waitlist": { "offered": 0, "accepted": 0 },
  "extensions": { "paid": 1, "from_app": 1, "free": 0, "total": 1, "from_app_pct": 100 },
  "packages": { "sold": 1, "sold_minutes": 300, "used_minutes": 60 },
  "tournaments": { "fees_kopecks": 0, "participants": 0 },
  "plus": { "matches_counted": 0 }
},
"series": { "guests_daily": [ { "date": "2026-10-21", "new": 3, "active": 3 } ],
            "bookings_daily": [ { "date": "2026-10-22", "total": 2, "came": 1, "no_show": 1, "canceled": 0 } ] }
```

Брони — по дню начала брони; `lead_minutes_avg` — средний срок «бронь → игра» у пришедших. `guests_daily.active` — гостей за сутки (сумма по дням не равна гостям периода).

### `tab=control`

```json
"tables": {
  "manual_by_action": [ { "action": "service.start", "count": 1 } ],
  "manual_by_staff": [ { "user_id": "…", "name": "Ресепшн Анна", "count": 1, "by_action": { "service.start": 1 } } ],
  "manual_items": [ { "at": "…", "action": "service.start", "kind": "staff", "actor_id": "…", "actor_name": "Ресепшн Анна", "reason": "клиент *** пролил",
                      "resource_number": 4, "amount_kopecks": null } ],
  "automatic": { "count": 0, "by_action": {} },
  "shifts": [ { "number": 2, "closed_at": "…", "discrepancy_kopecks": -50000, "status": "discrepancy", … } ],
  "alarms": {
    "total": 3, "by_level": { "critical": 2, "important": 1, "info": 0 }, "slow_after_sec": 600,
    "by_type": [ { "type": "service_light", "count": 1, "acked": 1, "unacked": 0, "slow": 1, "avg_react_sec": 1200, "problem": true } ],
    "by_staff": [ { "user_id": "…", "name": "Управляющий Олег", "count": 2, "slow": 1, "avg_react_sec": 660, "problem": true } ],
    "problems": [ { "alarm_id": "…", "type": "receipt_pending", "level": "important", "resource_number": null, "raised_at": "…", "acked_at": null,
                    "acked_by": null, "acked_by_name": null, "react_sec": null } ]
  },
  "pilot": { "lights_without_journal": { "commands": 0, "sessions": 1 }, "scan_to_light": { "median_sec": 38, "count": 1, "under_20_pct": 0 },
             "no_staff_share_pct": 71.4, "extensions_from_app_pct": 100, "cash_discrepancy_kopecks": -50000 }
}
```

Имена — только сотрудников (№171). Ссылка в журнал: `GET /api/clubs/{club}/audit?action=<action>&from=<at>`. Фильтр «только проблемные» — на клиенте по `problem` и списку `problems` (до 100 последних).

### `…/dashboard/now`

```json
{ "at": "…", "club_id": "…", "day": "2026-10-24",
  "totals": { "total": 8, "busy": 0, "reserved": 0, "service": 0, "free": 8, "offline": 0, "fault": 0, "utilization_now_pct": 0, "utilization_day_pct": 0 },
  "by_type": [ { "type": "billiard_pyramid", "total": 5, "busy": 0, "reserved": 0, "service": 0, "free": 5, "offline": 0, "fault": 0, "utilization_now_pct": 0, "utilization_day_pct": 0 } ],
  "revenue_today": { "total_kopecks": 15000, "net_kopecks": 15000, "by_method": { "cash": 15000, "card_terminal": 0, "sbp": 0, "card": 0 } },
  "games_today": 1,
  "shift": { "shift_id": "…", "number": 4, "opened_at": "…", "opened_by_name": "Ресепшн Анна" },
  "tables": [ { "resource_id": "…", "number": 1, "title": "Стол 1", "type": "billiard_pyramid", "plan_x": 400, "plan_y": 300, "plan_rotation": 0,
                "status": "free", "busy_until": null, "until": null } ] }
```

`status` стола: `busy` · `reserved` (бронь, гость у оплаты) · `service` · `free` · `offline` · `fault`. У `all` — `{at, clubs: [{name, …как выше}], totals}`.

### CSV (№172)

UTF-8 с BOM, `;`, строки CRLF, даты ДД.ММ.ГГГГ, время ЧЧ:ММ по поясу клуба, деньги — рубли с запятой (`1490,50`), отрицательные — числом (`-3000,00`); ячейка, начинающаяся с `= + - @` (кроме чисел), получает апостроф. У `all` первый столбец — «Клуб». Имя файла — `dashboard-<table>-<from>-<to>.csv`. Без телефонов и имён гостей; имена сотрудников — в `manual` и `shifts`. Журнал `owner.export {source, table, from, to, kind, rows, all}` — в цепочку каждого выгруженного клуба.

## Истории (§7, №173–175)

`GET …/history/{kind}` → `{ period: {from, to}, items, next_cursor, totals }`. По умолчанию — текущий месяц (с 1-го числа по сегодня), `sort=-created_at`, `limit=50` (до 200). `next_cursor` — смещение для следующей страницы. `q` — поиск (заказы: номер или товар; ревизии: товар или комментарий; списания и приходы: товар или причина). У `all` — `club_id` в строках.

- `orders` (`status`: `new` · `preparing` · `ready` · `served` · `canceled`; `sort`: `created_at` · `number` · `amount` · `status` · `canceled_at`):
  `{order_id, number, source: qr|pos, status, created_at, canceled_at, cancel_reason, paid_at, guest: {nick, phone_masked} | null, resource_number, amount_kopecks, method, created_by_name, canceled_by_name, lines: [{name, qty, unit_price_kopecks, amount_kopecks, modifiers: [имя]}]}`; `totals: {count, amount_kopecks (без отменённых), canceled}`. Гость — ник Бильярдум+ или маска `+7999***4567`.
- `audits` (`sort`: `created_at` · `items` · `diff_kopecks` · `diff_qty`): `{audit_id, created_at, created_by_name, note, items, mismatches, diff_qty, diff_kopecks, lines: [{product_id, name, unit, expected_qty, actual_qty, diff_qty, unit_cost_kopecks, diff_kopecks}]}`; `totals: {count, diff_kopecks, shortage_kopecks, surplus_kopecks}`.
- `writeoffs` (`status` — источник: `program` (склад в программе клуба) · `pos` (касса: отменённый возврат) · `audit` (недостача ревизии); `sort`: `created_at` · `product` · `qty` · `cost` · `source`): `{movement_id, created_at, created_by_name, source, product, unit, qty, reason, audit_id, cost_kopecks}` — количество и сумма положительные; `totals: {count, cost_kopecks}`.
- `arrivals` (`sort`: `created_at` · `product` · `qty` · `cost` · `unit_cost`): `{movement_id, created_at, created_by_name, supplier: null, product, unit, qty, unit_cost_kopecks, cost_kopecks, note}`; `totals: {count, cost_kopecks}`. Поставщика в модели склада нет — `null`.

Ведомость ревизии `GET /api/clubs/{club}/stock/sheet?blind=1` → `{club: {id, name}, blind, generated_at, groups: [{category_id, name, items: [{product_id, name, unit, system_qty, actual_qty: null}]}], items_count}`; группы — категории меню по порядку, в конце «Без группы»; `blind=1` — `system_qty: null`.

## Список смен (№176)

`GET /api/clubs/{club}/shifts` → `{items: [смена как раньше + revenue_total_kopecks, is_test, state: open|closed|discrepancy], next_cursor}`; `from`/`to` — сутки открытия смены, `staff` — открыл или закрыл, `cursor` — номер смены. Строка открывает `GET /api/shifts/{id}/report`.

## Касса управляющего (№177)

`GET …/cashbook` → `{period, opening_kopecks, income_kopecks, collections_kopecks, expenses_kopecks, closing_kopecks, by_category: [{category_id, kind, name, amount_kopecks, count}], entries: [{entry_id, kind: income|expense|collection, amount_kopecks, signed_kopecks, category_id, category, date, comment, shift_id, reverses_id, reversed_by, reason, created_by, created_by_name, created_at}], categories: [{category_id, kind, name, sort, active}]}`.

- Остаток на конец = начало + доходы + инкассации − расходы; у сторно сумма со знаком минус (расход −3 000 ₽ уменьшает расходы).
- Инкассация — автоматически при закрытии смены (планировщик раз в минуту и при открытии кассы): наличные при закрытии минус размен, сутки — закрытия смены, одна запись на смену; смена без излишка над разменом — без записи.
- Дата записи (№189): не в будущем и не раньше чем 35 дней назад, иначе `400 bad_request`. Запись раньше вчерашних суток (задним числом) — уведомление владельцу `cashbook.backdated` (не тревога): вид, сумма, статья, дата, кто внёс; без комментария.
- Статья, запись для сторно и статья для правки ищутся с явным `club_id` клуба запроса (второй рубеж к RLS): чужой id — `404 not_found`.
- Записи не правятся и не удаляются (триггер базы `bl.cashbook_append_only` для всех ролей); сторно — новой записью той же статьи датой сторно, прошлые остатки не меняются; у исходной записи — `reversed_by`.
- Статьи по умолчанию: расходы «Аренда», «Коммунальные», «Закупка», «Зарплата», «Ремонт столов», «Прочее»; доходы «Прочие доходы», «Начальный остаток». Статья выключается, не удаляется.
- Журнал: `cashbook.collection`, `cashbook.entry`, `cashbook.storno` (с причиной), `cashbook.category_create`, `cashbook.category_update`.

## «Кто играл за столом» (№179)

`GET …/resources/{id}/sessions?from&to` → `{resource: {id, number, title, type}, period, items: [{session_id, started_at, ended_at, status, source, players, amount_kopecks, methods, guest: {nick, phone_masked} | null, staff_name}]}` — до 1 000 игр, новые сверху; `staff_name` — если игру оплатил сотрудник. Полный телефон — `POST …/sessions/{id}/guest-phone {reason}` (только владелец; узкая функция `bl.guest_phone(session_id, user_id)` проверяет в базе клуб, участие гостя в игре и владельца): ответ `{session_id, phone}` не кэшируется (`no-store`), в журнал — `guest.lookup` с причиной без номера, владельцу — уведомление.

## Тесты

- `node --test server/dashboard/test/*.test.mjs` (входит в `npm test -w @billiardum/server`) — сутки и пояса (в том числе 23- и 25-часовые), часы работы, столы в работе, CSV, разбор периода.
- На базе (`scripts/ci-test-db.mjs` подхватывает `server/dashboard/test/db`): `reconcile.test.mjs` — сверка дашборд = отчёты смен = утренняя сводка по суткам до копейки (QR и касса, продление, бар, депозит, пакет, возврат на следующий день, игра через границу суток (игры, часы и деньги = сводка и сумма смен), тестовый клуб, заморозка с поздним списанием и пересчёт «грязных» суток, текущие сутки с ручными действиями), карта и кольцо, CSV = экран, права записи агрегатов; `access.test.mjs` — роли (T30); `m52-extra.test.mjs` — истории, ведомость, смены, касса, «Кто играл».

```
DATABASE_ADMIN_URL=postgres://… node --test --test-concurrency=1 server/dashboard/test/db/*.test.mjs
```
