# Бильярдум

Платформа для бильярдных клубов России: программа клуба, контроллер света на каждом столе, приложение гостя (PWA и мини-приложения MAX и Telegram), публичный сайт-агрегатор с турнирами и рейтингом.

Что строим: [`docs/PRODUCT.md`](docs/PRODUCT.md). Протокол контроллера: [`docs/protocol.md`](docs/protocol.md). Этапы: [`docs/ROADMAP.md`](docs/ROADMAP.md). Решения: [`docs/decisions.md`](docs/decisions.md). Правила работы: [`CLAUDE.md`](CLAUDE.md).

## Требования

- **Docker** (Engine 25+, Compose v2.20+): Docker Desktop на macOS и Windows, Docker Engine с плагином Compose на Linux.
- **Node 22** или новее (вместе с npm).

Больше ничего не нужно: OpenSSL, Postgres и Mosquitto на машину не ставятся. Фронтенд собирается на хосте тем же Node.

## Быстрый старт

```sh
npm run dev
```

Первый запуск:

1. проверяет Docker и Compose;
2. создаёт `.env` по образцу `.env.example` со случайными паролями и ключами, в том числе парой ключей VAPID для Web Push (значения не выводятся). В уже существующий `.env` дописывает только недостающие переменные;
3. ставит зависимости (`npm ci`), если их ещё нет;
4. создаёт dev-сертификаты брокера в `deploy/dev/certs/` (`scripts/dev-certs.mjs`);
5. поднимает базу и брокер и ждёт их готовности;
6. применяет миграции и сид, создаёт учётные записи брокера и ключи 8 тестовых устройств (`deploy/dev/devices.json`);
7. собирает приложение гостя и программу клуба на хосте (`npm run build -w web/guest`, `-w web/admin`);
8. запускает сервер, симулятор контроллеров, эмулятор ЮKassa и Caddy и показывает логи.

Когда всё поднялось, в логе сервера появляется строка `{"msg":"devices_online","online":8,"total":8}`.

`Ctrl+C` закрывает логи, окружение продолжает работать. Повторный `npm run dev` пересобирает фронтенд и перезапускает сервер, симулятор и эмулятор с текущим кодом; база и брокер не перезапускаются.

Фронтенд собирается на хосте, а не в контейнере: у Vite нативный `esbuild` под платформу хоста, и в Linux-контейнере на macOS и Windows он не запустится. Caddy раздаёт готовые `web/guest/dist` и `web/admin/dist`. Если сборка упала, окружение всё равно поднимается, а `npm run dev` пишет об этом в сводке.

Пересборка на лету, пока правите интерфейс:

```sh
npm run dev -- --watch-web
```

Рядом с логами сервера запускается `vite build --watch` обоих приложений (или скрипт `build:watch` пакета, если он есть). После сохранения файла обновите страницу. `Ctrl+C` останавливает и пересборку.

### Адреса

| Адрес | Что там |
|---|---|
| `https://localhost:8443/app/` | приложение гостя (PWA); стол по QR — `/app/t/{код}` |
| `https://localhost:8443/club/` | программа клуба: ресепшн, владелец, управляющий |
| `https://localhost:8443/pay/{id}` | страница подтверждения оплаты эмулятора ЮKassa (кнопки «Оплатить» и «Отказ») |
| `https://localhost:8443/api/` | API сервера; `/api/stream` — поток событий (SSE) |
| `https://localhost:8443/t/{код}` | короткая ссылка с QR-наклейки, сервер перенаправляет на `/app/t/{код}` |
| `https://localhost:8443/` | перенаправляет на `/app/` |
| `http://localhost:3000/health` | сервер напрямую, без Caddy |
| `http://127.0.0.1:18080` | управление симулятором контроллеров |

Caddy ставит заголовки безопасности: CSP без внешних источников (скрипты, стили, шрифты, картинки и запросы — только со своего хоста), `X-Content-Type-Options`, `Referrer-Policy: same-origin`, `Permissions-Policy`. HSTS — только не для `localhost` и `127.0.0.1`. Приложение гостя разрешено показывать во фрейме только веб-версиям Telegram и MAX (мини-приложения), программу клуба — никому. `index.html` и `sw.js` браузер перепроверяет при каждом открытии, ассеты с хешем в имени кэшируются на год. Подробности — в [`deploy/dev/Caddyfile`](deploy/dev/Caddyfile).

### Столы и вход для разработки

В сиде клуб в Екатеринбурге и 8 столов с кодами `TEST000001` … `TEST000008` (стол N — `TEST00000N`). Стол открывается так же, как по QR-наклейке: `https://localhost:8443/t/TEST000004` → `/app/t/TEST000004`. Наклейки с QR — в программе клуба (владелец) или `GET /api/clubs/{club}/qr-stickers.pdf`.

С `ALLOW_DEV_LOGIN=1` (по умолчанию в `.env` разработки) работает вход по телефону без бота: в приложении гостя и в программе клуба — кнопка входа по телефону (`npm run dev` собирает их с `VITE_DEV_LOGIN=1`), в API — `POST /api/auth/dev` с `{"phone":"…"}`, ответ `{token, user}`. Токен передаётся в `Authorization: Bearer …` или ставится cookie. При `NODE_ENV=production` маршрута нет вовсе.

| Телефон | Кто |
|---|---|
| `+70000000001` | владелец тестового клуба |
| `+70000000003` | управляющий |
| `+70000000004` | ресепшн |
| любой другой, например `+79990000001` | новый гость (согласие на обработку данных — при первой оплате) |

```sh
curl -sk https://localhost:8443/api/auth/dev -H 'Content-Type: application/json' -d '{"phone":"+79990000001"}'
```

Вход через MAX и Telegram требует токенов ботов (`MAX_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`) и публичного адреса; без них каналы выключены, а уведомления пишутся в базу со статусом `skipped`.

### Ускоренное время

С `DEV_ALLOW_ANY_MINUTES=1` (по умолчанию в разработке) котировка (`POST /api/quotes`) принимает любое число минут от 1, а не только варианты тарифа. Так сценарии конца игры проходят за минуты, а не часы. Пороги не ускоряются: контроллер предупреждает за 5 и за 1 минуту (`warn_ms` 300 000 и 60 000), уведомления гостю идут по расписанию планировщика, как в бою. Игра на 3 минуты проверяет конец игры и льготу, на 12 — все сигналы. В production флаг не действует.

### Оплата на эмуляторе ЮKassa

Сеть разработки закрыта от `api.yookassa.ru`, поэтому сервер ходит в эмулятор `tools/yookassa-emu/` (`YOOKASSA_API_URL=http://yookassa-emu:8090/v3`). Эмулятор доступен только внутри Docker Compose; браузер открывает его страницу оплаты через Caddy: `https://localhost:8443/pay/{id}`. Кнопка «Оплатить» отправляет вебхук на `http://server:3000/api/webhooks/yookassa/{club_id}`. Магазин эмулятора (`YOOKASSA_EMU_SHOP_ID`, `YOOKASSA_EMU_SECRET`) создаётся в `.env`, `npm run provision:dev` записывает его в настройки тестового клуба. Сервис в профиле Compose `yookassa-emu`: `npm run dev` включает его, когда есть `tools/yookassa-emu/index.mjs`, иначе `/pay/` отвечает 502.

Подтвердить оплату:
- в браузере — кнопка «Оплатить» на `https://localhost:8443/pay/{id}`, куда приложение переводит после «Оплатить»;
- без браузера (тесты) — управлением эмулятора `/__emu/…`. Оно наружу не опубликовано, только изнутри контейнера; `{id}` — платёж ЮKassa из `confirmation.url` (`…/pay/{id}`) ответа `POST /api/quotes/{id}/pay` или из списка `GET /__emu/payments`:

```sh
docker compose -p billiardum exec yookassa-emu wget -qO- --post-data='' http://127.0.0.1:8090/__emu/payments/{id}/succeed
docker compose -p billiardum exec yookassa-emu wget -qO- http://127.0.0.1:8090/__emu/payments     # все платежи
```

Отказ — `…/cancel`, повтор вебхука — `…/webhook?repeat=N`. Остальные команды — в README эмулятора (`tools/yookassa-emu/`).

### Симулятор контроллеров

Сервис `device-sim` поднимает 8 виртуальных контроллеров по `deploy/dev/devices.json`. Управление — по HTTP с этой машины: `http://127.0.0.1:18080` (обрыв связи, перезагрузка, обход реле, неисправная лампа, медленный `ack`, метрики). Список команд — в [`tools/device-sim/README.md`](tools/device-sim/README.md). NVS контроллеров хранится в томе `device-sim-nvs` и переживает перезапуск контейнера.

```sh
docker compose -p billiardum logs -f device-sim     # лог симулятора
docker compose -p billiardum restart device-sim     # все контроллеры перезагрузились
```

### С телефона в локальной сети

Телефон и компьютер — в одной сети Wi-Fi.

1. Узнайте IP компьютера в локальной сети (macOS: `ipconfig getifaddr en0`; Windows: `ipconfig`; Linux: `hostname -I`), например `192.168.1.10`.
2. В `.env` поставьте `DEV_LAN_HOST=192.168.1.10` и `PUBLIC_HOST=192.168.1.10:8443`. Второе нужно, чтобы ссылки QR-наклеек и возврат после оплаты вели на компьютер, а не на `localhost` телефона.
3. Перезапустите: `npm run dev`. Caddy выпустит сертификат и на этот адрес.
4. Установите на телефон корень CA Caddy: скачайте его `docker compose -p billiardum cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt` и передайте на телефон. iOS: открыть файл → «Настройки» → «Профиль загружен» → установить, затем «Основные» → «Об этом устройстве» → «Доверие сертификатам» → включить. Android: «Настройки» → «Безопасность» → «Шифрование и учётные данные» → «Установить сертификат» → «Сертификат CA». Без этого браузер предупредит о сертификате, а Service Worker и установка PWA не заработают.
5. Откройте `https://192.168.1.10:8443/app/`. Если не открывается — разрешите входящие на порт 8443 в брандмауэре компьютера. На компьютере тоже открывайте этот адрес: ссылки, возврат после оплаты и cookie входа привязаны к `PUBLIC_HOST`.

Мини-приложения Telegram и MAX так не открыть: мессенджерам нужен публичный адрес с настоящим сертификатом.

### Что поднимается

Проект Docker Compose `billiardum`, файл [`deploy/dev/compose.yml`](deploy/dev/compose.yml).

| Сервис | Образ | Адрес на хосте | Что это |
|---|---|---|---|
| `db` | `supabase/postgres:15.8.1.085` | `localhost:54322` (только с этой машины) | Postgres с RLS |
| `mosquitto` | `eclipse-mosquitto:2.1.2-alpine` | `mqtts://localhost:8883` | MQTT только по TLS, Dynamic Security, анонимный вход запрещён; 1883 закрыт |
| `server` | `node:22.23.4-alpine` | `http://localhost:3000` (только с этой машины) | `server/index.mjs`, проверка: `/health` |
| `device-sim` | `node:22.23.4-alpine` | `http://127.0.0.1:18080` (управление, только с этой машины) | симулятор 8 контроллеров, NVS в томе `device-sim-nvs` |
| `yookassa-emu` | `node:22.23.4-alpine` | — (только через Caddy: `/pay/`) | эмулятор ЮKassa, порт 8090 внутри сети Compose |
| `caddy` | `caddy:2.11.7-alpine` | `https://localhost:8443` | TLS (внутренний CA Caddy): `/api/`, `/t/` → сервер, `/app/` и `/club/` → сборки фронтенда, `/pay/` → эмулятор |

Контейнеры с Node ничего не скачивают: репозиторий вместе с `node_modules` хоста монтируется в `/repo` только для чтения. Caddy читает `web/` только для чтения.

Пароли и адреса — в `.env` (описание переменных в [`.env.example`](.env.example)). CA брокера — `deploy/dev/certs/ca.crt`. Браузер предупредит о сертификате Caddy; его корень: `docker compose -p billiardum cp caddy:/data/caddy/pki/authorities/local/root.crt .`

### Остановить

```sh
npm run down                 # остановить, данные сохраняются
npm run down -- --volumes    # остановить и стереть данные: базу, брокер, NVS симулятора, devices.json
```

`.env` и сертификаты при этом остаются. Если удалить `.env`, старые данные не открыть: сначала `npm run down -- --volumes`.

## Тесты и проверки

```sh
npm test            # юнит-тесты всех пакетов, без базы и брокера
npm run lint        # ESLint по всему репозиторию
npm run test:db     # тесты на Postgres окружения npm run dev (базы временные, рабочую не трогают)
npm run ci          # как в CI: всё ниже, кроме --pio
npm run ci -- --db  # только этап базы из CI: свой Postgres
```

`npm run test:db` (`scripts/ci-test-db.mjs`) гоняет `test:db` пакетов `@billiardum/db` и `@billiardum/server` и тесты light: `LIGHT_IT=1 node --test --test-concurrency=1 "server/test/light/*.test.mjs"`. База — `DATABASE_ADMIN_URL` из окружения или `.env`. Интеграция light + брокер + симулятор (`it-sim`, p95 до `ack`) сама поднимает и удаляет свой брокер `bl-light-it-*` (нужны Docker и `openssl`); брокер `npm run dev` она не трогает. Без неё — `LIGHT_IT=0 npm run test:db`.

| Этап `npm run ci -- …` | Что проверяет |
|---|---|
| `--base` | lint, юнит-тесты, интеграционный тест симулятора (свой брокер в Docker) |
| `--config` | `docker compose config`, `caddy validate`, `mosquitto --test-config` — образами из `compose.yml` |
| `--web` | сборка `web/guest` и `web/admin`, бюджет JS гостя: `npm run size -w web/guest` (≤ 200 КБ gzip) |
| `--fw` | нативные тесты логики прошивки: CMake + g++ по `firmware/test/native`, `ctest` |
| `--db` | одноразовый Postgres: миграции, сид, `npm run test:db` целиком, включая интеграцию light со своим брокером (нужен `openssl`) |
| `--pio` | `pio run -e esp32dev` и `pio test -e native`; нужен PlatformIO 6.1.19 и доступ к реестру PlatformIO, по умолчанию не входит |

Пакеты, которых ещё нет, пропускаются с сообщением. Для `--fw` нужны CMake 3.20+ и компилятор C++.

`npm run ci` поднимает одноразовые Postgres и брокеры на свободных портах и удаляет их в конце; окружение `npm run dev` не трогает. В GitHub то же делает [`.github/workflows/ci.yml`](.github/workflows/ci.yml) теми же `node scripts/ci.mjs --…`: задачи `ci` (`--base`, `--config`, `--db`), `web` (`--web`), `firmware-native` (`--fw`) и `firmware-pio` (`--pio`, PlatformIO ставится на раннере, версия закреплена). Локально `npm run ci` покрывает всё, кроме `--pio`: реестр PlatformIO в среде разработки закрыт, `--pio` запускается отдельно там, где он доступен. CI работает только с синтетическими данными сида.

## Другие команды

| Команда | Что делает |
|---|---|
| `npm run db:migrate` | применяет `supabase/migrations/*.sql` |
| `npm run db:seed` | применяет `supabase/seed.sql` (только разработка) |
| `npm run db:reset` | стирает схему, миграции и сид заново (только разработка) |
| `npm run provision:dev` | учётные записи брокера и ключи тестовых устройств |
| `npm run sim` | симулятор с хоста по `deploy/dev/devices.json` |
| `npm run dev -- --watch-web` | окружение и пересборка фронтенда на лету |
| `npm run build -w web/guest` | собрать приложение гостя (Caddy подхватит без перезапуска) |
| `node scripts/dev-certs.mjs` | создать недостающие dev-сертификаты |

## Устройство репозитория

| Папка | Что внутри |
|---|---|
| `server/`, `api/` | сервер Node 22: HTTP API, мост MQTT, планировщик |
| `supabase/` | миграции, политики RLS, сид, тесты базы |
| `firmware/` | прошивка контроллера (ESP32, PlatformIO) |
| `tools/device-sim/` | симулятор контроллера |
| `web/` | приложение гостя, программа клуба, сайт |
| `shared/` | токены дизайна, шрифты, форматы ru-RU |
| `tools/yookassa-emu/` | эмулятор ЮKassa для разработки и тестов |
| `deploy/` | Docker Compose для разработки, конфиги Mosquitto и Caddy |
| `scripts/` | `dev*`, `ci*` — окружение и CI; `db-*`, `provision-*` — служебные скрипты сервера |
| `docs/` | продукт, протокол, дизайн, план, решения, контракты |
