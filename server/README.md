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

## Мост MQTT (`mqtt.mjs`, protocol v1 §2, §6)

- Подключение `bl-server` по TLS с CA из файла, `clean session`, подписка `bl/v1/+/+/{state,status,event,ack}` (QoS 1). Входящие сообщения больше 4096 байт отбрасываются с записью в лог (`message_too_large`).
- Клуб устройства — по `device_id` из базы (`bl.device_club`), а не из топика. Расхождение — лог `device_club_mismatch` (тревога) и запись `device.topic_mismatch` в журнал клуба; сообщения такого топика не обрабатываются.
- Онлайн: `status = online` и получен `state` (после `offline` нужен свежий `state`). Офлайн: `status = offline` или нет `state` больше 150 с.
- Одна неподтверждённая команда на устройство, остальные ждут в очереди. Команда: в одной транзакции под `app_api` с контекстом клуба — `SELECT … FOR UPDATE`, `seq`, расшифровка `device_key`, подпись, запись `device.cmd` (`data = {cmd_id, seq, type}`). Публикация после коммита. Без `ack` 3 с — повтор той же команды байт в байт, до 5 раз, затем `cmd_no_ack` (уровень `error`, тревога «контроллер не отвечает») и отказ от команды; следующая из очереди уходит. Повтор журнал не пишет. Устройство без ключа — `cmd_skipped`, ни `seq`, ни журнала.
- Пока устройство офлайн, повторов и `cmd_no_ack` нет: неподтверждённая команда бросается (`cmd_abandoned`), очередь чистится (`cmd_dropped`); досылается только `config.set` тем же `id` и `seq`. Команды офлайн-устройству не ставятся (`command()` → `offline`).
- После выхода онлайн и после события `boot` — актуальное состояние стола (`actualState`). В M0 это `ping`: сессий нет, симулятор M0 исполняет только `ping` и `identify`. В M1 сюда встаёт `session.resume`, `service.start`, `state.pending`/`state.reserved` или `state.free`. `boot` в течение 10 с после выхода онлайн — та же загрузка, второй раз состояние не шлётся.
- Сверка: `seq = greatest(devices.last_seq, state.last_seq) + 1`. Подъём по `state` — запись `device.seq_sync` (`{from, to}`) и лог `device_seq_sync`. Разрыв больше 1 000 000 — лог `device_seq_gap` (уровень `error`, тревога) без подъёма.
- `ack` сопоставляется по `cmd_id` и устройству. `ack` с `cmd_id: null` (команда не разобрана, `bad_format`) относится к неподтверждённой команде: её не повторяют.

Логи — строки JSON в stdout без персональных данных:

```
{"t":"…","level":"info","msg":"devices_online","online":8,"total":8}      при изменении и раз в 60 с
{"t":"…","level":"info","msg":"cmd_ack","device_id":"…","type":"ping","seq":1,"ok":true}
```

Также: `device_online`, `device_offline` (`reason`: `status` или `no_state`), `device_event` (только `type`, `boot`, `boot_id`, `n`), `device_unknown`, `cmd_no_ack`, `cmd_abandoned`, `cmd_skipped`, `device_seq_sync`, `device_seq_gap`, `message_too_large`, `mqtt_connected`, `mqtt_disconnected`, `db_error`. При `ok:false` строка `cmd_ack` идёт с уровнем `warn` и полем `error` (код из `ack`).

## Модули `lib/`

- `protocol.mjs` — строгий и канонический JSON, подпись HMAC-SHA256, проверка команды (`bad_format` → `bad_sig`), сборка команды, топики; проходит все 38 векторов. `bad_format`: команда длиннее 2048 байт, обратная косая черта где угодно, повторяющиеся ключи, числа не по исходному тексту (`context.source` в reviver `JSON.parse`: `1.0`, `9e5`, `-0`, ведущие нули, вне ±(2^53−1)), поля не по §3 (`id` — UUID в нижнем регистре, `seq` ≥ 1, `issued_at` — целое ≥ 0, `body` — объект). `bad_sig`: `sig` не ровно 44 символа канонического base64 или не совпадает.
- `secrets.mjs` — AES-256-GCM (decisions №23): `v1:` + base64(iv 12 ‖ tag 16 ‖ шифртекст), AAD `bl.secret/device_key/<device_id>` — ключ одного устройства, переложенный в строку другого, не расшифруется.
- `store.mjs` — транзакции с контекстом клуба (`withContext`), выделение `seq` и журнал.
- `dynsec.mjs` — команды Dynamic Security, роли устройства и сервера.

## `npm run provision:dev`

Только разработка (отказ при `NODE_ENV=production`). Через `MQTT_ADMIN_USER` в Dynamic Security: роль `bl-server` (`bl/v1/#`: подписка, приём, публикация) и клиент `MQTT_SERVER_USER` с паролем из `.env`. Для каждого устройства в базе: роль `bl-device-<device_id>` с точными топиками протокола §2 (подписка и приём только своего `cmd`; публикация своих `ack`, `state`, `event`, `status`), клиент с логином и обязательным client id = `device_id`, новый пароль MQTT и новый `device_key`. Ключ пишется в `bl.devices.device_key_enc` (через `DATABASE_ADMIN_URL`), всё вместе — в `deploy/dev/devices.json` (или `SIM_DEVICES_FILE`) с правами 0600; `mqtt_url` и `ca_file` в файле — значения `MQTT_URL` и `MQTT_CA_FILE`.

Повторный запуск выдаёт новые ключи и пароли и согласованно обновляет брокер, базу и файл. Порядок в `scripts/dev.mjs`: остановить `server` и `device-sim` → `db:migrate` → `db:seed` → `provision:dev` → поднять `server`, затем `device-sim` заново (`--force-recreate`). Запущенный при провижининге симулятор брокер отключает (новый пароль), а его старый ключ дал бы `bad_sig`.
