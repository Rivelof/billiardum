# Прогноз загрузки, подсказки по цене, обслуживание столов (M5.6)

Контракт — `docs/contracts/m5-5-8.md` (M5.6), решения №196–198. Код: `server/dashboard/forecast.mjs` (прогноз и подсказки), `server/maintenance/` (обслуживание: `service.mjs`, планировщик `index.mjs`), маршруты `api/routes/forecast.mjs`, `api/routes/maintenance.mjs`, вкладка «Зал» дашборда (`server/dashboard/service.mjs`). Миграция `1250_maintenance.sql`. Расчёт суток дашборда не менялся — `VERSION` прежний (2).

## Прогноз (№196)

- История — закрытые рабочие сутки клуба за последние **8 недель** (56 суток по вчерашние) из `bl.stats_hourly`. Сутки без агрегата (ещё не досчитаны) не входят.
- `is_test` не учитывается: тестовые игры не входят в агрегаты суток; сутки до перехода клуба в live (`went_live_at`) не входят; клуб, не бывший в live (`test`, `suspended` после `test`), прогноза не имеет.
- Ячейка (ISO день недели × местный час) — **медиана** загрузки этой ячейки по суткам истории: загрузка суток в часе = минуты игры / ёмкость (до 100 %). Часы, когда клуб закрыт (ёмкость 0), в медиану не входят; ячейка без образцов — `null`. С `kind` — только столы типа.
- **Праздники клуба** (`bl.holidays`: федеральный календарь и свои дни клуба) — как выходной, тем же правилом, что у тарифов: сутки праздника идут в день недели `holiday_iso_day` клуба (по умолчанию 7 — воскресенье). Прогноз на дату-праздник — строка этого дня.
- Меньше **14 суток** истории — прогноза нет: `status: "insufficient_data"`, `pct: null` («мало данных, прогноз появится через …»). Подписывать «прогноз», без обещаний точности.
- Окно не зависит от периода дашборда.

## Подсказки по цене (№197)

Только текст — цены не меняются. Пороги — `HINTS` в `server/dashboard/forecast.mjs`:

| Константа | Значение | Смысл |
|---|---|---|
| `LOW_PCT` | 20 | «дневная цена»: по будням загрузка часа ниже 20 % |
| `LOW_MIN_HOURS` | 3 | … подряд не меньше 3 часов |
| `HIGH_PCT` | 85 | «можно поднять цену»: в день недели загрузка часа выше 85 % |
| `QUEUE_SHARE` | 0,5 | … или очередь: гости вставали в лист ожидания в этом часе не меньше чем в половине таких дней |
| `HIGH_MIN_HOURS` | 2 | … подряд не меньше 2 часов |
| `MIN_WEEKS` | 4 | час входит, только если данные по нему есть за 4+ разные недели |
| `MAX_HINTS` | 10 | не больше подсказок |

- Будни — пн–пт без праздников. Загрузка окна — сумма минут игры / сумма ёмкости по всем суткам окна (не медиана).
- Одинаковое окно разных дней недели — одна подсказка («В пятницу и субботу 20–23 …»). Окно — в порядке рабочих суток, через полночь — «23–02».
- Очередь — `bl.waitlist.created_at` (час постановки по местному времени).
- Тексты: «В будни 14–17 загрузка 12,5 % за 8 недель — подумайте о дневной цене», «В пятницу 20–23 загрузка 91,7 % за 8 недель — можно поднять цену», «В субботу 21–23 очередь в 6 из 8 дней (загрузка 60 %) — можно поднять цену». Сначала `raise_price`, затем `lower_price`.

## Обслуживание столов (№198)

- Событие: стол, вид (`cloth` — замена сукна, `balls` — шаров, `cushions` — резины бортов, `leveling` — выравнивание, `other` — другое), рабочие сутки, комментарий (до 500), стоимость в копейках, кто. Дата — не в будущем и не старше 366 суток; со стоимостью > 0 — не старше 35 суток (правило кассы №189).
- Только добавление (триггер базы для всех ролей). Исправление — новое событие `corrects_id` + `reason` (обязательна, иначе `400 reason_required`), поля по умолчанию — из исправляемого; одно исправление на событие (`409 duplicate`); `void: true` — «события не было». Исправленное и «не было» в счётчике не участвуют.
- Стоимость > 0 — расход кассы управляющего по статье «Ремонт столов» (ищется по имени без регистра, нет — создаётся; выключенная тоже годится) датой события, со ссылкой `maintenance_event_id`; задним числом — уведомление владельцу, как у кассы. Исправление сторнирует расход исправляемого (если его не сторнировали вручную) и вносит новый.
- **Счётчик** — часы игры стола с последнего действующего события вида: закрытые сутки — из `bl.stats_hourly`, текущие и недосчитанные — по сессиям (фактические минуты, без `cancelled` и `is_test`, как у суток дашборда). Событие, отмеченное в свои же сутки, — с момента отметки; задним числом — с начала следующих суток; без событий — с начала учёта (`since: null`).
- **Пороги** — `clubs.settings.maintenance_thresholds`, часы; по умолчанию сукно 1 500, шары 3 000, резина 5 000, выравнивание и другое — без порога (`null`).
- Планировщик (модуль `maintenance` после `clubapi`, раз в 10 минут, первый проход через 30 с): порог достигнут — уведомление `maintenance.due` (уровень `info`, **не тревога**) управляющему и владельцу, одно на (стол, вид, событие, порог) — `bl.maintenance_alerts`. Новое событие или новый порог — новое уведомление. Выведенные из работы столы не уведомляют.
- Журнал: `maintenance.event`, `maintenance.correct` (с причиной), `maintenance.thresholds_update {before, after}`, `maintenance.threshold_reached` (система); касса — `cashbook.entry`, `cashbook.storno`, при создании статьи — `cashbook.category_create`.

## API

Роли — владелец и управляющий; ресепшн, бар, чужой клуб — `403`. Ошибки только кодом.

| Маршрут | Суть |
|---|---|
| `GET /api/clubs/{club}/dashboard?tab=hall…` | плюс `series.forecast`, `hints`, в `tables.by_resource` — `cloth_*` |
| `GET /api/clubs/{club}/forecast?date&kind` | прогноз на сутки (без `date` — сегодня; ±366 суток, иначе `400`) |
| `GET /api/clubs/{club}/maintenance?resource_id&kind&limit` | счётчики, пороги, события (новые сверху, `limit` до 200, по умолчанию 100) |
| `POST /api/clubs/{club}/maintenance` | событие или исправление, `Idempotency-Key`; `201` |
| `GET /api/clubs/{club}/maintenance/thresholds` | пороги |
| `PUT /api/clubs/{club}/maintenance/thresholds` | `{cloth?, balls?, cushions?, leveling?, other?}` — часы 1–100 000 или `null`; только переданные виды |

`400 bad_request` — неверное поле (подробность в логе), `404 not_found` — стол или исправляемое событие не этого клуба, `409 duplicate` — событие уже исправлено.

## Формы ответов (для frontend)

### `tab=hall` — новое

```json
"series": {
  "heatmap": { … как раньше … },
  "forecast": {
    "status": "ok", "enough": true, "label": "прогноз", "weeks": 8, "from": "2026-08-29", "to": "2026-10-23",
    "history_days": 56, "history_weeks": 8, "min_days": 14, "holiday_iso_day": 7,
    "rows": [1,2,3,4,5,6,7], "cols": [0,1,…,23],
    "pct": [[null, …, 50, 50, 12.5, 12.5, 12.5, 50, …]], "samples": [[0, …, 8, 8, 8, …]], "days_pct": [24.6, 24.6, 24.6, 24.6, 30.4, 50, 50]
  }
},
"hints": [
  { "id": "raise_price:5:20-22", "type": "raise_price", "days": [5], "from_hour": 20, "to_hour": 23, "hours": 3,
    "utilization_pct": 100, "queue_days": 0, "sample_days": 8, "weeks": 8,
    "text": "В пятницу 20–23 загрузка 100 % за 8 недель — можно поднять цену" },
  { "id": "lower_price:1-5:14-16", "type": "lower_price", "days": [1,2,3,4,5], "from_hour": 14, "to_hour": 17, "hours": 3,
    "utilization_pct": 12.5, "queue_days": null, "sample_days": null, "weeks": 8,
    "text": "В будни 14–17 загрузка 12,5 % за 8 недель — подумайте о дневной цене" }
],
"tables": { "by_resource": [ { …как раньше…, "cloth_hours": 412.5, "cloth_since": "2026-10-17", "cloth_threshold_hours": 1500, "cloth_due": false } ] }
```

- `forecast` 7 × 24 как `heatmap`: строки — ISO день недели (1 = пн), столбцы — местный час; `samples` — сколько суток вошло в медиану; `days_pct` — медиана загрузки суток по дню недели. Мало данных: `{"status": "insufficient_data", "enough": false, "pct": null, "samples": null, "days_pct": null, "history_days": 10, …}`.
- `to_hour` — час конца окна (не включительно, `0` — полночь). `days` — ISO дни недели.
- У «всех клубов» `forecast: null` (у каждого клуба свои сутки), подсказки — по каждому клубу с `club_id` и `club_name`.
- `cloth_hours` — часы игры с последней замены сукна (текущий счётчик, не за период); `cloth_since` — сутки замены (`null` — с начала учёта); `cloth_due` — порог достигнут.

### `GET …/forecast?date=2026-11-04`

```json
{ "club_id": "…", "kind": null, "date": "2026-11-04", "iso_dow": 3, "basis_dow": 7, "holiday": { "title": "День народного единства" },
  "label": "прогноз", "status": "ok", "enough": true, "history_days": 56, "history_weeks": 8, "min_days": 14,
  "window": { "from": "2026-08-29", "to": "2026-10-23" }, "day_pct": 50,
  "hours": [ { "hour": 6, "pct": null, "samples": 0 }, …, { "hour": 14, "pct": 50, "samples": 9 }, …, { "hour": 5, "pct": null, "samples": 0 } ],
  "generated_at": "…" }
```

`hours` — 24 часа в порядке рабочих суток (с часа `day_start_local`). Кэш процесса 60 с (`X-Cache: hit`).

### `GET …/maintenance`

```json
{
  "thresholds": { "cloth": 1500, "balls": 3000, "cushions": 5000, "leveling": null, "other": null },
  "defaults":   { "cloth": 1500, "balls": 3000, "cushions": 5000, "leveling": null, "other": null },
  "kinds": [ { "kind": "cloth", "label": "Замена сукна" }, { "kind": "balls", "label": "Замена шаров" }, { "kind": "cushions", "label": "Замена резины бортов" },
             { "kind": "leveling", "label": "Выравнивание" }, { "kind": "other", "label": "Другое" } ],
  "counters": [ { "resource_id": "…", "number": 1, "title": "Стол 1", "type": "billiard_pyramid", "active": true,
                  "kinds": { "cloth": { "hours": 412.5, "minutes": 24750, "since": "2026-10-17", "event_id": "…", "threshold_hours": 1500, "due": false },
                             "balls": { "hours": 1210, "minutes": 72600, "since": null, "event_id": null, "threshold_hours": 3000, "due": false }, … } } ],
  "events": [ { "event_id": "…", "resource_id": "…", "resource_number": 1, "kind": "cloth", "date": "2026-10-17", "comment": "Сукно Iwan Simonis",
                "cost_kopecks": 1500000, "corrects_id": null, "corrected_by": null, "voided": false, "reason": null,
                "cashbook_entry_id": "…", "created_by": "…", "created_by_name": "Управляющий Олег", "created_at": "…" } ]
}
```

`counters` — все столы клуба (и выведенные из работы, `active: false`), по номеру. `events` — с исправлениями: у исправленного `corrected_by`, у исправления `corrects_id` и `reason`; `cashbook_entry_id` — действующий расход (без сторно). Ответ `POST` — событие в той же форме.

### `POST …/maintenance`

```json
{ "resource_id": "…", "kind": "cloth", "date": "2026-10-17", "comment": "Сукно Iwan Simonis", "cost_kopecks": 1500000 }
{ "corrects_id": "…", "reason": "опечатка в сумме", "cost_kopecks": 1000000 }
{ "corrects_id": "…", "reason": "не меняли", "void": true }
```

### Касса

Записи кассы (`GET …/cashbook`) получили поле `maintenance_event_id` (`null` у прочих).

## Тесты

- `node --test server/dashboard/test/forecast.test.mjs server/maintenance/test/*.test.mjs` (входит в `npm test -w @billiardum/server`) — медиана = независимый расчёт, праздник, «мало данных», окно live, подсказки по порогам и тексты, границы порогов, объединение дней, окно через полночь; пороги, момент начала счётчика, план подсчёта.
- На базе (`scripts/ci-test-db.mjs` подхватывает `server/maintenance/test/db`): `m56.test.mjs` — **T43** (8 недель игр → агрегаты планировщиком → прогноз = медиана по `stats_hourly`, праздник клуба, тестовая игра не входит, подсказки, `…/forecast?date=`, мало данных) и **T44** (права, событие, расход «Ремонт столов», журнал, счётчик = агрегаты + текущие сутки, проверки, порог и одно уведомление владельцу и управляющему без тревоги, исправление со сторно, «не было», только добавление, изоляция). Изоляция таблиц — `supabase/tests/isolation.test.mjs`.

```
DATABASE_ADMIN_URL=postgres://… node --test --test-concurrency=1 server/maintenance/test/db/*.test.mjs
```
