# Мастер подключения клуба — часть backend-B (`server/setup/`, M5.1 №155–159)

Контракт: `docs/contracts/m5-1.md`. Режим клуба, магазины ЮKassa и чек-лист — backend-A; здесь зал,
тарифы, наклейки и функции для чек-листа. Маршруты — `api/routes/setup.mjs`, наклейки — `api/routes/owner.mjs`.

## Функции для чек-листа (§3)

Импорт: `import { resources, tariffs, qr } from '../setup/index.mjs'`. Все принимают `db` — транзакцию
в контексте клуба (RLS отдаёт только его строки).

| Функция | Ответ | Пункт №160 |
|---|---|---|
| `resources.activeCount(db, clubId)` | число столов в работе | 1 |
| `tariffs.coversWeek(db, clubId)` | `true`, если у каждого стола в работе каждая минута недели покрыта правилом (свои правила стола и правила его типа, как в движке) | 3 |
| `tariffs.weekCoverage(db, clubId)` | `{ ok, problem: null \| {type:'gap', kind, weekday, from, to, resource_id?} }` — первая дыра для `detail` | 3 |
| `qr.printedAt(db, clubId)` | `Date` последней выгрузки QR-наклеек любого стола или `null` | 6 |
| `qr.printStatus(db, clubId)` | `{ active, printed, printed_at }` — сколько столов в работе с выгруженной наклейкой | 6 |

## Столы и план (№155) — `hall.mjs`

- `GET /api/clubs/{club}/resources` → `{ plan: {width_cm, height_cm}, resources: [стол] }`, и выведенные из работы.
- `POST /api/clubs/{club}/resources {number, kind, title?, plan_x?, plan_y?, plan_rotation?, reason?}` → `201` стол.
- `PATCH /api/clubs/{club}/resources/{id} {number?, kind?, title?, plan_x?, plan_y?, plan_rotation?, active?, reason?}` → стол.
- `PUT /api/clubs/{club}/hall {width, height}` (сантиметры, 100…100 000) → `{ plan }`.
- Стол: `{id, number, kind, type, title, code, plan_x, plan_y, plan_rotation, active, sticker_printed_at, created_at}`;
  `kind` — `pyramid | pool | snooker | mixed` (в базе `billiard_*`, `billiard_mixed` — миграция 1050).
  Координаты — центр стола в сантиметрах от левого верхнего угла зала, поворот 0…359.
- Код стола — по умолчанию базы (`bl.gen_resource_code`). Название по умолчанию «Стол N».
- Удаления нет. Вывести нельзя стол с игрой (`active`, `ending`, `grace`, `interrupted`), удержанием
  (`pending`, `reserved`, `service`), бронью впереди или турниром (`draft`…`running`, не закончился):
  `409 table_busy {reason: session|pending|reserved|service|booking|tournament, resource_id}`.
  Номер занят — `409 duplicate`. Не больше 200 столов — `409 limit_exceeded`.
- Только владелец и управляющий. Журнал: `resource.create`, `resource.update` (с `changed: {поле: {from, to}}`),
  `resource.deactivate`, `resource.activate`, `hall.update`.
- В `live` добавление, вывод и возврат стола — ручное действие `manual.resource_add` / `manual.resource_remove`:
  `reason` обязателен (`400 reason_required`), журнал и тревога `manual_action` владельцу (через `ctx.manual`
  backend-A, без него — свой путь в `mode.mjs`). Позиция, номер, тип, название и размер зала — только журнал.

## Тарифы (№156) — `tariffs.mjs`

- `GET /api/tariff-templates` (любой вошедший) → `{ defaults: {min_minutes: 30, step_minutes: 1}, templates: [{id, title, description, params: [{key, title}], rules: [{days, from, to, price: <ключ параметра>}]}] }`.
  Шаблоны: `single`, `weekdays_weekend`, `day_evening`, `day_evening_night`, `weekdays_weekend_day_evening`.
  Границы — от 06:00 (начало рабочих суток, №43). `applyTemplate(id, prices, {kind, min_minutes, step_minutes})` собирает правила.
- `GET /api/clubs/{club}/tariffs` → `{ timezone, day_start_local, rules, resource_rules, coverage }`; одинаковые правила всех четырёх типов — одно правило `kind: null`.
- `PUT /api/clubs/{club}/tariffs {rules, reason?}` → как `GET`. Правило: `{kind?: тип|null (все типы), days: [1..7], from: 'HH:MM', to: 'HH:MM' (24:00; from = to — сутки), price_per_hour_kopecks, min_minutes (0…1440), step_minutes (1…60)}`, до 100 правил.
- Проверка — по рабочим суткам клуба в его поясе, как в движке: для каждого типа столов в работе и каждого типа из правил
  каждая минута недели — ровно одно правило. Пересечение — `400 tariff_overlap`, дыра — `400 tariff_gap`, оба с
  `{kind?, weekday, from, to}` (`weekday` — день рабочих суток: ночь пятницы до 06:00 — пятница; `from/to` — местное время).
- Сохранение заменяет все правила клуба: прежние гаснут (`active = false`), новые — строка на каждый тип.
  `test` — журнал `tariff.update` (`before`, `after`); `live` — `manual.tariff_change` с причиной и тревогой (инвариант 8).

## Наклейки столов (№159) — `stickers.mjs`

`GET /api/clubs/{club}/qr-stickers.pdf[?resources=id,id]` — по выбранным столам в работе (неверный список — `400`,
чужой или выведенный стол — `404`). Выгрузка ставит `resources.sticker_printed_at` и пишет `qr.stickers_printed`.

## Связанное вне `setup/`

- Импорт меню `.xlsx` — `catalog/xlsx.mjs`, `lib/unzip.mjs`, `http/multipart.mjs` (README каталога).
- Приглашение ссылкой (№158) — `staff/index.mjs` `inviteMessage`: ответ `POST …/staff` и `POST …/staff/invites` дополнен `invite_url` (`https://{PUBLIC_HOST}/club/`) и `invite_text` (клуб, роль, срок; без телефона).
- QR корпуса (№159) — `devices/qr.mjs` (`BLD1:{device_id}:{claim_code}`, код 8…63 символа), `devices/bind.mjs` (`{qr, resource_id}`, заводской реестр), `qr/device-stickers.mjs`, `scripts/provision-factory.mjs`.
- Заявка «Заказать комплект» — `POST /api/leads {kind: 'kit', …}` (`directory/leads.mjs`, миграция 1052).

## Тесты

- `node --test "setup/test/*.test.mjs"` — шаблоны и неделя, BLD1, заводские коды и наклейки.
- `setup/test/db/setup.test.mjs` (`npm run test:db` в корне) — столы, live/test, тарифы и движок, наклейки, приглашение, `.xlsx`.
- `test/light/setup-bind.test.mjs` — привязка по QR, реестр (5 неверных → 30 минут), лимиты claim, №162: в проде (`NODE_ENV=production`) bind и claim — только устройства из `bl.device_factory` (миграция 1053), в разработке — и без реестра.
