# Модуль light: сессии, мост MQTT, планировщик, привязка контроллеров

Контракт — `docs/contracts/m1.md` §6, §8, §13; протокол — `docs/protocol.md` v1. Владелец — backend-light.

| Файл | Что внутри |
|---|---|
| `sessions/index.mjs` | `init(ctx)` / `stop()` / `light()`: мост MQTT (`ctx.bridge`), подписки outbox `payment.confirmed` и `payment.refunded`, `LISTEN bl_light`, планировщик, SSE |
| `sessions/api.mjs` | интерфейс для money (§13); до `init` работает автономно |
| `sessions/service.mjs` | оплата → сессия, остановка, «Я играю», выбор после `interrupted`, продление без оплаты, сервисный свет, «найти стол», зал, шаг планировщика |
| `sessions/device-logic.mjs` | хуки моста: тело команды на момент отправки, актуальное состояние стола, ack, события, сверка, тревоги |
| `sessions/kit.mjs`, `queries.mjs`, `view.mjs`, `settings.mjs`, `codes.mjs`, `errors.mjs`, `deps.mjs`, `listener.mjs` | общие действия, запросы, JSON, настройки клуба, код стола, ошибки, зависимости от core/money, LISTEN |
| `devices/store.mjs` | хранилище моста: M0 + `bl.device_commands`, `bl.device_events` |
| `devices/bind.mjs` | окно привязки и `claim`, Dynamic Security под `MQTT_ADMIN_USER` |
| `mqtt.mjs` | мост (M0 + очередь в базе, хуки, сверка, офлайн) |
| `scheduler.mjs` | таймеры сессий по `ctx.clock` |
| `api/routes/sessions.mjs`, `resources.mjs`, `devices.mjs` | маршруты §6 |

## Путь «оплата → свет»

1. money в одной транзакции подтверждает платёж и пишет outbox `payment.confirmed`.
2. Обработчик light (транзакция outbox) создаёт сессию (`paid_until = now + minutes` по `ctx.clock`), связывает платёж (`bl.session_payments`, `bl.payments.session_id`), пишет журнал `session.start`, outbox `session.started` и строку `bl.device_commands` (`queued`) + `pg_notify('bl_light')`. Идемпотентно по `payment_id`.
3. После коммита `LISTEN bl_light` будит мост. Мост в своей транзакции: блокировка устройства, проверка, что сессия ещё идёт, `remaining_ms` по `paid_until` на этот момент, `seq`, журнал `device.cmd` (`cmd_id`, `seq`, `type`, `session_id`), строка → `sent`; публикация после коммита.
4. `ack` → строка `acked`, `sessions.device_paid_until = время ack + remaining_ms`; для `session.start` по оплате — лог `{"msg":"light_latency","session_id":…,"ms":…}` (от `payments.confirmed_at` до `ack`).

Стол занят к моменту оплаты — `session.start_rejected` в журнал, тревога `payment_conflict`, `refund` через money.

## Состояния и сигналы

`active` → `ending` (≤ `warn_ms[0]`) → `grace` (`paid_until` прошёл) → `closed` в `paid_until + grace_ms`. Продление: `paid_until += minutes`, из `grace` тоже; подтверждение пришло после закрытия по времени — игра продолжается с момента подтверждения, если стол свободен, иначе возврат. Уведомления участникам через `notify.send`: `session.t10` («Продлить»), `session.t1`, `session.t0`, `session.closed`; пройденный при покупке порог не шлётся.

`interrupted` — контроллер подтвердил свет до `device_paid_until`, а оплачено больше чем на 60 с: так бывает, если продление оплачено без связи и связь не вернулась до локального конца (T6). Ставится при возвращении контроллера (по `device_paid_until + grace_ms`), по событию `offline_session_finished` или планировщиком в момент закрытия. Свет сам не возвращается; плательщику уведомление `session.interrupted`. Выбор ждёт 24 часа (decisions №65), затем планировщик сам возвращает деньги за неотыгранное (больше 60 с; журнал `session.resolve` с `auto: true`, уведомление `session.refunded`). `resolve`: `continue` — `paid_until = now + неотыгранное`, `session.start`; `refund` — возврат долей с последних платежей (`payments.refund`), «Без лимита» — закрытие по `device_paid_until` (money спишет фактическое). `interrupted` стол не держит.

Бронь следующего гостя (№129): оплата старта и продления, повторное открытие и `continue` не заходят дальше её начала минус 5 минут — `paid_until` обрезается, лишнее возвращается частичным возвратом (`payments.refund`, причина `booking_conflict`, ключ `booking-cut-{payment_id}`; для `continue` — доли платежей с конца), журнал `session.booking_cut`, гостю уведомление `session.booking_cut` («Стол N: забронирован на HH:MM, вернули … за M минут»). До брони меньше минуты — полный возврат (`session.start_rejected`, reason `booking`), `continue` — `booking_conflict`. Депозит: до брони меньше минимума тарифа — `booking_conflict`, иначе минут не больше, чем до брони. `holdPending` владельцу брони (удержание `reserved`, source `booking`) — `booking_start_required` с `booking_id`: игра по брони начинается через booking. `clearReserved({ resourceId, source?, refId? })` снимает только совпадающее удержание. Бронь по телефону (`user_id` null) держит стол и для депозита, и для чужого `startFromBooking`.

Удержания стола: главное — `service`, затем `pending`, затем `reserved`. Бронь, подтверждённая во время сервиса или игры, записывается, но контроллеру остаётся сервис/игра; `state.reserved` — когда стол свободен (после `service.stop`, конца игры; сервис кончился сам по таймеру — мост тихо досылает актуальное состояние по `expected().show`, без тревоги). Сверка не гасит сервис из-за брони (регресс R2).

`availabilityDuring(db, { resourceId, from, to, userId?, source?, refId? })` → `{ unavailable, reasons, intervals }` для booking (регресс R1): `offline` (эпизоды без связи `bl.device_offline` — пишет мост; связи нет сейчас — до конца окна; стол без контроллера — всё окно), `session`, `service`, `inactive`, `foreign_hold`. Не в счёт: удержание этой брони (`source` + `refId`), игра гостя `userId` (плательщик или участник) и сессия брони, `pending` самого гостя. `from = to` — «сейчас». `getResourceStatus` отдаёт `online` при любом статусе.

Турнир (M4, №138): удержание `reserved` с `source: 'tournament'`, `ref_id` = матч. На время матча стол не принимает старт по QR, оплату, депозит и бронь — `table_busy` с `{ reason: 'tournament', busy_until }`; бронь и очередь удержание турнира не заменяют; сервис ресепшена с причиной допустим (удержание турнира остаётся под ним). `startFromTournament` — свет на матч без платежа и плательщика до конца удержания (сессия `source: 'tournament'`, `match_id`), журнал `session.start` от системы или сотрудника, не ручное действие; продление оплатой — возврат; `stopFromTournament` гасит свет матча (`reason_code: tournament_end`). Пока идёт турнир (№146, `tournamentHolds` модуля турниров — окно турнира и матчи), его столы и между матчами не принимают QR, оплату, депозит, старт по брони, продление и «Продолжить» (`table_busy` с `reason: 'tournament'`, оплата — возврат); статус стола — `reserved`, `hold_source: 'tournament'`; начало турнира обрезает игру как бронь (до начала − 5 минут, остаток — возврат, уведомление «с HH:MM турнир»). `extendFromTournament` продлевает удержание или игру матча (`session.extend` с журналом), идемпотентно; только матч `playing` идущего турнира на этом столе (иначе `session_not_active`) и не дальше конца турнира + время матча (`tournaments.matchLightWindow`, иначе `limit_exceeded`; окна нет — `not_found`), №147. Для Бильярдум+: `sessionParticipants`, `sessionOf`; в представлении сессии участники — `{ user_id, nick, label }` (ник — `plus.nicksOf`, без модуля — null).

«Я играю» (`POST /api/sessions/{id}/join`) — только с кодом стола в теле `{ code }` (из QR): код не этого стола — `not_found`, без кода — `bad_request`.

`cancelled` — все платежи сессии возвращены (outbox `payment.refunded`, сверка по `bl.refunds`): свет гаснет `session.stop`.

## Актуальное состояние стола (после `boot`, выхода онлайн, расхождения)

Идёт сессия: контроллер её ведёт → `session.resume` (остаток по `paid_until`); не ведёт, но по подтверждённому остатку ещё должен гореть (перезагрузка, T7) → `session.resume`; уже доиграл сам → `interrupted` или `session.resume` с остатком льготы. Контроллер ведёт сессию, которой нет в базе → `session.stop` (`not_paid`). Иначе `service.start` (остаток), `service.stop`, `state.pending`/`state.reserved` (остаток удержания), `state.free`. Команды, поставленные пока устройство было офлайн, помечаются `superseded`.

Мост (`server/mqtt.mjs`): без связи с брокером ничего не публикует; при обрыве неподтверждённые команды — `abandoned`, очереди сброшены, исходящие QoS 1 библиотеки mqtt удалены; после переподключения онлайн-столам — актуальное состояние. `config.set` после офлайна досылается новой командой (новый seq и `device.cmd` в журнале). Ошибка базы при отправке не теряет команду: повтор через 5 с, после 5 ошибок подряд — `cancelled` и актуальное состояние. Sweep раз в 5 с дочитывает `queued` онлайн-устройств (страховка от потерянного NOTIFY); LISTEN проверяется `select 1` раз в 30 с. Сообщение контроллера не обработано из-за базы (сервер поднялся раньше Postgres, R4): последние `status` и `state` устройства и до 32 событий повторяются через 5 с; когда база снова отвечает — `db_recovered` и повторная подписка на `state`/`status` (брокер заново отдаёт retained), `devices_online` пересчитывается. Часовой пояс клуба, которого не знает Intl, — тихие часы по UTC и тревога `club_timezone_invalid`.

Объект `session` (контракт §14): `club: {id, timezone}`, `resource: {id, number, type, title}`. Чек сессии: `receipt_status` — итог по `receiptStatus` money (есть `failed` → `failed`; есть `pending`/`receipt_pending` → `pending`; все `succeeded` → `succeeded`; иначе `none`), у каждого платежа — свой `receipt_status`. Сервисный свет: `reason_code` — `cleaning`, `repair`, `training`, `other` (другой — `bad_request`), `reason_text` обязателен.

## Тревоги (`alarms.raise`, уровни PRODUCT §8 и decisions №66)

`bypass_detected`, `relay_fault`, `bad_sig`, `light_without_session`, `state_mismatch` (state ≠ база > 10 с), `device_offline` (офлайн во время сессии > 120 с), `service_light`, `manual_action`, `payment_unapplied` — `critical`; `lamp_fault`, `replayed_seq`, `events_dropped`, `ota_failed`, `offline_resume_denied`, `cmd_no_ack`, `payment_conflict`, `club_timezone_invalid` — `important`. Ручные действия владельцу уведомляет core всегда (`raise`, manual), со своим текстом light.

## Журнал

`device.cmd`, `device.event` (один раз по `(device_id, boot_id, n)`), `device.state_mismatch`, `device.seq_sync`, `device.bind`, `device.claim`, `session.start`, `session.extend`, `session.stop`, `session.close`, `session.interrupted`, `session.resolve`, `session.start_rejected`, `session.booking_cut`, `service.start`, `service.stop` (причина — своя или причина включения), `manual.extend_free`.

## Настройки клуба (`clubs.settings`)

`grace_ms` (120 000), `warn_ms` ([300 000, 60 000]), `service_max_minutes` (30), `buzzer` (true), `buzzer_quiet` (`{"from":"23:00","to":"09:00"}` или массив, местное время клуба).

## Привязка контроллера

`POST /api/clubs/{club}/devices/bind {device_id, resource_id, claim_code}` (владелец, монтажник; `claim_code` с наклейки на корпусе) — окно 30 минут, в базе `sha256(device_id:claim_code)`. `POST /api/devices/claim {device_id, claim_code}` — без входа, 10 запросов в минуту с IP; 5 неверных кодов закрывают окно. Ответ: `mqtt_username`, `mqtt_password`, `device_key` (base64), `mqtt_url` (`MQTT_PUBLIC_URL` или `mqtts://{хост PUBLIC_HOST}:8883`), `club_id`. Нужны `MQTT_ADMIN_USER` и `MQTT_ADMIN_PASSWORD` в окружении сервера.

## Тесты

```sh
npm test -w @billiardum/server            # без базы: test/bridge-light.test.mjs, test/light-unit.test.mjs (+ M0 и соседи)
# на Postgres (как test:db core: DATABASE_ADMIN_URL, временные базы light_t_*, пул под app_api через SET ROLE);
# LIGHT_IT=1 — it-sim сам поднимает брокер bl-light-it-* (docker и openssl) и удаляет его:
DATABASE_ADMIN_URL=postgres://supabase_admin:…@127.0.0.1:54322/postgres LIGHT_IT=1 \
  node --test --test-concurrency=1 "server/test/light/*.test.mjs"
```

Переменные: `DATABASE_ADMIN_URL` (или `LIGHT_TEST_DB_URL` — главнее), необязательно `LIGHT_TEST_APP_PASSWORD` (вход `app_api` по паролю вместо `SET ROLE`); для it-sim — `LIGHT_IT=1` или готовый отдельный брокер `LIGHT_IT_MQTT_URL`, `LIGHT_IT_CA_FILE`, `LIGHT_IT_ADMIN_USER`, `LIGHT_IT_ADMIN_PASSWORD` (общий брокер стека нельзя: тест создаёт свои учётки). `.env` тесты не читают; без `DATABASE_ADMIN_URL` пропускаются.

`test/light/harness.mjs` — временная база со всеми миграциями и сидом, поддельные часы и таймеры (ускоренное время), поддельный контроллер по протоколу v1, доставка outbox вручную. `it-sim.test.mjs` — реальное время, outbox core, брокер и симулятор; `LIGHT_IT_SESSIONS` — число оплат для p95.
