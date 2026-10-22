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

`cancelled` — все платежи сессии возвращены (outbox `payment.refunded`, сверка по `bl.refunds`): свет гаснет `session.stop`.

## Актуальное состояние стола (после `boot`, выхода онлайн, расхождения)

Идёт сессия: контроллер её ведёт → `session.resume` (остаток по `paid_until`); не ведёт, но по подтверждённому остатку ещё должен гореть (перезагрузка, T7) → `session.resume`; уже доиграл сам → `interrupted` или `session.resume` с остатком льготы. Контроллер ведёт сессию, которой нет в базе → `session.stop` (`not_paid`). Иначе `service.start` (остаток), `service.stop`, `state.pending`/`state.reserved` (остаток удержания), `state.free`. Команды, поставленные пока устройство было офлайн, помечаются `superseded`.

Объект `session` (контракт §14): `club: {id, timezone}`, `resource: {id, number, type, title}`. Чек сессии: `receipt_status` — итог по `receiptStatus` money (есть `failed` → `failed`; есть `pending`/`receipt_pending` → `pending`; все `succeeded` → `succeeded`; иначе `none`), у каждого платежа — свой `receipt_status`. Сервисный свет: `reason_code` — `cleaning`, `repair`, `training`, `other` (другой — `bad_request`), `reason_text` обязателен.

## Тревоги (`alarms.raise`, уровни PRODUCT §8 и decisions №66)

`bypass_detected`, `relay_fault`, `bad_sig`, `light_without_session`, `state_mismatch` (state ≠ база > 10 с), `device_offline` (офлайн во время сессии > 120 с), `service_light`, `manual_action`, `payment_unapplied` — `critical`; `lamp_fault`, `replayed_seq`, `events_dropped`, `ota_failed`, `offline_resume_denied`, `cmd_no_ack`, `payment_conflict` — `important`. Ручные действия владельцу уведомляет core всегда (`raise`, manual), со своим текстом light.

## Журнал

`device.cmd`, `device.event` (один раз по `(device_id, boot_id, n)`), `device.state_mismatch`, `device.seq_sync`, `device.bind`, `device.claim`, `session.start`, `session.extend`, `session.stop`, `session.close`, `session.interrupted`, `session.resolve`, `session.start_rejected`, `service.start`, `service.stop` (причина — своя или причина включения), `manual.extend_free`.

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
