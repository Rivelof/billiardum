# Сервер «Бильярдума» (`@billiardum/server`)

Вход `index.mjs`: HTTP на `PORT` и мост MQTT. Контракт — `docs/contracts/m0.md` §6, протокол — `docs/protocol.md`.

## Команды

| Команда | Что делает |
|---|---|
| `node server/index.mjs` | сервер; завершается по `SIGTERM`/`SIGINT` (HTTP, мост, брокер, пул базы) |
| `npm test -w @billiardum/server` | юнит-тесты без базы и брокера: все векторы `docs/protocol-vectors.json`, шифрование, `/health`, мост (подделки клиента, базы и таймеров), Dynamic Security |
| `npm run provision:dev` | только разработка, ниже |

Переменные (контракт §3): `DATABASE_URL` (роль `app_api`), `MQTT_URL`, `MQTT_CA_FILE` (относительный путь — от корня репозитория), `MQTT_SERVER_USER`, `MQTT_SERVER_PASSWORD`, `SECRETS_ENC_KEY`, `PORT` (3000), `LOG_LEVEL` (`info`); необязательная `MQTT_CLIENT_ID` (`bl-server`). Сервер `.env` не читает: окружение даёт Compose или systemd.

## HTTP

`GET /health` → `200 {"ok":true,"db":true,"mqtt":true}`; если база не ответила за 2 с или нет связи с брокером — `503` того же вида. Прочие пути — `404 {"error":"not_found"}`.

## Мост MQTT (`mqtt.mjs`)

- Подключение `bl-server` по TLS с CA из файла, подписка `bl/v1/+/+/{state,status,event,ack}` (QoS 1).
- Клуб устройства — по `device_id` из базы (`bl.device_club`), а не из топика. Расхождение — лог `device_club_mismatch` (тревога) и запись `device.topic_mismatch` в журнал клуба; сообщения такого топика не обрабатываются.
- Онлайн: `status = online` и получен `state` (после `offline` нужен свежий `state`). Офлайн: `status = offline` или нет `state` больше 150 с.
- Устройству, ставшему онлайн, — `ping`. В одной транзакции под `app_api` с контекстом клуба: `UPDATE devices SET last_seq = greatest(last_seq, <last_seq из state>) + 1 … RETURNING`, расшифровка `device_key`, подпись, `INSERT` в журнал (`device.cmd`, `data = {cmd_id, seq, type}`). Публикация после коммита. Без `ack` 3 с — повтор той же команды байт в байт, до 5 раз, затем `cmd_no_ack` (уровень `error`, тревога «контроллер не отвечает»). Повтор журнал не пишет. Устройство без ключа — `cmd_skipped`, ни `seq`, ни журнала.
- `ack` сопоставляется по `cmd_id` и устройству.

Логи — строки JSON в stdout без персональных данных:

```
{"t":"…","level":"info","msg":"devices_online","online":8,"total":8}      при изменении и раз в 60 с
{"t":"…","level":"info","msg":"cmd_ack","device_id":"…","type":"ping","seq":1,"ok":true}
```

Также: `device_online`, `device_offline` (`reason`: `status` или `no_state`), `device_event` (только `type`, `boot`, `n`), `device_unknown`, `cmd_no_ack`, `cmd_skipped`, `mqtt_connected`, `mqtt_disconnected`, `db_error`. При `ok:false` строка `cmd_ack` идёт с уровнем `warn` и полем `error` (код из `ack`).

## Модули `lib/`

- `protocol.mjs` — канонический JSON, подпись HMAC-SHA256, проверка команды (`bad_format` → `bad_sig`), сборка команды, топики. Числа проверяются по исходному тексту (`context.source` в reviver `JSON.parse`): `1.0`, `9e5`, `-0`, ведущие нули и числа вне ±(2^53−1) — `bad_format`.
- `secrets.mjs` — AES-256-GCM (decisions №23): `v1:` + base64(iv 12 ‖ tag 16 ‖ шифртекст), AAD `bl.secret/device_key/<device_id>` — ключ одного устройства, переложенный в строку другого, не расшифруется.
- `store.mjs` — транзакции с контекстом клуба (`withContext`), выделение `seq` и журнал.
- `dynsec.mjs` — команды Dynamic Security, роли устройства и сервера.

## `npm run provision:dev`

Только разработка (отказ при `NODE_ENV=production`). Через `MQTT_ADMIN_USER` в Dynamic Security: роль `bl-server` (`bl/v1/#`: подписка, приём, публикация) и клиент `MQTT_SERVER_USER` с паролем из `.env`. Для каждого устройства в базе: роль `bl-device-<device_id>` с точными топиками протокола §2 (подписка и приём только своего `cmd`; публикация своих `ack`, `state`, `event`, `status`), клиент с логином и обязательным client id = `device_id`, новый пароль MQTT и новый `device_key`. Ключ пишется в `bl.devices.device_key_enc` (через `DATABASE_ADMIN_URL`), всё вместе — в `deploy/dev/devices.json` (или `SIM_DEVICES_FILE`) с правами 0600; `mqtt_url` и `ca_file` в файле — значения `MQTT_URL` и `MQTT_CA_FILE`.

Повторный запуск выдаёт новые ключи и пароли и согласованно обновляет брокер, базу и файл; запущенный симулятор после этого нужно перезапустить.
