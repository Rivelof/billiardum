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

## M1 (`m1/`)

Нужен поднятый стек с кодом M1 (`npm run dev`) с `ALLOW_DEV_LOGIN=1` и `DEV_ALLOW_ANY_MINUTES=1` (по умолчанию в `.env` разработки). Гости — синтетические телефоны `+7999…`, персонал — номера сида. API — через Caddy (`https://localhost:8443`, корень CA Caddy из контейнера), симулятор — `http://127.0.0.1:18080`, управление эмулятором ЮKassa — `docker exec billiardum-yookassa-emu-1 wget …/__emu/…`, база — только чтение. Столы tester — 1–6 (7–8 у pentester); каждый тест ждёт, пока его стол освободится, и в конце освобождает его («Закончить игру»).

```sh
# быстрые (около 2 минут): T1, T2, T7, T9, T10, T11, журнал
node --test --test-concurrency=1 tests/e2e/m1/0{1,2,6,8,9}-*.test.mjs tests/e2e/m1/1{0,3}-*.test.mjs

# долгие сценарии времени (ускоренное время, но пороги боевые): идут параллельно на разных столах
node --test tests/e2e/m1/03-t3-t4-autonomous.test.mjs      # T3 + T4 + «без действий персонала», ~11 мин, стол 6
node --test tests/e2e/m1/04-t5-offline-finish.test.mjs     # T5, ~5 мин, стол 5
E2E_T6_TABLES=1,5,4 node --test tests/e2e/m1/05-t6-offline-extend.test.mjs   # T6 A/B/C одновременно, ~6 мин
node --test tests/e2e/m1/07-t8-replay.test.mjs             # T8, ~2,5 мин, стол 1
node --test tests/e2e/m1/11-t12-two-guests.test.mjs        # T12, ~3,5 мин, стол 6
E2E_LATENCY_TABLES=1,6 node --test tests/e2e/m1/12-latency-p95.test.mjs     # p95 оплата → свет, 25 оплат

# браузер: playwright-core во временной папке, браузеры /opt/pw-browsers
E2E_PW_DIR=/путь/к/папке/с/node_modules E2E_SHOTS_DIR=/куда/скриншоты node --test tests/e2e/m1/14-browser.test.mjs

# в конце — журнал
node --test tests/e2e/m1/13-audit-verify.test.mjs
```

Тесты на один стол не запускать одновременно. Стол задаётся переменной (`E2E_T1_TABLE` … `E2E_T12_TABLE`, `E2E_T6_TABLES`, `E2E_LATENCY_TABLES`, `E2E_UI_T1_TABLE`, `E2E_UI_T2_TABLE`, `E2E_UI_T12_TABLE`).

| Файл | Сценарий | Что проверяет |
|---|---|---|
| `01-t1-sbp.test.mjs` | T1 | скан QR: `/t/{код}` → 302 на `/app/t/{код}` (строчные — тоже), кривой код и попытки открытого перенаправления (`//`, `\`, `https:`, CRLF, `..`, `?next=`, `X-Forwarded-Host`) → 404 или свой `/app/t/{код}`; 2 часа по СБП только API гостя: свет от `payments.confirmed_at` до `sim_relay` < 1 с (и `light_latency`), остаток 2:00:00 в API и контроллере, журнал; чек сессии `succeeded` и чек в эмуляторе (позиции = сумма, `full_payment`, `service`, покупатель); «Закончить игру» гасит свет |
| `02-t2-reception.test.mjs` | T2 | «Оплачу на ресепшене»: стол `pending` (white_blink), заявка у ресепшена с маской телефона, гостю список закрыт; наличных меньше суммы — отказ; «Принять» 2 000 ₽ — сдача, свет; повтор с тем же `Idempotency-Key` — тот же ответ, второй «Принять» — отказ, одна оплата; `bl.receipts` `kkt`/`receipt_pending`; `reception.accept` в журнале |
| `03-t3-t4-autonomous.test.mjs` | T3, T4, «без действий в программе клуба» | одна сессия 6 мин только API гостя: за 3 мин до конца продление на 3 мин → остаток 6 мин, `active`, индикатор `off`; затем T−5 `ending`/`yellow_blink`, T−1 `blink2`, T−0 `grace`/`red`, T+2 мин `free` (±3 с от `paid_until`), сервер `closed`/`expired`; уведомления гостю t1, t0, closed; в журнале сессии нет записей сотрудников |
| `04-t5-offline-finish.test.mjs` | T5 | обрыв связи посреди игры: свет до `paid_until`, льгота, гаснет сам без связи; тревога `device_offline`; после связи `offline_session_finished` в `bl.device_events` и журнале, сессия `closed` |
| `05-t6-offline-extend.test.mjs` | T6 | продление без связи: `session.extend` в очереди, контроллер сам не продлевает; A — связь в льготу → `session.resume`, свет продлён; B — свет погас, `interrupted`, «Продолжить» → свет на неотыгранное; C — «Вернуть деньги» → `bl.refunds` на всю сумму продления (№73), возврат и чек возврата в эмуляторе, `payment.refunded` |
| `06-t7-reboot.test.mjs` | T7 | перезагрузка посреди игры: свет выключен, после `session.resume` горит, остаток = `paid_until` − сейчас (±3 с); `boot` и `device.cmd` в журнале |
| `07-t8-replay.test.mjs` | T8 | режим `replay-old`: старая `session.extend` → `replayed_seq`, остаток не изменился, событие и тревога `replayed_seq` |
| `08-t9-bad-sig.test.mjs` | T9 | `bl-admin` не может публиковать в `cmd` (PUBACK 0x87); команды подаются контроллеру вживую через `POST /sim/tables/{n}/inject` (как из `cmd`): `session.start` чужим ключом на свободном столе — `ack` `bad_sig`, свет не включён, `seq` не сдвинулся, событие в `bl.device_events` и журнале, тревога `bad_sig` critical и `alarm.raised`, уведомление владельцу; `session.extend` идущей игры чужим ключом и с подписью из нулей — `bad_sig`, остаток не вырос |
| `09-t10-bypass.test.mjs` | T10 | режим `bypass`: `fault`, `bypass_detected`, тревога critical в API владельца и уведомление владельцу < 2 с после события, `alarm.raised` в журнале |
| `10-t11-service-light.test.mjs` | T11 | без кода/текста причины — `reason_required`, чужой код, > 30 мин, гость — отказ; с причиной — `service`/`purple` на время, стол для гостей `table_service`, `service.start` с причиной и сотрудником, тревога и уведомление владельцу; выключение — `service.stop` |
| `11-t12-two-guests.test.mjs` | T12 | две одновременные котировки: одна 200, вторая `409 table_pending`; удержание 3 мин, затем стол свободен; истёкшая котировка не оплачивается |
| `12-latency-p95.test.mjs` | p95 < 1 с | серия оплат: `confirmed_at` → `sim_relay`, `light_latency`, «Оплатить» в эмуляторе → `sim_relay`; p50/p95/max |
| `13-audit-verify.test.mjs` | журнал | `audit/verify` владельца и `bl.audit_verify` — ok, все записи; у каждой команды, исполненной симулятором на столах 1–6, и у каждого включения света есть `device.cmd` |
| `14-browser.test.mjs` | T1, T2, T12 в браузере | гость 360 px: скан QR (`/t/{код}` → 302 → экран стола) → оплата СБП в эмуляторе → таймер 2:00:00, без горизонтальной прокрутки, тёмная тема, «Закончить игру», чек; ресепшн 1280×800: заявка без перезагрузки, «сгорит через 15 минут», наличные со сдачей, «Свет на столе N включён»; второй гость — «Стол сейчас занимают» |

## Что тесты меняют

- База: попытки записи — только внутри транзакций, которые всегда откатываются (ROLLBACK). `npm run test:db` создаёт и удаляет свои временные базы `bl_test_*`.
- Брокер: `05` дважды и `06` один раз входят учёткой стола (1 и 8). Client id устройства обязателен, поэтому брокер на ~3 с отключает этот стол симулятора; симулятор переподключается сам, сервер шлёт ему `ping` — это обычная команда сервера с записью `device.cmd` в журнале. Тест ждёт, пока сервер снова напишет `devices_online` 8/8. В `cmd` тесты не публикуют ничего, что брокер принял бы.
- Свидетель MQTT подключается учёткой администратора брокера (`MQTT_ADMIN_USER`, роль Dynamic Security читает `#`) со своим client id (`bl-e2e-observer-…`). Учётка сервера закреплена за client id `bl-server`: под ней с этим id тесты не входят, чтобы не выбить живой сервер, — только с чужим id, чтобы проверить отказ.
- M1 создаёт обычные данные разработки через API: синтетических гостей `+7999…`, котировки, платежи в эмуляторе ЮKassa, сессии, заявки ресепшена, возвраты, сервисный свет, тревоги (`09` перед прогоном подтверждает старую тревогу `bypass_detected` своего стола от имени владельца). Симулятор: режимы `net`, `reboot`, `bypass`, `replay-old` на своих столах, в конце снимаются. `08` пытается опубликовать в `cmd` учёткой `bl-admin` — брокер отклоняет; команды с неверной подписью подаёт через `inject` симулятора и перед прогоном подтверждает старую тревогу `bad_sig` своего стола. Права брокера и Dynamic Security тесты не меняют, стек не перезапускают.

## Переменные

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `E2E_CI` | — | `1` — запускать `07-ci` |
| `E2E_SERVER_CONTAINER` | `billiardum-server-1` | контейнер сервера (для `docker logs`) |
| `E2E_SIM_CONTAINER` | `billiardum-device-sim-1` | контейнер симулятора |
| `E2E_CADDY_CONTAINER` | `billiardum-caddy-1` | контейнер Caddy (корень его CA) |
| `E2E_EMU_CONTAINER` | `billiardum-yookassa-emu-1` | контейнер эмулятора ЮKassa (M1, управление `/__emu/`) |
| `E2E_BASE_URL`, `E2E_SIM_URL` | `https://localhost:8443`, `http://127.0.0.1:18080` | API через Caddy и управление симулятором (M1) |
| `E2E_PW_DIR`, `PLAYWRIGHT_BROWSERS_PATH`, `E2E_SHOTS_DIR` | —, `/opt/pw-browsers`, `$TMPDIR/bl-e2e-m1-shots` | папка с `node_modules/playwright-core`, браузеры, скриншоты (M1, `14`) |
| `E2E_LATENCY_N` | `25` | число оплат в серии p95 (M1, `12`) |

Остальное — из `.env`: `DATABASE_ADMIN_URL`, `DATABASE_URL`, `MQTT_URL`, `MQTT_CA_FILE`, `MQTT_ADMIN_USER`, `MQTT_ADMIN_PASSWORD` (свидетель), `MQTT_SERVER_USER`, `MQTT_SERVER_PASSWORD` (только проверка отказа), `SIM_DEVICES_FILE`.
