# Симулятор контроллера стола (`@billiardum/device-sim`)

Поднимает по виртуальному контроллеру на каждое устройство из файла устройств и говорит с брокером по протоколу `docs/protocol.md` v1, как прошивка ESP32. На нём работают backend, tester и pentester, пока нет железа (decisions №7).

Свою реализацию протокола держит в `lib/` и ничего не импортирует из `server/`. Так общие векторы `docs/protocol-vectors.json` ловят расхождения между сервером и контроллером.

Автомат (`lib/machine.mjs`) повторяет прошивку `firmware/lib/logic/src/bl_machine.cpp` построчно. Общие сценарии `scenarios/*.json` прогоняют обе реализации. Расхождение — дефект.

## Что умеет (M1)

- Все команды §3.3 и автомат §5:
  - сессии; `ending` и `grace` по `warn_ms` и `grace_ms`;
  - сигналы по пересечению порога: `yellow_blink` и 2 сигнала пищалки на T−5, двойное мигание лампой на T−1, мигание раз в `grace_blink_s` или приглушение до `grace_dim` при `dimmer`;
  - `session.extend`, в том числе из `grace`; `session.stop`;
  - `service.*`;
  - `state.pending` и `state.reserved` с истечением `until_ms`;
  - `identify`; `config.set` в NVS; `ota.start` — только проверка полей и `busy_ota`, загрузки нет;
  - `ping`.
- Правило 4: после перезагрузки свет выключен, 30 с ожидания ответа сервера. Без ответа — остаток «сохранённый − 60 с», один раз за сессию.
- `offline_session_finished`, если сессия доиграна без связи.
- Датчик тока: `bypass_detected` и `lamp_fault` после `current_confirm_ms`; состояние `fault`.
- `reason_code` — 1…32 символа `[a-z0-9_]`.
- Проверка команд, повторы §3.2, события с `boot_id` и `n`, буфер на 64, ограничение частоты `bad_sig` и `replayed_seq`.
- NVS в памяти (по умолчанию) или в файлах (`SIM_NVS_DIR`): перезапуск процесса — как перезагрузка контроллера. Новый `device_key` в файле устройств — перепривязка (§7): `seq`, `id`, `ack` и сессия обнуляются, `boot` остаётся.
- Режимы сбоя флагами CLI и на ходу по HTTP.
- Метрика `sim_relay`: от получения команды до включения реле.
- M5.1: режим «новый контроллер» (`--claim`): заводские `device_id` и `claim_code`, привязка по §7 с повтором `POST /api/devices/claim`, затем обычный стол. Подробнее — раздел «Новый контроллер».

## Запуск

```sh
npm run sim                                  # из корня, по deploy/dev/devices.json
npm start -w tools/device-sim -- --tables 1,4 --fault bypass@4 --fault slow-ack@1:4000
node tools/device-sim/index.mjs --help
```

Файл устройств создаёт backend: `npm run provision:dev`. В Docker Compose симулятор запускает `npm run dev` (сервис `device-sim`, управление на `127.0.0.1:18080`).

| Переменная | Что задаёт |
|---|---|
| `SIM_DEVICES_FILE` | файл устройств; по умолчанию `deploy/dev/devices.json` |
| `MQTT_URL` | адрес брокера вместо `mqtt_url` из файла; `mqtts://…`, `mqtt://` только для тестов |
| `MQTT_CA_FILE` | CA брокера вместо `ca_file` из файла |
| `LOG_LEVEL` | `debug`, `info` (по умолчанию), `warn`, `error` |
| `SIM_TABLES`, `SIM_FAULTS`, `SIM_CAPS` | то же, что `--tables`, `--fault` (через запятую), `--caps` |
| `SIM_NVS_DIR` | папка NVS: файл `<device_id>.json` на контроллер, права 0600, секретов нет |
| `SIM_CONTROL_PORT` | включает HTTP-управление на этом порту; без переменной управления нет; при `NODE_ENV=production` — ошибка запуска |
| `SIM_CONTROL_HOST` | адрес HTTP-управления; по умолчанию `127.0.0.1`, в контейнере `0.0.0.0` (наружу devops публикует только на `127.0.0.1:18080`) |
| `SIM_CLAIM` | то же, что `--claim`, через запятую |
| `SIM_API_URL` | режим `--claim`: адрес API, например `https://localhost:8443`; обязателен. `http://` — только для тестов |
| `SIM_API_CA_FILE` | режим `--claim`: CA сервера API (на стенде — корень CA Caddy) |
| `SIM_CLAIM_DIR` | режим `--claim`: папка ключей привязки `<device_id>.keys.json` (0600, в нём секреты); по умолчанию `SIM_NVS_DIR`, иначе `$TMPDIR/billiardum-device-sim-claim`. Не кладите её в репозиторий |

Относительный путь ищется так: сначала от каталога, где вызвали `npm` (`INIT_CWD`), или от текущего каталога, затем от корня репозитория. Для `ca_file` между этими вариантами проверяется ещё папка файла устройств.

| Флаг | Что делает |
|---|---|
| `--tables 1,4` | поднять только эти столы (`table_number`) |
| `--caps relay,led,buzzer,current,dimmer` | что «есть на плате»; по умолчанию `relay,led,buzzer,current` |
| `--fault <режим>[@<стол>][:<мс>]` | режим сбоя с начала работы; можно повторять; без `@стол` — для всех столов |
| `--claim BLD1:<device_id>:<claim_code>[@<номер>]` | новый контроллер по строке QR с наклейки; можно повторять. Файл устройств не читается |

## Режимы сбоя

| Режим | Что делает | `ms` (флаг `:мс` или поле в HTTP) |
|---|---|---|
| `net-drop` | обрыв связи без DISCONNECT, брокер публикует Last Will `offline`; игра идёт по локальному таймеру | сколько длится; флаг — по умолчанию 60000; HTTP без `ms` — до `on: false` |
| `reboot` | перезагрузка: свет гаснет, связь рвётся, `boot` + 1, новый `boot_id`, событие `boot`, правило 4 | флаг — через сколько после старта (60000); HTTP — сколько нет питания (0) |
| `bypass` | ток 380 мА при выключенном реле: после `current_confirm_ms` — `bypass_detected` и `fault` | сколько длится; без `ms` — постоянно |
| `lamp-fault` | реле включено, тока нет: после `current_confirm_ms` — `lamp_fault` | сколько длится; без `ms` — постоянно |
| `slow-ack` | `ack` уходит с задержкой; `state` — сразу | задержка, по умолчанию 5000 (сервер повторяет через 3 с) |
| `replay-old` | повтор старой команды самому себе (T8): сразу и после каждой новой команды подаётся ранее принятая команда с меньшим `seq`, лучше `session.extend`; ответ — `replayed_seq` в `ack` и событие | задержка повтора после новой команды, по умолчанию 1000 |

## HTTP-управление (tester, pentester)

Только для разработки. Порт — `SIM_CONTROL_PORT`. POST принимает только `Content-Type: application/json`: страница из браузера не отправит такой запрос без CORS-preflight, а CORS не разрешён. Ошибки — кодом: `{"error":"unknown_fault"}`.

| Запрос | Тело | Ответ |
|---|---|---|
| `GET /sim/tables` | — | `[стол]` |
| `GET /sim/tables/{number}` | — | `стол` или `404 table_not_found` |
| `POST /sim/tables/{number}/fault` | `{"name": "bypass", "on": true, "ms"?: 30000}` | `{"ok": true, "fault", "on", "replayed"?, "table": стол}` |
| `POST /sim/tables/{number}/reboot` | `{"down_ms"?: 0, "reset_reason"?: "poweron"}` | `{"ok": true, "table": стол}` |
| `POST /sim/tables/{number}/net` | `{"up": false}` | `{"ok": true, "table": стол}` |
| `POST /sim/tables/{number}/inject` | `{"raw": "строка команды"}` | `{"ok": true, "result", "reason"?, "ack", "table": стол}`; больше 2048 байт — `413 too_large`, контроллер выключен — `409 powered_off` |
| `POST /sim/tables/{number}/unclaim` | `{}` | только `--claim`: ключи стёрты, контроллер снова ждёт привязки (консоль прошивки `unclaim`); `{"ok": true, "table": стол}`, без `--claim` — `409 not_claim_mode` |

`стол`:

```json
{
  "table": 4, "device_id": "…", "club_id": "…", "powered": true, "online": true, "net_up": true,
  "faults": { "bypass": false, "lamp-fault": false, "slow-ack": 0, "replay-old": false },
  "state": { "v": 1, "state_seq": 12, "mode": "ending", "remaining_ms": 240000, "relay": true, "…": "как state §4" },
  "lamp": true,
  "signals": { "warn": 1, "beep": 2, "blink2": 0, "grace": 0, "grace_blink": 0 },
  "boot_waiting": false,
  "nvs_session": { "session_id": "…", "remaining_ms": 300000, "warn_ms": [300000, 60000], "grace_ms": 120000, "buzzer": true, "offline_resumes": 0 },
  "config": { "led_brightness": 128, "current_on_ma": 50, "current_confirm_ms": 10000, "grace_dim": 30, "grace_blink_s": 15 },
  "outbox": [{ "type": "offline_session_finished", "boot_id": "…", "n": 3 }]
}
```

`inject` подаёт строку так, будто она пришла в `cmd` по MQTT: проверка §3.1–§3.3, `ack` в топик `ack`, события, метрика. Так проверяется T9 (команда с неверной подписью) без доступа к брокеру. Сама строка в лог не пишется (в ней подпись), в логе — `sim_inject` с размером и итогом.

`lamp` — лампа горит физически: при двойном мигании `state.relay` остаётся `true`, а `lamp` на 300 мс становится `false`. `signals` — счётчики с последней загрузки. `outbox` — недоставленные события.

```sh
curl -s 127.0.0.1:18080/sim/tables/4
curl -s -X POST -H 'content-type: application/json' -d '{"name":"bypass","on":true}' 127.0.0.1:18080/sim/tables/4/fault
curl -s -X POST -H 'content-type: application/json' -d '{"up":false}' 127.0.0.1:18080/sim/tables/4/net
```

## Лог

Строки JSON в stdout: `{"t":"…","level":"…","msg":"…", …}`. Пароль MQTT, `device_key` и подписи в лог не попадают.

| `msg` | Когда |
|---|---|
| `sim_start` | старт: число столов, адрес брокера без логина, TLS, `caps`, режимы сбоя, вид NVS |
| `sim_state` | смена состояния стола: `mode`, `relay`, `dim`, `led`, `buzzer`, `remaining_ms` |
| `sim_signal` | сигнал у стола: `signal` (`warn`, `blink2`, `grace`, `grace_blink`), `beeps` |
| `sim_relay` | свет включён командой: `relay: true`, `cmd_id`, `type` (`session.start` или `session.resume`), `ms_since_cmd` — метрика M1 |
| `sim_cmd` | итог команды: `type`, `seq`, `cmd_id`, `result`; `reason` — для `bad_format`, `bad_sig` и `bad_body` |
| `sim_fault`, `sim_net`, `sim_reboot`, `sim_slow_ack`, `sim_replay_old`, `sim_inject`, `sim_ota`, `sim_rebind` | режимы сбоя и служебные действия |
| `sim_control` | HTTP-управление запущено: адрес и порт |
| `mqtt_connected`, `mqtt_disconnected`, `mqtt_error` | связь с брокером; одинаковая ошибка подряд пишется один раз |
| `sim_claim_wait` | `--claim`: контроллер без ключей ждёт привязки |
| `sim_claim_failed` | `--claim`: `claim` не удался: `error` (`forbidden`, `rate_limited`, `bad_request`, `network`, `bad_response`, `http_<статус>`), `failures`, `retry_ms` (−1 — без повтора, уровень `error`) |
| `sim_claimed` | `--claim`: ключи получены и сохранены: `club_id`, `attempts` |
| `sim_claim_stored` | `--claim`: ключи взяты из файла, `claim` не нужен |
| `sim_unclaim` | `--claim`: ключи стёрты по `unclaim` |
| `sim_event` (`debug`) | событие положено в буфер |

## Новый контроллер (`--claim`, M5.1)

Повторяет прошивку (`firmware/lib/logic/src/bl_claim.*`, `bl_provisioning.cpp`):
1. Старт только с заводскими `device_id` и `claim_code`: строка QR `BLD1:{device_id}:{claim_code}` с наклейки. Её печатает `scripts/provision-factory.mjs`, код вида `7K2M-Q9XD-4HTB-R1VS`. Симулятор и прошивка принимают код 8…63 символа `[A-Za-z0-9-]`, `device_id` — UUID в любом регистре.
2. Пока ключей нет, контроллер шлёт `POST {SIM_API_URL}/api/devices/claim {device_id, claim_code}`:
   - первая попытка сразу, дальше через 5 с, 10 с, 20 с, затем раз в 30 с, плюс случайные до 20 %;
   - `rate_limited` — пауза 60 с;
   - `bad_request` — без повтора, повтор — `POST /sim/tables/{номер}/reboot`;
   - пока связь выключена (`/net {"up": false}`), код не тратится.
3. Ответ проверяется как в прошивке: `mqtt_url` только `mqtts://`, `device_key` — 32 байта, `club_id` — UUID. Ключи ложатся в `SIM_CLAIM_DIR/<device_id>.keys.json` (0600).
4. Дальше это обычный стол: MQTT по §2, логин — `device_id`, топики — с `club_id` из ответа, все режимы сбоя.
5. При перезапуске ключи берутся из файла, `claim` не зовётся (`sim_claim_stored`). Сбросить привязку — `POST /sim/tables/{номер}/unclaim` или удалить файл ключей.

Номер стола контроллер не знает: стол выбирает владелец при привязке. Номер `@N` (по умолчанию 101, 102, …) — только адрес в HTTP-управлении и поле `table` в логе. В `GET /sim/tables/{номер}` есть поле `claim`: `state` (`waiting`, `claimed`, `failed`), `attempts`, `failures`, `last_error`, `next_attempt_in_ms`, `source` (`claimed` или `stored`). До привязки `state` — `null`, сбои и `inject` — `409 not_claimed`; `net-drop` и `reboot` работают.

### T26: два новых контроллера рядом с 8 столами стенда

Контейнер `device-sim` со столами 1–8 не трогается. Новые контроллеры — отдельный процесс на хосте: свои `device_id`, порт управления и папка ключей.

1. Заводские данные. backend-B: `scripts/provision-factory.mjs` создаёт `device_id` и `claim_code`, пишет в базу только хеш кода. Он печатает наклейки с QR `BLD1:{device_id}:{claim_code}` и строки `factory …`. Нужны 2 строки `BLD1:…` (флаги скрипта — в его README).
2. Корень CA Caddy, как для моста ККТ:

   ```sh
   docker compose -p billiardum cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
   ```

3. Запуск из корня репозитория. Строки QR — в кавычках:

   ```sh
   SIM_API_URL=https://localhost:8443 SIM_API_CA_FILE=./caddy-root.crt \
   MQTT_URL=mqtts://localhost:8883 MQTT_CA_FILE=deploy/dev/certs/ca.crt \
   SIM_CONTROL_PORT=18081 \
   node tools/device-sim/index.mjs \
     --claim 'BLD1:<device_id_1>:<claim_code_1>' \
     --claim 'BLD1:<device_id_2>:<claim_code_2>'
   ```

   - `MQTT_URL` нужен, если `PUBLIC_HOST` в `.env` не `localhost`: в ответе `claim` брокер — `mqtts://{PUBLIC_HOST}:8883`, а сертификат брокера стенда выписан на `localhost`, `mosquitto` и `127.0.0.1`.
   - Порт 18080 занят контейнером, поэтому здесь 18081.
   - Ключи — в `$TMPDIR/billiardum-device-sim-claim` или в `SIM_CLAIM_DIR` вне репозитория.
4. В логе — `sim_claim_wait`, затем `sim_claim_failed` с `error: forbidden`: окно привязки ещё не открыто. Это нормально.
5. В мастере подключения: «Добавить контроллер» → QR (или ручной ввод строки `BLD1:…`) → стол. Через 30–36 с, не позже, в логе `sim_claimed`, затем `mqtt_connected`.

   ```sh
   curl -s 127.0.0.1:18081/sim/tables   # claim.state: claimed, online: true, state.mode: free
   ```

6. Дальше по T26: гость платит — `sim_relay` и `sim_state` с `relay: true` у этого номера (101 или 102), по окончании — `relay: false`. Сбои — те же запросы на порт 18081.
7. Повторный запуск той же командой берёт ключи из файла. Чтобы привязать заново, нужны `POST /sim/tables/101/unclaim` и новая привязка в мастере: код уже сгорел.

T28, «5 неверных кодов закрывают окно». Неверный код у владельца сервер ловит при `bind` по заводскому реестру, это зона backend-B. Сторона контроллера: запустить его с неверным кодом той же командой, например `--claim 'BLD1:<device_id_1>:WRONG-CODE-0000-0000'`, а владелец привязывает с верным. Попытки `claim` идут на 0, 5, 15, 35 и 65 с, плюс до 20 %. Через 1–1,5 мин окно закрыто, и верный код тоже получает `forbidden` до новой привязки.

Лимит `POST /api/devices/claim` — 60 запросов в минуту с IP и 6 в минуту на `device_id` (решение №161). Один контроллер делает не больше 4 попыток в первую минуту, потом не больше 2 в минуту, так что в лимит на `device_id` он укладывается. Лимит по IP выдерживает около 15 контроллеров, которые стартуют одновременно. На `rate_limited` пауза 60 с.

## Сценарии (`scenarios/*.json`)

Общие для симулятора (`lib/scenario.mjs`) и прошивки (`firmware/test/native/test_logic/support.cpp`). Время ускорено: часы виртуальные, с 0 мс, NVS в памяти. Сценарий начинается с загрузки контроллера: связь есть, событие `boot` уже создано.

```json
{
  "name": "Старт → T−5 → T−1 → льгота → free",
  "description": "…",
  "caps": ["relay", "led", "buzzer", "current"],
  "online": true,
  "steps": [
    { "cmd": "session.start", "body": { "session_id": "…", "remaining_ms": 600000, "buzzer": true } },
    { "advance_ms": 300000 },
    { "expect": { "mode": "ending", "led": "yellow_blink", "signals": { "warn": 1, "beep": 2 } } },
    { "events": ["boot"] }
  ]
}
```

Шаг — ровно одно действие:

| Действие | Что делает |
|---|---|
| `{"cmd": тип, "body"?, "seq"?, "id"?, "key"?: "other", "label"?, "ack"?: "ok"}` | подписанная команда. `seq` по умолчанию — следующий; `id` — `00000000-0000-4000-8000-<номер команды в сценарии>`; `key: "other"` — подпись чужим ключом. `ack` — ожидаемый итог (`ok` или код ошибки, по умолчанию `ok`). `label` — запомнить команду для `resend` |
| `{"raw": "текст", "ack"?: "bad_format"}` | байты как есть |
| `{"resend": метка, "ack_same"?: true, "ack"?}` | повторить запомненную команду байт в байт; `ack_same` — `ack` тот же байт в байт |
| `{"advance_ms": n}` | сдвиг времени, внутренние сроки срабатывают по порядку |
| `{"reboot": true}` или `{"reboot": {"down_ms"?, "reset_reason"?}}` | перезагрузка с тем же NVS; `down_ms` — сколько не было питания |
| `{"net": false}` / `{"net": true}` | связь с брокером; со связью события доставляются сразу |
| `{"fault": "bypass" \| "lamp-fault", "on": true}` | датчик тока: ток 380 мА при выключенном реле или 0 при включённом |
| `{"expect": {...}}` | частичное сравнение (ниже) |
| `{"events": [тип \| {"type", "data"?, "n"?, "boot"?, "at_uptime_ms"?}]}` | события, созданные с прошлой проверки `events`, — ровно этот список по порядку; объект сравнивается частично |

Поля `expect`:
- поля `state` §4: `mode`, `relay`, `dim`, `led`, `buzzer`, `remaining_ms`, `session_id`, `current_ma`, `last_seq`, `boot`;
- `lamp` — лампа горит физически;
- `signals` — счётчики за весь сценарий, через перезагрузки: `warn` (T−5), `beep` (сигналы пищалки), `blink2` (T−1), `grace` (начало льготы), `grace_blink`;
- `nvs_session` — `null` или часть записи сессии в NVS;
- `outbox` — типы недоставленных событий по порядку;
- `config` — часть настроек `config.set`.

Объект сравнивается частично: проверяются только указанные ключи, на любой глубине. Массивы и значения сравниваются точно.

| Файл | О чём |
|---|---|
| `01-full-cycle` | старт → T−5 → T−1 (мигание по 300 мс) → льгота с миганием раз в 15 с → `free` |
| `02-grace-dimmer` | льгота с диммером, `grace_dim` на ходу, `buzzer: false` |
| `03-extend-from-ending` | продление из `ending`: сигналы взводятся заново; та же фаза — без повтора; чужая сессия |
| `04-start-below-threshold` | команда ставит остаток ниже порога: сигнал текущей фазы сразу |
| `05-extend-from-grace` | продление из льготы, повторная льгота, продление сразу ниже `warn_ms[1]` |
| `06-stop` | стоп, `wrong_session` |
| `07-offline-finish` | офлайн-доигрывание (T5), `offline_session_finished` после связи |
| `08-reboot-server-resume` | перезагрузка, сервер ответил `session.resume` (T7) |
| `09-reboot-no-server` | перезагрузка без сервера: `сохранённый − S`, вторая — `free` и `offline_resume_denied`, третья — сессии нет |
| `10-reboot-grace-and-free` | перезагрузка в льготу; ответ `state.free`; новая сессия в окне ожидания |
| `11-service` | сервисный свет (T11) |
| `12-pending-reserved` | `pending` и `reserved` истекают, `session.start` из них (T12) |
| `13-replay` | точный повтор, `replayed_seq`, старый `session.extend` не продлевает (T8), `data.suppressed` |
| `14-bad-body` | диапазоны §3.3, `unknown_type`, `bad_format`, `bad_sig` |
| `15-bypass` | свет в обход, `fault` (T10), порог и время через `config.set` |
| `16-lamp-fault` | неисправная лампа, `current_confirm_ms` |
| `17-misc` | `identify`, `config.set` переживает перезагрузку, `ota.start` и его прерывание |
| `18-caps-relay-only` | готовое реле без индикатора, пищалки и датчика (путь B) |
| `19-resume-same-session` | `session.resume` и `session.start` той же сессии: фаза и сигналы сохраняются, мигание не обрывается; новая сессия — сигналы с нуля |

## Где протокол оставляет выбор

Те же решения — в прошивке. Предложение: закрепить их в `docs/protocol.md`.

**Команды и состояния**
- `session.start` и `session.resume` принимаются из любого состояния, сервер главный: идущая сессия, сервис, `pending`/`reserved` и обновление прошивки заменяются новой сессией.
- `session.start` и `session.resume` с `session_id` идущей сессии её не заменяют: остаток, `warn_ms`, `grace_ms`, `buzzer` обновляются, фаза и прозвучавшие сигналы сохраняются, начатое мигание не обрывается. Сигнал — только если остаток попал в другую фазу, как у `session.extend`. Сервер шлёт `resume` при каждом возврате онлайн и по сверке, поэтому в `ending` стол не пищит после каждого сбоя связи.
- `session.extend` и `session.stop` без идущей сессии с тем же `session_id` — `wrong_session`. В окне ожидания после загрузки `session.stop` с `session_id` сессии из NVS стирает её и отвечает `ok`.
- Во время сессии (`active`, `ending`, `grace`) `service.start`, `state.pending` и `state.reserved` — `wrong_session`. `state.pending` и `state.reserved` в `service` — тоже `wrong_session`.
- `state.free` принимается из любого состояния и гасит свет: сервер главный.
- `service.stop` не в `service` — `ok`, ничего не меняет. Повторный `service.start` задаёт новое время.
- `identify` без `led` в `caps` — `hw_fault`. `ota.start` вне `free`, в окне ожидания после загрузки или во время другого обновления — `busy_ota`.
- Команда, занимающая стол, прерывает обновление прошивки: событие `ota_failed` с `error: aborted`. Это `session.*`, `service.start`, `state.pending`, `state.reserved`. В прошивке после этого загрузочный раздел возвращается на текущий.

**Сигналы**
- Фазы остатка: 0 — больше `warn_ms[0]`; 1 — до `warn_ms[1]` включительно (сигнал T−5); 2 — до 0 (двойное мигание); 3 — льгота.
- По времени сигнал звучит при входе в новую фазу.
- После команды, задающей остаток: фаза 0 — сигналы взводятся заново; другая фаза, чем была, — сигнал этой фазы звучит сразу и один раз; та же фаза — без сигнала.
- Двойное мигание: выкл. 300, вкл. 300, выкл. 300, вкл. Мигание в льготу: выкл. 300 мс в начале льготы и затем раз в `grace_blink_s`. Новый `grace_blink_s` действует со следующего мигания после уже назначенного.
- `grace_ms` = 0 — льготы нет, свет гаснет на нуле.
- В `state` поле `relay` — логическое: на время мигания оно не меняется, `state` от мигания не публикуется.
- В льготе `remaining_ms` = 0, `dim` = `grace_dim`, если есть `dimmer`, иначе 100.

**NVS и правило 4**
- Сессия пишется в NVS:
  - при каждой команде, задающей остаток;
  - в начале льготы, с остатком 0;
  - раз в 60 с от последней записи, пока идёт `active` или `ending`.
- Окно ожидания закрывают только команды, задающие состояние: `session.*`, `service.start`, `state.*`. `ping`, `identify` и `config.set` не закрывают.
- `session.start` или `session.resume` после окна обнуляют `offline_resumes`. `session.extend` его не меняет.
- `offline_session_finished` создаётся, если сессия дошла до конца льготы без связи. Уходит после подключения.
- Состояние `fault` накладывается только на `free`, `pending` и `reserved`. Во время сессии и сервиса режим не меняется, сервер узнаёт о сбое по событию.

**Датчик тока**
- Ток в обход — реле логически выключено и ток ≥ `current_on_ma`.
- Неисправная лампа — лампа физически горит без приглушения и ток < `current_on_ma`.
- Событие — один раз, пока условие держится дольше `current_confirm_ms`. Условие пропало — защёлка снимается.
- Срок, ушедший в прошлое после уменьшения `current_confirm_ms`, срабатывает сразу.

**Значения по умолчанию `config.set`** (в §3.3 нет): `led_brightness` 128, `current_on_ma` 50, `current_confirm_ms` 10000, `grace_dim` 30, `grace_blink_s` 15.

**Сообщения**
- `state` уходит раньше `ack`, поэтому `ack.state_seq` указывает на уже опубликованный `state`.
- `ack` на `bad_format` — всегда с `cmd_id` и `seq`, равными `null`. На `bad_sig` в `ack` стоят `cmd_id` и `seq` из разобранной команды.
- `data.suppressed` есть в событии, только если пропущенных больше нуля.
- Событие `ota_ok` — `{version, error: null}`; `ota_failed` — `{version, error}`, где `error`: `aborted`, `rollback`, `download`, `sha256`, `image_sig`, `no_ota_key`, `sim_unsupported` (только симулятор).
- Вложенность JSON — не глубже 8 уровней (§3.3).

## Устройство

| Файл | Что внутри |
|---|---|
| `index.mjs` | вход: конфиг, логгер, по `SimDevice` на стол, HTTP-управление, остановка по SIGINT и SIGTERM (сам публикует `offline`) |
| `lib/canonical.mjs` | строгий разбор JSON и каноническая строка (§3.1) |
| `lib/command.mjs` | шаги 1–2 проверки: формат, обязательные поля и подпись |
| `lib/body.mjs` | шаг 4: тело по типу и диапазоны §3.3, умолчания `warn_ms` и `grace_ms` |
| `lib/replay.mjs` | таблица повторов §3.2 и сборка `ack` |
| `lib/machine.mjs` | автомат §5 без MQTT: сроки, сигналы, правило 4, датчик тока, события; часы и NVS — снаружи |
| `lib/modes.mjs` | состояния, индикатор и реле по состояниям, таблица переходов |
| `lib/nvs.mjs` | `MemoryNvs`, `FileNvs`, кольцевой буфер событий на 64 |
| `lib/clock.mjs` | `RealClock` и `FakeClock` для ускоренного времени |
| `lib/scenario.mjs` | исполнитель общих сценариев, датчик тока симулятора |
| `lib/device.mjs` | MQTT, питание, обрыв связи, режимы сбоя, метрика |
| `lib/control.mjs` | HTTP-управление |
| `lib/claim.mjs` | режим `--claim`: разбор `BLD1` и `factory`, задержки повтора, `POST /api/devices/claim`, файл ключей, `ClaimingDevice` |
| `lib/config.mjs`, `lib/log.mjs`, `lib/faults.mjs` | файл устройств и переменные, лог JSON, разбор режимов сбоя |

## Тесты

```sh
npm test -w tools/device-sim         # юнит-тесты, векторы и все сценарии; без брокера и Docker
npm run test:it -w tools/device-sim  # с настоящим брокером, нужен Docker
```

`npm test` проверяет:
- векторы `docs/protocol-vectors.json` и проход каждого через автомат до `ack`;
- края канонизации и формата, таблицу §3.2, тела и диапазоны §3.3;
- все сценарии `scenarios/*.json`;
- автомат на ускоренном времени: публикацию `state`, порядок «исполнить → NVS → `ack`», износ NVS (одна запись остатка в минуту), события, буфер 64, ограничение частоты;
- `SimDevice` с подменным клиентом MQTT: режимы сбоя, перезагрузку, `SIM_NVS_DIR`, перепривязку, метрику, HTTP-управление;
- конфиг и лог;
- режим `--claim` (`test/claim.test.mjs`, поддельный сервер привязки `test/helpers/claim-api.mjs` по правилам решения №67):
  - общие с прошивкой векторы `test/claim-vectors.json`;
  - ожидание привязки и задержки 5/10/20/30 с;
  - неверный код: 5 попыток закрывают окно;
  - окно закрыто по времени;
  - повтор после успеха: ключи из файла, код сгорел, потерянный ответ;
  - `bad_request`, `rate_limited`, `bad_response`, `unclaim`, два контроллера рядом;
  - `postClaim` по HTTP, HTTP-управление, конфиг.

`npm run test:it` поднимает свой контейнер `bl-fw-mqtt` (`eclipse-mosquitto:2.1.2-alpine`, decisions №40; порт 18884 на 127.0.0.1). Конфиг временный: вход по паролю, ACL как у роли Dynamic Security, TLS с одноразовым CA, если на хосте есть `openssl`. В конце контейнер удаляется. Тест запускает `index.mjs` с HTTP-управлением и проверяет:
- `online`, `state`, `boot`;
- `ping`, повтор, `replayed_seq`, `bad_sig`, `identify`, `bad_format`;
- `session.start` со `state` раньше `ack` и метрикой `sim_relay`;
- обрыв связи по HTTP: Last Will `offline`, затем снова `online`;
- перезагрузку по HTTP и `session.resume`;
- ACL, отсутствие секретов в логе, отказ TLS без нашего CA, Last Will при `kill -9`.

Переменные теста:
- `SIM_IT_KEEP=1` — оставить контейнер и временную папку;
- `SIM_IT_WORKDIR` — где создать временную папку;
- `SIM_IT_CONTAINER` и `SIM_IT_PORT` — другое имя контейнера и порт.
