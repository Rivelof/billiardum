# deploy/prod — прод «Бильярдума»

Конфиги и скрипты прода. Как ими пользоваться — [`docs/deploy/RUNBOOK.md`](../../docs/deploy/RUNBOOK.md). Чек-лист пилота — [`docs/deploy/PILOT-CHECKLIST.md`](../../docs/deploy/PILOT-CHECKLIST.md). Выпуск в прод — только после «да» Андрея.

| Файл | Что |
|---|---|
| `compose.yml` | db, mosquitto, server, site, caddy и разовые `migrate`, `web-publish`, `tools` (профиль `release`). Без эмуляторов и входа для разработки, `NODE_ENV=production`, наружу только 443 и 8883, образы по дайджесту |
| `Dockerfile`, `Dockerfile.dockerignore` | образ приложения `billiardum-app:<sha>`: фронтенд в боевом режиме, без сида, `tools/` и тестов |
| `.env.prod.example` | все переменные прода с комментариями, без значений секретов. На сервере — `/etc/billiardum/prod.env` |
| `caddy/Caddyfile` | свой домен, Let's Encrypt (TLS-ALPN-01), HSTS, вебхуки ЮKassa только с её адресов |
| `mosquitto/mosquitto.conf` | TLS 8883, без анонимов, Dynamic Security; перечитывается по SIGHUP |
| `postgres/pg_hba.conf.in` | вход по сети только из подсети `db`, репликация для бэкапа — только локально |
| `bin/` | `compose.sh` (с защитой окна обслуживания), `deploy.sh`, `rollback.sh`, `preflight.sh`, `gen-env.sh`, `infra-restart.sh`, `caddy-reload.sh`, `mqtt-reload.sh`, `mqtt-certs.sh`, `mqtt-server-client.mjs`, `publish-web.sh` |
| `backup/` | `pg-backup.sh` (ежедневно), `wal-push.sh` (каждые 5 мин), `restore-check.sh` (раз в месяц); всё шифруется age, хранилище S3 в РФ |
| `monitor/` | `monitor.sh` (раз в минуту), `checks.sql`, `notify.sh` (Telegram через прокси), `pilot-report.sh` и `pilot-metrics.sql` (по понедельникам) |
| `systemd/` | таймеры и службы для всего выше, `billiardum-alert@.service` при сбое |

Проверки в CI:

- `scripts/ci-prod-config.test.mjs` (в `npm test`):
  - нет эмуляторов и входа для разработки;
  - `NODE_ENV=production`;
  - доверенные прокси — ровно адреса Caddy и сайта `/32`;
  - наружу только 443 и 8883, Postgres и Supabase закрыты;
  - образы по дайджесту;
  - поведение `compose.sh`, `preflight.sh`, монитора и `publish-web.sh` на заглушках.
- `npm run ci -- --config`: `docker compose config` с `.env.prod.example`, `caddy validate`, `mosquitto --test-config`.
