# Сценарии приёмки (`tests/e2e/`)

Владелец — tester. Проверяют, что поднятый стек делает то, что обещает `docs/ROADMAP.md`. Продуктовый код не меняют.

## M0 (`m0/`)

Нужен поднятый стек разработки: `npm run dev` (проект Compose `billiardum`). Тесты читают `.env` и `deploy/dev/devices.json`, секреты не печатают.

```sh
# всё, кроме CI (около 40 с)
node --test --test-concurrency=1 "tests/e2e/m0/*.test.mjs"

# вместе с lint, npm test и npm run test:db (несколько минут)
E2E_CI=1 node --test --test-concurrency=1 "tests/e2e/m0/*.test.mjs"

# один файл
node --test tests/e2e/m0/05-mqtt-acl.test.mjs
```

Файлы идут строго по одному (`--test-concurrency=1`): MQTT-проверки на время отключают столы.

| Файл | Критерий | Что проверяет |
|---|---|---|
| `01-health.test.mjs` | `/health` | `http://localhost:3000/health` и `https://localhost:8443/health` через Caddy (TLS проверяется корнем CA Caddy из контейнера) → `200 {"ok":true,"db":true,"mqtt":true}`; без CA — отказ TLS; неизвестный путь — `404 {"error":"not_found"}` |
| `02-devices-online.test.mjs` | 8 столов онлайн | `devices.json`: 8 устройств, разные ключи и пароли; лог сервера: `devices_online` 8/8 (последняя строка не старше 70 с, `total` = число устройств в базе), `cmd_ack` ok на `ping` от каждого из 8; лог симулятора: 8 подключений, `ping` исполнен |
| `03-audit-immutable.test.mjs` | журнал только дополняется | `UPDATE`, `DELETE`, `TRUNCATE` в `bl.audit_log` падают: у `supabase_admin` (и в режиме `session_replication_role = replica`), у `app_api` (вход по `DATABASE_URL`, с контекстом клуба и без), под `SET ROLE` в каждую роль из `pg_roles`; DDL суперпользователя над журналом запрещена; старые записи журнала после теста те же |
| `04-club-isolation.test.mjs` | изоляция клубов | временный клуб B внутри транзакции (ROLLBACK): с контекстом A `app_api` видит только A во всех таблицах, с контекстом B — только B, без контекста — ноль строк; вставка и перенос строки в чужой клуб, правка чужого клуба, `audit_verify` чужого клуба — отказ. То же на рабочих данных под настоящим входом `app_api` |
| `05-mqtt-acl.test.mjs` | ACL брокера | учётка стола 1 по MQTT 5 и 3.1.1: подписка только на свой `cmd`; подписки на чужой `cmd`, `bl/v1/#`, `#`, `$SYS/#`, `$CONTROL/…` и публикации в свой `cmd` (подписанный `ping`), чужие `cmd`/`state`/`status`/`ack`/`event`, свой топик под чужим `club_id`, `$CONTROL/dynamic-security` запрещены (SUBACK 0x87/0x80, PUBACK 0x87 в MQTT 5) и не доходят до свидетеля под учёткой администратора брокера (`bl/v1/#`); разрешённый свой `ack` доходит (контроль). Вход учёткой стола или сервера (`bl-server`) с чужим client id, с чужим паролем, анонимно — отказ. В конце сервер снова видит 8/8 |
| `06-protocol-journal.test.mjs` | протокол и журнал | своя канонизация и подпись проходят векторы `docs/protocol-vectors.json`; команда сервера на проводе подписана ключом из `devices.json`; каждая команда на проводе есть в журнале (`device.cmd`, тот же `cmd_id`, `seq`, `type`) и каждая новая запись ушла на провод; по каждому устройству `seq` в журнале без повторов, последний = `devices.last_seq` = `state.last_seq`; `audit_verify` по клубу — ok, цепочка пересчитана в Node по формуле `supabase/README.md` |
| `07-ci.test.mjs` | CI | `npm run lint`, `npm test`, `npm run test:db` (только с `E2E_CI=1`); полный `npm run ci` не запускается — он пересоздаёт контейнеры |

## Что тесты меняют

- База: попытки записи — только внутри транзакций, которые всегда откатываются (ROLLBACK). `npm run test:db` создаёт и удаляет свои временные базы `bl_test_*`.
- Брокер: `05` дважды и `06` один раз входят учёткой стола (1 и 8). Client id устройства обязателен, поэтому брокер на ~3 с отключает этот стол симулятора; симулятор переподключается сам, сервер шлёт ему `ping` — это обычная команда сервера с записью `device.cmd` в журнале. Тест ждёт, пока сервер снова напишет `devices_online` 8/8. В `cmd` тесты не публикуют ничего, что брокер принял бы.
- Свидетель MQTT подключается учёткой администратора брокера (`MQTT_ADMIN_USER`, роль Dynamic Security читает `#`) со своим client id (`bl-e2e-observer-…`). Учётка сервера закреплена за client id `bl-server`: под ней с этим id тесты не входят, чтобы не выбить живой сервер, — только с чужим id, чтобы проверить отказ.

## Переменные

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `E2E_CI` | — | `1` — запускать `07-ci` |
| `E2E_SERVER_CONTAINER` | `billiardum-server-1` | контейнер сервера (для `docker logs`) |
| `E2E_SIM_CONTAINER` | `billiardum-device-sim-1` | контейнер симулятора |
| `E2E_CADDY_CONTAINER` | `billiardum-caddy-1` | контейнер Caddy (корень его CA) |

Остальное — из `.env`: `DATABASE_ADMIN_URL`, `DATABASE_URL`, `MQTT_URL`, `MQTT_CA_FILE`, `MQTT_ADMIN_USER`, `MQTT_ADMIN_PASSWORD` (свидетель), `MQTT_SERVER_USER`, `MQTT_SERVER_PASSWORD` (только проверка отказа), `SIM_DEVICES_FILE`.
