# Мост ККТ и эмулятор АТОЛ (`@billiardum/kkt-bridge`)

Служба на ПК ресепшена клуба (decisions №77, №78, №85; контракт `docs/contracts/m2.md`): держит **исходящее** WebSocket-соединение с сервером «Бильярдума», получает задания на чек и отдаёт их веб-серверу драйвера ККТ АТОЛ на этом же ПК, отвечает серверу номером ФД, ФП и временем. **Наружу ничего не слушает.** Node 22, без внешних зависимостей (клиент WebSocket — встроенный в Node 22).

Сервер мостов, очередь чеков и протокол — `server/kkt/README.md`.

## Запуск

```
node tools/kkt-bridge/index.mjs --config C:\kkt-bridge\kkt-bridge.json
```

или `KKT_BRIDGE_CONFIG=путь`. Токен моста выдаёт владелец в программе клуба (`POST /api/clubs/{club}/kkt/bridges`, показывается один раз) — положить в файл `token_file` или в переменную `KKT_BRIDGE_TOKEN`. Свой CA (разработка, Caddy с локальным CA) — `NODE_EXTRA_CA_CERTS=путь_к_ca.pem`. Лог — строки JSON в stdout, токена в логе нет. Установщик для Windows — после пилота (№85); сборку под Windows делает devops.

Файл настроек (JSON; BOM от «Блокнота» снимается), пример — `kkt-bridge.example.json`:

| Поле | По умолчанию | Что задаёт |
|---|---|---|
| `server_url` | — | `wss://{PUBLIC_HOST}/api/kkt/ws`; `ws://` — только localhost или `allow_insecure: true` (разработка) |
| `token_file` / `token` | — | токен моста (64 символа base64url); `KKT_BRIDGE_TOKEN` главнее |
| `atol_url` | `http://127.0.0.1:16732` | веб-сервер драйвера АТОЛ |
| `atol_api` | `v2` | `v2` — «АТОЛ. Web Requests» (`/api/v2/requests`), `legacy` — старый веб-сервер ДТО 10 (`/requests`) |
| `atol_device_id` | — | `?deviceID=` — ККТ на веб-сервере, если их несколько |
| `atol_user`, `atol_password` | — | Basic-вход веб-сервера АТОЛ, если включён |
| `name` | `Ресепшн` | имя кассы (ПК) в программе клуба |
| `data_dir` | `./kkt-bridge-data` | журнал моста `journal.json` (права 0600) |
| `job_timeout_ms`, `poll_ms` | 60000, 500 | сколько ждать результат задания и как часто спрашивать АТОЛ |
| `status_poll_ms` | 15000 | как часто проверять ККТ (`operations/queryDeviceStatus`) |
| `reconnect_min_ms`, `reconnect_max_ms` | 1000, 60000 | переподключение с нарастающей паузой (×2, разброс ±20 %) |

## Как работает

1. Подключение: `Authorization: Bearer <токен>`, `hello {v, name, version, atol_api}` → `welcome {bridge_id, club_id, ping_ms}`. Нет сообщений от сервера 3 × `ping_ms` — соединение рвётся и поднимается заново. Код закрытия 4001 (мост отозван) и 4003 — повтор с максимальной паузой.
2. Задание `job {job_id, kind: receipt|open_shift|close_shift, uuid, request}` выполняется по одному. **Сначала** `GET /requests/{uuid}`: задание уже есть — мост ждёт его результат; нет — отмечает UUID в журнале и ставит `POST /requests {uuid, request}`. Повтор того же UUID после обрыва не пробьёт второй чек (№78).
3. Результат `result {job_id, uuid, kind, outcome, task_created, fiscal?, error?}`:
   - `done` — `fiscal {fd, fp, fn, receipt_number, shift_number, registration_number, datetime, total, partial}` (`partial` — АТОЛ вернул только номер ФД после обрыва связи с ККТ);
   - `error` — документа нет: `error {code, description, category}`, `category`: `connection` (ККТ не на связи; `kkt_offline` — АТОЛ не принял задание, `task_created: false`), `paper`, `fn`, `shift_expired` (смена ККТ > 24 ч; для неизвестных кодов мост сам спрашивает состояние смены), `invalid`, `unknown`;
   - `skipped` — смена ККТ уже открыта (open_shift) или закрыта (close_shift);
   - `in_progress` — задание ещё в очереди АТОЛ или очередь заблокирована (бумага, связь): сервер повторит тот же UUID;
   - `unknown` — мост уже отправлял этот UUID, а АТОЛ его не знает (`atol_task_lost`): второй раз не ставится, сервер поднимает тревогу.
4. Окончательный результат хранится в журнале, пока сервер не ответит `ack {uuid}`, и досылается после переподключения.
5. Состояние ККТ (`status {kkt: {online, reason, paper, blocked}}`) — при изменении: сервер предупреждает ресепшн (SSE `kkt`) и сразу повторяет отложенные чеки, когда ККТ вернулась.

## Эмулятор веб-сервера АТОЛ (`emu/`)

Только разработка и тесты (при `NODE_ENV=production` не запускается), состояние в памяти:

```
ATOL_EMU_PORT=16732 ATOL_EMU_HOST=127.0.0.1 node tools/kkt-bridge/emu/index.mjs
```

Номер ФН — случайный при каждом запуске (`9999` и 12 цифр, в логе `atol_emu_started`): счётчики эмулятора в памяти, после перезапуска ФД снова с 1, и с прежним ФН пара (ФН, ФД) совпала бы с уже пробитыми чеками; новый ФН — как замена ФН на ККТ, том не нужен. `ATOL_EMU_FN` — свой номер (16 цифр; повтор номера при перезапуске сервер встретит тревогой `receipt_fd_conflict`). `ATOL_EMU_CONTROL_TOKEN` — `/__emu/*` только с `X-Emu-Token`; `ATOL_EMU_AUTO_OPEN_SHIFT=0` — без автоматического открытия смены чеком.

API: `POST /api/v2/requests` (201, повтор UUID — 409, ККТ выключена в режиме `reject` — 409), `GET|DELETE /api/v2/requests/{uuid}` (404 — нет), `GET /api/v2/getRequestsQueueStatus`, `GET /api/v2/serverInfo`, `POST /api/v2/operations/queryDeviceStatus|queryShiftStatus|queryFnStatus`; то же по `/requests` в старом формате (`errorCode`, `errorDescription`). Задачи: `sell`, `sellReturn`, `openShift`, `closeShift`, `getShiftStatus`, `getDeviceStatus`, `getFnStatus`, `continuePrint`, `reportX`. Проверяет задание чека (сумма позиций = `total`, оплаты, типы НДС, признаки, кассир). Оплаты `cash`, `electronically`, `prepaid` (зачёт предоплаты, M3), `credit`, `other`: сумма ≥ сумме чека, сдача только с наличных, `prepaid` — не больше позиций «полный расчёт» (позиции `fullPrepayment`, `prepayment`, `advance` зачётом не оплачиваются). В документе — `prepaid_kopecks` и `cash_kopecks` (наличные без сдачи); в `GET /__emu/state` у смены — `totals.sell|sellReturn` по типам оплаты и `cash_kopecks` (наличные в ящике: приход − возврат). ФД сквозной, ФП — 10 цифр, номер чека в смене, номер смены; первый чек в закрытой смене открывает её.

Управление: `GET /__emu/state`, `GET /__emu/documents`, `POST /__emu/reset`, `POST /__emu/power {on, mode: reject|error|wait}`, `POST /__emu/paper {present, mode: error|block}`, `POST /__emu/fn {error: код|null}`, `POST /__emu/delay {ms}`, `POST /__emu/fault {kind: "lose_after_fiscal" | "forget_request", times}` (`forget_request` — задание выполнено, документ в ФН, но веб-сервер его «забыл»: GET — 404; мост сообщает «исход неизвестен», сервер поднимает тревогу `receipt_unknown`, управляющий отмечает чек `mark-printed`), `POST /__emu/shift {expired: true}`.

## Тесты

`node --test "tools/kkt-bridge/test/*.test.mjs"` (после подключения пакета в workspaces — `npm test -w @billiardum/kkt-bridge`): эмулятор (17, с зачётом предоплаты) и мост (17) — задание, повтор и обрыв (один чек на UUID), выключенная ККТ (три режима), журнал после перезапуска, потерянное задание, смена ККТ, просроченная смена, состояние ККТ, настройки. Тестовый сервер WebSocket — пакет `ws` (devDependency).

## Сверить со Swagger драйвера 10.x (документация АТОЛ из среды не открывалась)

Формат взят из открытого кода (PHP-клиент `krasfree/atol-client`: `POST /requests {uuid, request: [...]}`, `GET /requests/{uuid}`; агент `avb56/kktsite-agent`, MIT, повторяет «АТОЛ. Web Requests» 1.0.4.0: `/api/v2/…`, `{error: {code, description}}`, статусы `wait/inProgress/ready/error/interrupted/blocked/canceled`, 409 на повтор UUID) и памяти о JSON-заданиях ДТО 10. Проверить на настоящем драйвере:

1. Путь и формат: `/api/v2/requests` (Web Requests) или `/requests` (старый веб-сервер); код ответа на постановку (201/200); тело ошибки; что отвечает POST при выключенной ККТ (409 или задание ждёт).
2. Результат: `results[].error.code/description` или `errorCode/errorDescription`; `status`; `result.fiscalParams` — `fiscalDocumentNumber`, `fiscalDocumentSign` (строка или число), `fnNumber`, `fiscalReceiptNumber`, `shiftNumber`, `registrationNumber`, `fiscalDocumentDateTime`, `total`.
3. Чек: `type` `sell`/`sellReturn`, `taxationType` (`osn`, `usnIncome`, `usnIncomeOutcome`, `envd`, `esn`, `patent`), `electronically`, `operator.name` (до 64 символов; нужен ли `vatin` кассира), `items[]` (`type: position`, `name` ≤ 128, `price`, `quantity`, `amount`, `tax.type`, `paymentMethod`, `paymentObject`, **`measurementUnit` для ФФД 1.2 — строка `piece` или число 0**), `payments[]` (`cash`, `electronically`, **`prepaid` — зачёт предоплаты: имя типа и правило «только позиции полного расчёта» проверить**), `total`.
4. Ставки: `none`, `vat0`, `vat10`, `vat20`, `vat110`, `vat120`, `vat5`, `vat7`, `vat105`, `vat107` и **`vat22`, `vat122` (НДС 22 % с 2026 года — имена не подтверждены)**; признаки предмета расчёта ФФД 1.2 (`service`, `commodity` и др. — могли смениться).
5. Коды ошибок (`lib/codes.mjs`): связь 1–4, 241; бумага 44–46, 114; ФН 115, 116, 159, 166, 177 — из открытого кода; **68 (смена > 24 ч), 69 (смена закрыта), 70 (смена открыта), 9 (неверный параметр) — предположение**.
6. `operations/queryDeviceStatus` и `queryShiftStatus` (поля `deviceStatus.paperPresent`, `coverOpened`, `shiftStatus.state`: `opened`/`closed`/`expired`); `getShiftStatus` как задание.
7. Автооткрытие смены первым чеком; что возвращает задание после восстановления связи («только номер ФД»); сколько хранятся выполненные задания (`deleteRequestsAfter`).
