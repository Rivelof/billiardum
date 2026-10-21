# Бильярдум

Платформа для бильярдных клубов России: программа клуба, контроллер света на каждом столе, приложение гостя (PWA и мини-приложения MAX и Telegram), публичный сайт-агрегатор с турнирами и рейтингом.

Что строим: [`docs/PRODUCT.md`](docs/PRODUCT.md). Протокол контроллера: [`docs/protocol.md`](docs/protocol.md). Этапы: [`docs/ROADMAP.md`](docs/ROADMAP.md). Решения: [`docs/decisions.md`](docs/decisions.md). Правила работы: [`CLAUDE.md`](CLAUDE.md).

## Требования

- **Docker** (Engine 25+, Compose v2.20+): Docker Desktop на macOS и Windows, Docker Engine с плагином Compose на Linux.
- **Node 22** или новее (вместе с npm).

Больше ничего не нужно: OpenSSL, Postgres и Mosquitto на машину не ставятся.

## Быстрый старт

```sh
npm run dev
```

Первый запуск:

1. проверяет Docker и Compose;
2. создаёт `.env` по образцу `.env.example` со случайными паролями и ключами (значения не выводятся);
3. ставит зависимости (`npm ci`), если их ещё нет;
4. создаёт dev-сертификаты брокера в `deploy/dev/certs/` (`scripts/dev-certs.mjs`);
5. поднимает базу и брокер и ждёт их готовности;
6. применяет миграции и сид, создаёт учётные записи брокера и ключи 8 тестовых устройств (`deploy/dev/devices.json`);
7. запускает сервер, симулятор контроллеров и Caddy и показывает логи сервера и симулятора.

Когда всё поднялось, в логе сервера появляется строка `{"msg":"devices_online","online":8,"total":8}`.

`Ctrl+C` закрывает логи, окружение продолжает работать. Повторный `npm run dev` перезапускает сервер и симулятор с текущим кодом; база и брокер не перезапускаются.

### Что поднимается

Проект Docker Compose `billiardum`, файл [`deploy/dev/compose.yml`](deploy/dev/compose.yml).

| Сервис | Образ | Адрес на хосте | Что это |
|---|---|---|---|
| `db` | `supabase/postgres:15.8.1.085` | `localhost:54322` (только с этой машины) | Postgres с RLS |
| `mosquitto` | `eclipse-mosquitto:2` | `mqtts://localhost:8883` | MQTT только по TLS, Dynamic Security, анонимный вход запрещён; 1883 закрыт |
| `server` | `node:22-alpine` | `http://localhost:3000` (только с этой машины) | `server/index.mjs`, проверка: `/health` |
| `device-sim` | `node:22-alpine` | — | симулятор 8 контроллеров |
| `caddy` | `caddy:2-alpine` | `https://localhost:8443` | TLS (внутренний CA Caddy) → `server:3000` |

Контейнеры с Node ничего не скачивают: репозиторий вместе с `node_modules` хоста монтируется в `/repo` только для чтения.

Пароли и адреса — в `.env` (описание переменных в [`.env.example`](.env.example)). CA брокера — `deploy/dev/certs/ca.crt`. Браузер предупредит о сертификате Caddy; его корень: `docker compose -p billiardum cp caddy:/data/caddy/pki/authorities/local/root.crt .`

### Остановить

```sh
npm run down                 # остановить, данные сохраняются
npm run down -- --volumes    # остановить и стереть данные: базу, брокер, devices.json
```

`.env` и сертификаты при этом остаются. Если удалить `.env`, старые данные не открыть: сначала `npm run down -- --volumes`.

## Тесты и проверки

```sh
npm test            # юнит-тесты всех пакетов, без базы и брокера
npm run lint        # ESLint по всему репозиторию
npm run test:db     # тесты базы на поднятом Postgres (после npm run dev)
npm run ci          # как в CI: lint, test, миграции и сид на чистом Postgres, test:db
npm run ci -- --db  # только этап базы из CI
```

`npm run ci` поднимает отдельный одноразовый Postgres на свободном порту и удаляет его в конце; окружение `npm run dev` не трогает. В GitHub то же делает [`.github/workflows/ci.yml`](.github/workflows/ci.yml). CI работает только с синтетическими данными сида.

## Другие команды

| Команда | Что делает |
|---|---|
| `npm run db:migrate` | применяет `supabase/migrations/*.sql` |
| `npm run db:seed` | применяет `supabase/seed.sql` (только разработка) |
| `npm run db:reset` | стирает схему, миграции и сид заново (только разработка) |
| `npm run provision:dev` | учётные записи брокера и ключи тестовых устройств |
| `npm run sim` | симулятор с хоста по `deploy/dev/devices.json` |
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
| `deploy/` | Docker Compose для разработки, конфиги Mosquitto и Caddy |
| `scripts/` | `dev*`, `ci*` — окружение и CI; `db-*`, `provision-*` — служебные скрипты сервера |
| `docs/` | продукт, протокол, дизайн, план, решения, контракты |
