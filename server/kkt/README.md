# ККТ, смены и отчёты M2 (backend-kkt)

Контракт — `docs/contracts/m2.md` (§1.2, 1.3, 1.6, 1.8–1.10, §3–§5, §7); решения №71, №77, №78, №81, №83, №84. Папки: `server/kkt/`, `server/shifts/`, `server/reports/`, маршруты `api/routes/{kkt,shifts,reports}.mjs`, миграции `supabase/migrations/0500_kkt.sql`, `0510_shifts.sql`, сид `supabase/seed.d/0500_kkt.sql`, мост и эмулятор АТОЛ — `tools/kkt-bridge/` (свой README).

Проверено **на эмуляторе веб-сервера АТОЛ**: настоящей ККТ и документации АТОЛ в среде нет (список полей для сверки — `tools/kkt-bridge/README.md`).

## Модуль (`server/kkt/index.mjs`)

`init(ctx)` / `stop()` по контракту M1 §2.1; плюс `handleUpgrade(req, socket, head)` — событие `upgrade` HTTP-сервера для `/api/kkt/ws` (false — путь не наш), `closeConnections()` — закрыть соединения мостов до `server.close()`. Подписка outbox `shift.closed` (`reports.shift_closed`) — отчёт смены владельцу. Настройки для тестов — `ctx.kkt` (`resendMs`, `tickMs`, `alarmTickMs`, `staleMs`, `pingMs`, `retryBaseMs`, `retryMaxMs`); сверка с ЮKassa — `ctx.money.config` или окружение money (`YOOKASSA_API_URL`, `SECRETS_ENC_KEY`).

## Интерфейсы для соседей (§5)

| Функция | Суть |
|---|---|
| `server/kkt/api.mjs` `enqueueReceipt(db, { clubId, kind: 'sell'\|'sell_refund', lines, payments, operatorName, paymentId?, saleId?, refundId?, at? })` → `receipt_id` | строка `bl.receipts` (`channel kkt`, `receipt_pending`, `kkt_job`) в транзакции вызывающего; задание проверяется сразу (сумма позиций = сумме оплат, НДС, признаки) — иначе `400 bad_request`, продажа откатывается; повтор с тем же `saleId` (или `paymentId`) и видом — тот же `receipt_id`; после коммита будит очередь клуба |
| `lines` | позиции в виде чека ЮKassa (`description, quantity, amount.value — цена за единицу, vat_code, payment_mode, payment_subject`) или короткие (`name, price_kopecks, quantity, vat_code?, payment_subject?`) |
| `payments` | `[{method: cash \| card_terminal \| electronically, amount_kopecks}]` |
| outbox `receipt.printed` | `{receipt_id, club_id, fd, fp}` (`fp` — `null`, если АТОЛ вернул только номер ФД) |
| outbox `receipt.failed` | `{receipt_id, club_id, error}` |
| `server/shifts/api.mjs` `currentShift(db, clubId)` | `{id, club_id, number, opened_at, opened_by, opened_by_name, float_kopecks}` или `null` |

## Очередь чеков (`queue.mjs`, `service.mjs`)

- Все строки `bl.receipts` с `channel = 'kkt'` и `receipt_pending` — от кассы M2 и от заявок стола M1 (money пишет их без `kkt_job`: оплата и кассир берутся из платежа — `accepted_by`, иначе открывший смену) (№84). Служебные задания смены ККТ — `bl.kkt_ops` (`open_shift`, `close_shift`), идут раньше чеков.
- Одно задание клуба «в полёте» (`kkt_job.state = 'sent'`, привязано к мосту). Нет результата 30 с — то же задание с тем же UUID тому же мосту; мост сначала спрашивает АТОЛ. Мост отключился — задание ждёт его, другому мосту не уходит (иначе второй чек на другой ККТ).
- UUID задания АТОЛ: первая попытка — `receipt_id` (№78). После **окончательной** ошибки АТОЛ по этому UUID (задание есть, документа нет) следующая попытка получает новый UUID — детерминированный от `receipt_id` и номера попытки; все UUID — в `kkt_job.uuids`. АТОЛ не принял задание (ККТ не подключена) — UUID тот же.
- Ошибки по категориям моста: `connection`, `paper` — повтор без предела (5, 10, 20 … 60 с; когда мост сообщит, что ККТ на связи, — сразу); `shift_expired` — задание `close_shift` и повтор; `fn`, `unknown` — 5 попыток, затем `failed`; `invalid` (и неверные данные чека) — сразу `failed`. `failed` — outbox `receipt.failed`, журнал `kkt.receipt_failed`, тревога `receipt_failed` (важно).
- Исход неизвестен (мост: `atol_task_lost`; мост отозван с заданием в полёте) — `kkt_job.state = 'lost'`, чек не повторяется сам, тревога `receipt_unknown` (критично). Управляющий: «повторить» (`retry`, проверили — на ККТ нет) или «пробит» (`mark-printed`, ФД и ФП с ленты — ручное действие, уведомление владельцу).
- Пробит: `status = 'printed'`, `fd`, `fp`, `fn`, `printed_at`, `fiscal.kkt` (номер чека и смены ККТ, регистрационный номер, время ККТ), outbox `receipt.printed`, журнал `kkt.receipt_printed`. Пробитый чек неизменен (триггер `receipts_kkt_guard`), пара (ФН, ФД) уникальна.
- Предупреждение ресепшену: SSE `kkt` в `club:{id}` — `{state: online|warning|offline, reason, bridges, queue: {pending, pending_kopecks, oldest_pending_at, unknown, failed}}` при подключении и отключении моста, смене состояния ККТ, постановке и пробитии чека; то же — `GET /api/clubs/{club}/kkt/status`.
- Чек не пробит больше 10 минут — раз в 30 с `bl.kkt_due` (SECURITY DEFINER, только id) → тревога `receipt_pending` (важно) клубу: «N чеков на сумму»; чек отмечается `alarmed_at`, повтор не дублирует.

## Мосты и WebSocket (`bridges.mjs`, `ws.mjs`, `tokens.mjs`)

- Токен моста — base64url(16 байт `club_id` ‖ 32 случайных байта), выдаётся владельцу один раз; в базе — sha256. Клуб читается из токена, строка ищется в контексте этого клуба (RLS) — узкая функция для входа не нужна; подменённый клуб в токене — 401.
- `GET /api/kkt/ws` с `Upgrade: websocket` (библиотека `ws`, MIT): только `Authorization: Bearer`; запрос с `Origin` (браузер) — 403; 30 подключений в минуту с IP; кадры — текст JSON до 256 КБ, без сжатия; 300 сообщений за 10 с — закрытие. Повторное подключение того же моста закрывает прежнее (4000). Отозванный мост — закрытие 4001 (сразу при отзыве и проверкой раз в минуту).
- Протокол: мост → `hello`, `result`, `status`, `pong`; сервер → `welcome {bridge_id, club_id, ping_ms}`, `job {job_id, kind, uuid, request}`, `ack {uuid}` (результат записан — мост его забывает), `ping`. Подробно — `tools/kkt-bridge/README.md`.
- Разработка: `node server/kkt/bin/provision-dev.mjs` (вызывает `scripts/dev.mjs`) — мост «Ресепшн (разработка)» тестового клуба с новым токеном, прежний отзывается; токен — только в файл `KKT_BRIDGE_TOKEN_FILE` (0600); `DATABASE_ADMIN_URL` из окружения или `.env`; ничего не печатает; при `NODE_ENV=production` — отказ.

## Смены (`server/shifts/`)

- Открыть: размен `float_kopecks`; одна открытая смена на клуб (уникальный индекс, иначе `409 shift_open`); журнал `shift.open`; задание `open_shift` мосту, если у клуба есть мост и `clubs.settings.kkt_shift_sync` не `false`.
- Закрыть: только с фактом наличных (`actual_cash_kopecks`, иначе 400). Ожидаемо = размен + наличные платежи клуба (`bl.payments`, `method = cash`, `succeeded`, `confirmed_at` в смене — касса M2 и заявки стола M1) − наличные возвраты (`bl.refunds` `manual`/`succeeded` по наличным платежам). Расхождение = факт − ожидаемо; ≠ 0 — тревога `cash_discrepancy` (критично, уведомляет при каждом закрытии). Минуты сервисного света за смену больше `clubs.settings.service_light_alarm_minutes` (по умолчанию 60) — тревога `service_light_threshold` (№71). Журнал `shift.close`, задание `close_shift`, outbox `shift.closed`, SSE `shift`. Повторное закрытие — `409 shift_closed`.
- Интервал смены — `[opened_at, closed_at]`; следующая смена открывается не раньше `closed_at + 1 мс`. Закрытая смена неизменна (триггер `shifts_guard`), кроме снимка отчёта.

## Отчёт смены (`server/reports/`)

`GET /api/shifts/{id}/report?online=0` (владелец, управляющий; у открытой смены — «на сейчас»): `revenue` (столы — `kind start/extend`, бар — `kind bar` (0410 pos); по способам `cash`, `card_terminal`, `sbp`, `card`; возвраты; заморозки отдельно), `play` (сессии, минуты, часы, загрузка = минуты игры / (столы × длительность смены)), `service_light` (минуты по сотрудникам и столам, порог), `manual_actions` (журнал с причиной, `service.*`, `manual.*`, возвраты, скидка выше лимита), `cash`, `reconciliation.kkt` (наличные и терминал против пробитых чеков ККТ по типу оплаты, возвраты против чеков возврата, платежи без чека, чеки в очереди, с ошибкой, с неизвестным исходом; `ok` — разница 0 и все пробиты), `reconciliation.online` (каждый платёж и возврат ЮKassa смены — `GET /v3/payments/{id}`, `/v3/refunds/{id}` ключами клуба через `loadPaymentSettings`/`clientFor` money: статус и сумма; ЮKassa не ответила — `unavailable`). При закрытии смены снимок пишется в `bl.shifts.report`, текст — владельцам (`notify.sendToClubStaff`, `kind shift.report`, без персональных данных), один раз.

## Маршруты

| Метод и путь | Кто | Суть |
|---|---|---|
| `POST /api/clubs/{club}/kkt/bridges` | владелец | `{name, kkt_model?}` → `201 {bridge, token}` |
| `GET /api/clubs/{club}/kkt/bridges` | владелец, управляющий | мосты (`online`, `last_seen_at`, `last_status`) |
| `POST /api/kkt/bridges/{id}/revoke` | владелец | отзыв; задания в полёте — исход неизвестен |
| `GET /api/clubs/{club}/kkt/status` | ресепшн и выше | то же, что SSE `kkt` |
| `GET /api/clubs/{club}/kkt/receipts?status=open\|pending\|unknown\|failed\|printed` | ресепшн и выше | чеки ККТ |
| `POST /api/kkt/receipts/{id}/retry` | управляющий и выше | `{reason}` — `failed` или исход неизвестен → в очередь с новым UUID |
| `POST /api/kkt/receipts/{id}/mark-printed` | управляющий и выше | `{fd, fp, fn?, reason}` — только исход неизвестен; ручное действие |
| `POST /api/clubs/{club}/shifts` | ресепшн и выше | `{float_kopecks}` → `201` смена |
| `GET /api/clubs/{club}/shifts/current` | ресепшн и выше | `{shift}` или `{shift: null}` |
| `GET /api/clubs/{club}/shifts?limit&before` | управляющий и выше | `{items, next_cursor}` |
| `GET /api/shifts/{id}` | ресепшн и выше | смена |
| `POST /api/shifts/{id}/close` | ресепшн и выше | `{actual_cash_kopecks, comment?}` → смена с `expected_cash_kopecks`, `discrepancy_kopecks` |
| `GET /api/shifts/{id}/report` | владелец, управляющий | отчёт и сверка |

Коды вне словаря §3: `shift_open`, `shift_closed` (409), `receipt_not_failed`, `receipt_not_unknown` (409).

## Таблицы

`0500_kkt.sql`: `bl.receipts` + `kkt_job`, `fd`, `fp`, `fn`, `printed_at`, `error`, `next_attempt_at`, `alarmed_at`, `sale_id`, статус `printed` (проверки `receipts_object_check`, `receipts_printed_check`, `receipts_kkt_fields_check`); `bl.kkt_bridges` (хеш токена, последний онлайн, состояние ККТ, отзыв один раз); `bl.kkt_ops`; `bl.kkt_due(cutoff, limit)` — SECURITY DEFINER, владелец `bl_definer`. `0510_shifts.sql`: `bl.shifts` (одна открытая на клуб, `shifts_guard`). Все — `ENABLE` + `FORCE RLS` по `bl.ctx_club_id()`, владелец `bl_owner`, без `DELETE`, `UPDATE` только изменяемых столбцов.

## Тесты

- `npm test -w @billiardum/server` — `kkt/test/atol-task.test.mjs`: задание АТОЛ, НДС и СНО, копейки, UUID попыток, токен моста.
- `npm run test:db -w @billiardum/server` — `kkt/test/db/`: `kkt.test.mjs` (токен и WebSocket, очередь, T14, обрыв, новая попытка, ошибки, исход неизвестен, чужой клуб, тревога 10 минут, RLS и права), `shifts.test.mjs` (смена, T16, смена ККТ, отчёт, сервисный свет, права), `reconcile.test.mjs` (50 продаж — сверка до копейки, расхождения, ЮKassa недоступна). Обвязка — `kkt/test/db/harness.mjs`: временная база, сервер с модулем kkt, эмулятор АТОЛ, настоящий мост, эмулятор ЮKassa.
