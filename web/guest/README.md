# @billiardum/web-guest — приложение гостя

PWA по адресу `/app/` (Vite + Preact, JS ESM, без UI-библиотек — decisions №51). Экраны M1 по `docs/contracts/m1.md` §10, дизайн — `docs/DESIGN.md` («Свет над столом»): сверху всегда тёмный зал со столом и лампой, ниже — выбор и действия под большой палец.

## Запуск

```sh
npm run dev:mock -w web/guest     # заглушка API, без сервера: http://127.0.0.1:5173/app/
npm run dev -w web/guest          # настоящий API: прокси /api → BL_API_URL (по умолчанию http://127.0.0.1:3000)
npm run build -w web/guest        # dist/ для Caddy (/app/* → web/guest/dist)
npm run size -w web/guest         # сборка + бюджет < 200 КБ JS gzip на первую загрузку, нет заглушки и внешних адресов
npm test -w web/guest             # node --test: логика таймера, слова, вход, адреса, маршруты, заглушка
```

Сейчас первая загрузка — около 29 КБ JS gzip.

## Экраны и маршруты

| Путь | Экран |
|---|---|
| `/app/` | текущие игры или «Отсканируйте QR-код на столе» |
| `/app/t/{code}` | «Стол»: номер, тип, статус словом, цена сейчас и дальше, 1/2/3 ч или «Без лимита»; шаги `?step=signin`, `consent`, `pay` на той же странице. Занятый стол — «Стол занят до 21:40» и «Я играю за этим столом» |
| `/app/wait/{payment_id}` | `return_url` ЮKassa: «Ждём подтверждения» → «Включаем свет…» до появления сессии → «Игра» |
| `/app/r/{request_id}` | «Оплачу на ресепшене»: что сказать администратору, срок заявки, отказ или сгорание |
| `/app/s/{id}` | «Игра»: таймер на полэкрана моноширинным, янтарный за 5 минут, красный в льготу (лампа приглушается), «Продлить», «Закончить игру» с «Оплаченное время не возвращается» (№45), кто за столом, напоминания Web Push; выбор после `interrupted` |
| `/app/s/{id}/receipt` | чек; на iPhone без «На экран Домой» — подсказка про напоминания (после первой игры) |
| `/app/privacy` | заглушка политики: «Текст готовит юрист» (пока нет `docs/legal/privacy.md`) |

Бар скрыт до M2.

## Как устроено

- `src/lib/` — логика без JSX (проверяется `node --test`): `game.js` (состояние таймера по `paid_until`, `grace_until`, поправка часов по `remaining_ms`), `words.js` (склонения через `plural`), `auth.js` (вход через бота, вход разработки, согласие), `api.js` (вызовы контракта поверх `@billiardum/shared/api`), `platform.js`, `urls.js`, `routes.js`.
- `src/screens/`, `src/components/` — экраны на Preact. Рисунок стола и статусы — `@billiardum/shared/hall`, тексты ошибок — `@billiardum/shared/errors`.
- Живые обновления — SSE `GET /api/stream?session=…` (событие `session`), при разрыве переподключение и перечитывание сессии, запасной опрос раз в 30 с.
- Вход: «Войти через MAX/Telegram» → `POST /api/auth/bot-link` → ссылка на бота → опрос `GET /api/auth/bot-link/{nonce}`. В PWA сессия — cookie `bl_session`; токен из ответа хранится в `sessionStorage` вкладки и уходит как `Bearer` (мини-приложения). Мини-приложение Telegram: `init_data` из `#tgWebAppData` адреса, без внешнего скрипта (CSP). В разработке — вход по телефону (`POST /api/auth/dev`), в сборке без `VITE_DEV_LOGIN=1` формы нет.
- Оплата: ключ `Idempotency-Key` живёт до ответа (повтор после обрыва не создаёт второй платёж); переход только на https-адрес `confirmation.url`.
- PWA: `public/manifest.webmanifest`, значки (SVG и PNG, без эмодзи), `src/sw.js` → `dist/sw.js` (плагин `scripts/sw-plugin.mjs` подставляет список файлов оболочки). Кэшируется только статика, `/api/`, `/t/`, `/pay/` — никогда. Push: тело `{title, body, url, tag}` без персональных данных (№53).
- CSP `default-src 'self'`: без встроенных скриптов и атрибутов `style` в HTML; тема до первой отрисовки — `public/theme-init.js`.

## Заглушка API (`VITE_MOCK=1` или `--mode mock`)

`src/mock/` — поддельный сервер по контракту (состояние в `sessionStorage`, страница «ЮKassa» `/app/mock-pay/{id}`). В обычную сборку не попадает: условие `__BL_MOCK__` сворачивается при сборке, `npm run size` ищет метку `BL_MOCK_MARKER`.

Сценарии — параметр `?mock=` при открытии любой страницы: `anon`, `fresh` (вход без согласия), `user`, `game`, `warn`, `grace`, `unlimited`, `interrupted`, `closed`, `notpayer`, `decline` (ресепшн отклонит заявку), `limit`.
Коды столов: `4K7P9QW2XM` (стол 4, свободен), `6C2J7MD5KT` (6, свободен), `7H3D2RT9QF` (7, занят), `2M8X4KZ6CB` (оплачивают), `5S9N3VJ7AE` (сервис), `8F6T1YH4RD` (нет связи), `3B5R8WA2NP` (бронь). Сессия сценариев — `/app/s/6f1c2a9e-0d4b-4c7e-9a51-3b2f8e7d4c10`.
