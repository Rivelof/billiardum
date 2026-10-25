# @billiardum/shared

Общий пакет интерфейсов «Бильярдума»: токены дизайна, локальные шрифты, склонения и форматы ru-RU. Без зависимостей. Владелец — frontend, остальные модули только импортируют.

| Файл | Что внутри |
|---|---|
| `tokens.css` | цвета `docs/DESIGN.md` §2, редакция №127: тёмная тема по умолчанию (эспрессо, орех, слоновая кость, зелёное сукно, янтарь, латунь), светлая — только `data-theme="light"`; токены зала `--hall-*` (орех, паркет, латунь, сукно); шрифты и шкала §3, скругления §5, движение §6 (`--lamp-duration`, `--motion-screen`, `--cue-easing`) |
| `fonts.css`, `fonts/` | Dela Gothic One, Geologica 300–700 (вариативный), JetBrains Mono 500 и 700; WOFF2, кириллица и латиница; лицензии `fonts/OFL-*.txt` |
| `format.mjs` | `plural`, `formatMoney`, `formatTime`, `formatDate`, `formatDateShort`, `formatDuration` |
| `ui.css` | базовые стили интерфейса: сброс, кнопки, поля, флажок, плитки выбора, бейджи, сообщения, диалог (лист снизу на телефоне), чек |
| `hall.mjs`, `hall.css` | зал: `tableSvg` (стол сверху, пирамида и пул в настоящих пропорциях: ореховый борт с бликом, латунные накладки у луз, сукно с виньеткой, лампа и её конус через `--lit`), пол плана — паркет на CSS-градиентах, `planLayout` (расстановка на плане), `tableState` (статус словом), `tableKind`, `typeLabel` |
| `api.mjs` | клиент API по контракту: `createClient` (JSON, cookie, `Bearer`, `Idempotency-Key`), `ApiError` с кодом, `openStream` (SSE с переподключением), `newIdempotencyKey` |
| `errors.mjs` | тексты ошибок API для людей: `errorMessage(err, { audience: 'guest' \| 'staff', busyUntil })` → что случилось и что делать |
| `reasons.mjs` | коды причин ручных действий: отклонение заявки, сервисный свет, скидка выше лимита, списание со склада, возврат взноса за турнир после старта (`LATE_REFUND_REASONS`, `CANCEL_REFUND_CODES`, №149) |
| `booking.mjs` | бронь (M3): время по поясу клуба (`zonedMs`, `localDate`), деления борт-шкалы (`boardSlots`), свободное окно и длительности, столы на время, цена по тарифу стола и предоплата, удержание, мои брони, условия отмены словами, «можно продлить до 20:55» (№106), лист ожидания (таймер 5 минут), баланс пакета в котировке (`use_balance`), порядок каналов уведомлений |
| `bar.mjs` | бар (M2): меню в один вид (оба ответа backend-pos), модификаторы (по умолчанию, выбор, проверка), корзина в копейках, статусы заказа словами, очередь бара, ожидание, позиция заказа без хвоста модификаторов в имени (`itemView`, `itemsLine`) |
| `icons.mjs` | значки: линейные пути 24×24, толщина 1,75 |
| `break.mjs` | разбой пирамиды без фреймворка (M4, остров сайта): `simulateBreak` (та же физика, что у главной гостя), `breakSvg` (собранная пирамида — сервер и `prefers-reduced-motion`), `mountBreak(canvas)` (кадры по прокрутке); стили `.brk-*` в `hall.css` |
| `styleguide.html` | образец: палитра обеих тем с живым контрастом, шрифты, кнопки, статусы, таймер, план зала из 8 столов |
| `test/` | `node --test`: форматы, токены против DESIGN.md, контраст WCAG, шрифты и отсутствие внешних ресурсов |

## Подключение

HTML (статика со своего сервера, decisions №22):

```html
<link rel="preload" href="/shared/fonts/geologica-cyrillic-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/shared/fonts.css">
<link rel="stylesheet" href="/shared/tokens.css">
```

`fonts.css` ссылается на `./fonts/…`, поэтому папку `fonts/` раздают рядом с ним. Сборщик (Vite и подобные) сам перенесёт файлы:

```js
import '@billiardum/shared/fonts.css';
import '@billiardum/shared/tokens.css';
import '@billiardum/shared/ui.css';     // базовые стили web/guest и web/admin
import '@billiardum/shared/hall.css';   // рисунок стола
import { plural, formatMoney } from '@billiardum/shared/format';
import { createClient } from '@billiardum/shared/api';
import { errorMessage } from '@billiardum/shared/errors';
import { normalizeMenu, addProduct, cartTotals } from '@billiardum/shared/bar';
```

`api.mjs`, `errors.mjs`, `hall.mjs` без зависимостей и без фреймворка: рисунок стола — строка SVG на классах `hall.css` (без атрибутов `style`, поэтому работает при CSP `style-src 'self'`).

Базовые стили страницы пакет не задаёт. Минимум:

```css
body {
  background: var(--paper);
  color: var(--ink);
  font: var(--fs-body)/var(--lh-body) var(--font-text);
}
h1, h2 { font-family: var(--font-display); font-weight: 400; }
.timer, .receipt { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
```

## Темы

- По умолчанию светлая, тёмная — по `prefers-color-scheme: dark`.
- Вручную: `<html data-theme="dark">`; `data-theme="light"` включает светлую даже при тёмной системе. Без атрибута — как в системе.
- `data-theme` работает и на любом элементе: поддерево получает свою тему (превью, демо на «Для клубов»).
- Токены зала `--hall-*` одинаковы в обеих темах: план зала и ТВ-экраны всегда тёмные.

## Токены

Цвета: `--paper`, `--card`, `--card-2`, `--line`, `--ink`, `--ink-2`, `--ink-3`, `--cloth`, `--cloth-deep`, `--cloth-tint`, `--lamp`, `--lamp-tint`, `--ball-red`, `--free`, `--on-cloth` (текст на кнопке `--cloth`), `--on-lamp` (текст на заливке `--lamp`); зал: `--hall-bg`, `--hall-line`, `--hall-cloth-off`, `--hall-cloth-on`, `--hall-rail`, `--hall-text`, `--hall-text-2`, `--hall-ivory-hi` (блик на шаре), `--hall-alert` («в эфире» на тёмном зале в обеих темах). Значения — строго из DESIGN.md §2 (с правками decisions №36); тест сверяет их с таблицами документа.

`--line-strong` — граница полей ввода и других элементов управления: светлая `#7A869A`, тёмная `#677387`, не меньше 3:1 на `--paper`, `--card` и `--card-2` (WCAG 1.4.11). `--line` (1,3–1,4:1) — для разделителей, не для границ полей.

Шрифты: `--font-display`, `--font-text`, `--font-mono`. Шкала: `--fs-13`, `--fs-15`, `--fs-17`, `--fs-20`, `--fs-24`, `--fs-32`, `--fs-44`, `--fs-64`; `--fs-body` (17 px), `--lh-body` (1,55), `--lh-heading`.
Скругления: `--radius-sm` 6 px (план зала, таблицы), `--radius-md` 12 px (карточки), `--radius-pill` (фильтры, бейджи).
Сетка: `--layout-max` 1200 px, `--layout-columns` 12, `--gutter` 16 px.
Движение: `--lamp-duration` 0,6 с, `--lamp-easing`, `--motion-fast`; при `prefers-reduced-motion: reduce` длительности равны 0.

## Шрифты и знак рубля

Подмножества — кириллица и латиница из Fontsource 5.3.0. В них нет «₽» (U+20BD), а в Dela Gothic One его нет совсем. Поэтому:

- для Geologica и JetBrains Mono подключён файл latin-ext с `unicode-range: U+20BD`: браузер скачивает его, только если на странице есть «₽» (22 КБ и 7,5 КБ на начертание);
- в крупной цене Dela Gothic One знак берётся из Geologica, следующей в `--font-display`. Чтобы знак был жирным, оберните его: `<span style="font-family: var(--font-text); font-weight: 700">₽</span>`.

Обновить шрифты:

```sh
npm pack @fontsource/dela-gothic-one @fontsource-variable/geologica @fontsource/jetbrains-mono --pack-destination /tmp/fonts
# из files/ взять *-cyrillic-*, *-latin-* (и latin-ext для ₽) нужных начертаний, LICENSE → fonts/OFL-*.txt
```

В зависимости пакеты Fontsource не добавляются.

## Форматы

```js
plural(5, ['стол', 'стола', 'столов'])           // 'столов'; дробные → вторая форма: 1,5 стола
formatMoney(149000)                               // '1 490 ₽'
formatMoney(149050)                               // '1 490,50 ₽'
formatMoney(149050n)                              // bigint тоже можно
formatTime(new Date(), 'Asia/Yekaterinburg')      // '21:30', '09:05', '00:30'
formatDate(new Date(), 'Asia/Yekaterinburg')      // '21 октября'
formatDateShort(new Date(), 'Asia/Yekaterinburg') // '21.10' — плотные таблицы и печать
formatDuration(3_900_000)                         // '1:05:00'; меньше часа — '5:00', '0:42'
```

- Деньги — только целые копейки (`Number.isSafeInteger` или `bigint`), иначе `TypeError`. Пробелы неразрывные (U+00A0), как у `Intl` ru-RU.
- Часовой пояс обязателен: время клуба показываем по его поясу, а не по поясу устройства (инвариант 10). Без пояса — `TypeError`.
- `formatDuration` отбрасывает доли секунды, отрицательное показывает как `0:00`.

## Проверка

```sh
npm test -w @billiardum/shared      # или: cd shared && npm test
```

Тест контраста проверяет обе темы: текст не меньше 4,5:1, границы полей не меньше 3:1, и печатает сводку с фактическими числами. Сейчас все пары проходят. Самые узкие места — ровно на пороге: `--ink-3`, `--free`, `--ball-red` на `--card-2` в светлой теме (4,50–4,53:1), `--ink-3` и `--cloth` на `--card-2` в тёмной (4,51:1); оттенки темнее или светлее этих значений менять только с проверкой теста.

Белый текст на тёмном `--cloth` даёт 3,54:1, поэтому в тёмной теме текст кнопки тёмный (`--on-cloth`, 5,39:1).

Механизм `KNOWN_GAPS` в `test/tokens.test.mjs` позволяет зафиксировать провал как `todo` с фактическим числом, пока DESIGN.md не исправлен: сборка не падает, числа видны в выводе.

## Образец стиля

`styleguide.html` открывается через любой статический сервер из папки `shared/`, например `python3 -m http.server -d shared 8080` → `http://localhost:8080/styleguide.html`. С диска (`file://`) тоже открывается, но браузер не даёт загрузить `format.mjs`: после клика по столу счётчики показываются без склонения.

## M5.1

- `errors.mjs`: `clubs_limit`, `checklist_incomplete`, `club_suspended`, `shop_invalid`, `shop_mode_mismatch`, `fiscalization_off`, `tariff_gap`, `tariff_overlap` (с `{weekday, from, to}` — «В среду с 02:00 до 06:00 нет цены.»), `xlsx_invalid`, `qr_invalid`.
- `api.mjs`: `rawBody` и `contentType` — тело файлом (импорт `.xlsx`); поля ошибок `weekday`, `from`, `to`, `resource_type` и список `failed` (`ERROR_LIST_FIELDS`, только коды, не больше 20).
- `icons.mjs`: `share`, `rotate`, `camera`, `flask`.

## M5.8 «Падел-корт» (№203–205)

- `resource.mjs` (`@billiardum/shared/resource`) — слово ресурса по семье вида (`family` из API, иначе `kind`/`type`; справочник — как `server/lib/resource-kinds.mjs` и `GET /api/resource-kinds`, тест сверяет): `familyOf`, `nounOf` (падежи, «за столом» / «на корте», `noun` сервера главнее), `resourceName` («Корт 2»), `countText` («3 корта»), `pluralForms`, `slotLabel` («1,5 ч», «2 ч»), `slotOptions` (1…4 слота), `slotMinutesOf`, `isSlot`, `familyText` (готовый текст про стол → про корт: «за этим столом» → «на этом корте», «со стола» → «с корта»; без ретроспективных проверок регулярных выражений — старые Safari).
- `booking.mjs`: `bookingPrice` с правилами слота (`per_slot_kopecks`, `slot_minutes`) считает точно в целых, как движок сервера: минута — цена слота / длина слота, общий знаменатель, одно округление до рублей, отрезки разбивки в сумме дают итог; почасовой расчёт не изменился. `slotDurations(day, resource, start)` — 1…N слотов до `max_minutes`, округлённого вниз до слота; `boardSlots(day, { minMinutes })` — короче слота нельзя.
- `hall.mjs`: `resourceArt` ('pyramid' | 'pool' | 'court'), `courtSvg` и `tableSvg('court')` — падел-корт 10 × 20 м (стекло, сетка, разметка, четыре прожектора; свет — тот же `--lit`), `courtLayout` — корты своим рядом; `typeLabel('padel_court')` — «Падел-корт, 10 × 20 м». `tableKind` и `planLayout` не менялись (на них опирается программа клуба). Стили — `.co-*` в `hall.css`.
- `errors.mjs`: `errorMessage(err, { family, playersLimit })` — у корта те же тексты со словом «корт»; `limit_exceeded` с `playersLimit` — «На корте уже 4 игрока».
