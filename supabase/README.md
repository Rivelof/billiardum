# База «Бильярдума» (`@billiardum/db`)

Postgres из образа `supabase/postgres` (decisions №11). Клиенты в базу не ходят; сервер работает под ролью `app_api`, RLS по клубу действует и на него. Контракт — `docs/contracts/m0.md` §5.

## Команды

| Команда (из корня) | Что делает | Переменные |
|---|---|---|
| `npm run db:migrate` | применяет `migrations/NNNN_name.sql` по порядку, каждую в своей транзакции; учёт в `bl.schema_migrations` (версия, имя, sha256); изменённая после применения миграция — ошибка; задаёт пароль `app_api` | `DATABASE_ADMIN_URL`, `DB_APP_PASSWORD` |
| `npm run db:seed` | `seed.sql`, затем `seed.d/*.sql` по порядку имён (`0100_core`, `0200_money`, `0300_light`) — всё в одной транзакции; повторный запуск ничего не дублирует; при `NODE_ENV=production` отказ | `DATABASE_ADMIN_URL` |
| `npm run db:reset` | снимает защиту журнала, стирает схемы `bl` и `bl_guard`, затем migrate и seed; при `NODE_ENV=production` отказ | `DATABASE_ADMIN_URL`, `DB_APP_PASSWORD` |
| `npm run test:db` | тесты базы на поднятом Postgres (ниже) | `DATABASE_ADMIN_URL`, по желанию `DATABASE_URL` |
| `npm test -w @billiardum/db` | юнит-тесты без базы (SCRAM, учёт миграций) | — |

`DATABASE_ADMIN_URL` — суперпользователь (`supabase_admin`): миграции создают роли и событийные триггеры. Если переменной нет в окружении, инструменты читают `.env` из корня (окружение главнее файла).

Пароль `app_api` уходит в базу готовым хешем SCRAM-SHA-256, посчитанным в Node: открытого пароля нет ни в SQL, ни в логах Postgres, ни в `pg_stat_statements`. Пароль — печатный ASCII без пробелов, 12–256 символов.

## Схема `bl`

Все объекты — в схеме `bl` (decisions №34). Владелец схемы — суперпользователь, который выполняет миграции. У ролей Supabase прав на `bl` нет.

| Таблица | Суть |
|---|---|
| `users` | пользователь платформы (гость и персонал), не привязан к клубу: `phone` (E.164, необязателен до «Поделиться контактом», уникален при наличии), `telegram_user_id`, `max_user_id`, `notify_channel`, `phone_verified_at`, `merged_into` (учётка мессенджера влита в учётку с тем же телефоном) |
| `clubs` | `name`, `city`, `timezone` (IANA, проверяется), `settings jsonb` |
| `club_members` | `club_id`, `user_id`, `role` (`owner`, `manager`, `reception`, `installer`), `pin_hash` (`scrypt$N$r$p$соль$хеш`), `pin_failed_count`, `pin_locked_until`, `pin_set_at`, `active` |
| `resources` | стол: `type` (`billiard_pyramid`, `billiard_pool`, `billiard_snooker`), `number`, `title`, план зала `plan_x`, `plan_y` (центр стола в сантиметрах от левого верхнего угла зала), `plan_rotation` (градусы) |
| `devices` | `id` = device_id = логин MQTT, `resource_id` (уникально), `device_key_enc` (AES-256-GCM в приложении), `last_seq`, `fw`, `caps`, `last_seen_at` |
| `tariff_rules` | `resource_type` или `resource_id`, `days` (ISO 1–7), `start_local`–`end_local` (местное время клуба; конец ≤ начала — через полночь), `price_per_hour` (копейки), `step_minutes`, `min_minutes`, `priority` |
| `audit_log` | журнал, см. ниже |
| `schema_migrations` | учёт миграций (у `app_api` прав нет) |
| `consents` (0100) | согласие на обработку ПДн: `user_id`, `version`, `accepted_at` |
| `staff_terminals` (0100) | терминал ресепшена клуба: sha256 токена, срок, отзыв |
| `auth_tokens` (0100) | токены входа: только sha256, `kind` `session` или `pin` (клуб и терминал), срок, отзыв |
| `bot_link_nonces` (0100) | вход в PWA через бота: sha256 nonce и секрета браузера, `pending → linked → done → consumed`, 10 минут |
| `outbox`, `outbox_done` (0101) | события модулей и отметки подписчиков (контракт M1 §2.2); триггер вставки — `NOTIFY bl_outbox` |
| `idempotency_keys` (0101) | ответы на запросы с `Idempotency-Key`: `(user_id, key, route)`, 24 часа |
| `push_subscriptions` (0102) | подписки Web Push пользователя (`endpoint`, `p256dh`, `auth`) |
| `notifications` (0102) | уведомления: получатель, клуб, текст без ПДн, статус, попытки по каналам |
| `alarms` (0102) | тревоги клуба: тип, уровень, стол, `open`/`acked`, счётчик повторов (одна открытая тревога типа на стол) |

Таблицы денег (0200–0201) описаны в `server/payments/README.md`, сессий и устройств (0300–0330) — в разделе «Сессии и устройства (light)» ниже и в `server/sessions/README.md`. Имя пользователя `users.name` (0105) — для персонала: `GET /api/me`, терминал ресепшена, журнал; задаёт сам пользователь (`PATCH /api/me`).

Ресурс и устройство, тариф и ресурс связаны составными ключами `(club_id, id)`: строка не сошлётся на стол другого клуба.

### Контекст запроса и RLS

В каждой транзакции сервер вызывает (`server/lib/store.mjs`, `withContext`):

```sql
select set_config('app.club_id', $club, true), set_config('app.user_id', $user, true), set_config('app.actor_type', $type, true);
```

`actor_type`: `user`, `system`, `device`, `support`. Пустое значение — контекста нет; неверный UUID — ошибка запроса.
На всех таблицах `ENABLE` и `FORCE ROW LEVEL SECURITY`. Политики `TO app_api`: строка видна и пишется, только если `club_id = app.club_id` (для `clubs` — `id`). Без контекста `app_api` не видит ни одной строки.

Три вида контекста (M1):

- **клуб** — `app.club_id` задан: данные этого клуба;
- **личный** — `app.club_id` пуст, `app.user_id` задан: свои строки пользователя (`users`, свои членства `club_members` и клубы, где он участник, `consents`, `auth_tokens`, `push_subscriptions`, свои `notifications`, `idempotency_keys`). Свои членства и клубы видны **только** в личном контексте: в контексте клуба A строка членства в клубе B не появится даже у её хозяина (забытый `WHERE club_id` не даст роль из чужого клуба);
- **платформа** — `bl.ctx_is_platform()`: `actor_type = system`, клуба и пользователя нет. Так работают обработчик outbox, доставка уведомлений, вебхук бота и вход через бота: `outbox` (все события), `bot_link_nonces`, `push_subscriptions` и `notifications` (для доставки), `idempotency_keys` (уборка просроченных, 0104). Анонимные HTTP-запросы идут с `actor_type = user` и платформой не являются.

### Пользователи платформы и персонал

Пользователь не привязан к клубу. `users`: свою строку видит сам; участников клуба из контекста видит персонал этого клуба (политика M0, нужна для списка сотрудников и журнала); **гостей** персонал не видит вовсе — только через узкие функции с маской телефона (`bl.user_brief` → `+7999***4567`, модули — например, заявки ресепшена). Пользователь меняет у себя только `notify_channel`; телефон, Telegram и MAX пишут только функции входа. Поиск пользователя до входа, привязка телефона и проверка токена — узкие функции ниже, у `app_api` прямого доступа к чужим строкам `users` нет.

Права `app_api`: `SELECT` всех таблиц кроме `schema_migrations`; `INSERT`/`UPDATE` — `club_members`, `resources`, `tariff_rules`; `UPDATE` у `clubs`; у `devices` — `INSERT` и `UPDATE` только столбцов `resource_id`, `serial`, `device_key_enc`, `last_seq`, `fw`, `caps`, `last_seen_at`; журнал — только `SELECT`, `INSERT`. Таблицы core (0100–0102): `INSERT` и `UPDATE` только нужных столбцов (например, у `auth_tokens` — `revoked_at`, `last_used_at`; у `users` — только `notify_channel`). `DELETE` — только `outbox` (обработанные события старше 7 дней, платформа), `bot_link_nonces` и `idempotency_keys` (просроченные); `TRUNCATE` — ни на что.

## Роли

| Роль | Вход | Назначение |
|---|---|---|
| `bl_owner` | нет | владелец таблиц и функций контекста (роль миграций); никому не выдана |
| `bl_audit_owner` | нет | владелец `audit_log` и функций журнала; никому не выдана |
| `bl_definer` | нет | владелец узких функций `SECURITY DEFINER`; видит только столбцы, нужные этим функциям (`devices(id, club_id)`, у core — `users`, `auth_tokens`, `staff_terminals`, `consents`, у light и money — свои) |
| `app_api` | да | рабочая роль сервера: без `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, ничем не владеет; `statement_timeout` 15 с |

Изменения ролей Supabase (роли кластерные):

- `0001` отзывает `pg_read_all_data` и `pg_write_all_data` у всех ролей, кроме суперпользователей: в образе их получают `postgres` и `supabase_read_only_user`, у которых есть `BYPASSRLS`, — иначе они читали бы `bl` целиком в обход RLS.
- `0004` (decisions №39): `postgres`, `authenticator`, `pgbouncer`, `supabase_auth_admin`, `supabase_storage_admin`, `supabase_read_only_user`, `supabase_replication_admin` — `NOLOGIN`, без `CREATEROLE` и без пароля. Входят только суперпользователь (миграции) и `app_api`. Изменение переживает перезапуск контейнера.

Почему так: в образе у `postgres` был пароль `POSTGRES_PASSWORD`, `CREATEROLE` и `BYPASSRLS` — она выдавала себе любую нашу роль и `pg_read_all_data`. Без `CREATEROLE` выдать себе роль она уже не может, но supautils (`supautils.privileged_role = postgres`) выполняет за неё `ALTER ROLE` незарезервированных ролей, например `ALTER ROLE app_api BYPASSRLS`. Поэтому защита держится на том, что в `postgres` нельзя войти и в неё никто не входит (проверяется тестом). Надёжнее добавить `app_api` и `bl_*` в `supautils.reserved_roles` в конфигурации образа (`/etc/postgresql-custom`, том `db-config`) — это за devops.

Встроенный healthcheck образа — `pg_isready -U postgres`: он по-прежнему проходит (`pg_isready` не входит в базу), но пишет в лог Postgres `FATAL: role "postgres" is not permitted to log in`. В Compose и CI он переопределён на `supabase_admin`.

## Узкие функции `SECURITY DEFINER`

У всех `search_path = pg_catalog, pg_temp`, `EXECUTE` только у `app_api`.

| Функция | Владелец | Возвращает | Зачем |
|---|---|---|---|
| `bl.device_club(device_id uuid) → uuid` | `bl_definer` | `club_id` устройства или `NULL` | мост MQTT узнаёт клуб устройства до того, как известен контекст |
| `bl.device_total() → bigint` | `bl_definer` | число устройств во всех клубах | `total` в логе `devices_online` |
| `bl.audit_log_chain()` (триггер) | `bl_audit_owner` | — | читает голову цепочки любого клуба при вставке |
| `bl.auth_resolve(token_hash text)` (0103) | `bl_definer` | действующий токен: `token_id`, `kind` (`session`, `pin`, `terminal`), `user_id`, `club_id`, `terminal_id`, `expires_at`, `has_phone`, `consents` | кто делает запрос; отозванный, истёкший, токен влитой учётки и токен PIN отозванного терминала не возвращаются |
| `bl.auth_user_for(kind text, value text) → uuid` (0103) | `bl_definer` | найденный или созданный пользователь по `phone`, `telegram`, `max` | вход до того, как пользователь известен |
| `bl.auth_attach_phone(phone text) → uuid` (0103) | `bl_definer` | id учётки, которой теперь принадлежит номер | «Поделиться контактом» — только пользователю из `app.user_id`; номер у другой учётки — вливание (`merged_into`, Telegram/MAX и согласия переходят); конфликт — ошибка `BL409` |
| `bl.notify_route(user_id uuid)` (0103) | `bl_definer` | `notify_channel`, `telegram_user_id`, `max_user_id` — без телефона | доставка уведомлений |
| `bl.user_brief(user_id uuid)` (0103) | `bl_definer` | `phone_masked`, `has_phone` | персонал клуба видит гостя только маской; без контекста клуба — только себя |

| `bl.resource_by_code(code text)` (0300, light) | `bl_definer` | `(resource_id, club_id)` активного стола по коду | `/api/t/{code}` до того, как известен клуб |
| `bl.resource_club(resource_id uuid) → uuid` (0300, light) | `bl_definer` | клуб стола или `NULL` | маршруты `/api/resources/{id}/…` до проверки ролей |
| `bl.session_club(session_id uuid) → uuid` (0310, light) | `bl_definer` | клуб сессии или `NULL` | маршруты сессий и `GET /api/stream?session=` до проверки прав |
| `bl.light_open_sessions()` (0310, 0330, light) | `bl_definer` | `(session_id, club_id)` идущих и прерванных (`interrupted`) сессий всех клубов | планировщик восстанавливает таймеры после перезапуска |
| `bl.device_bind_window(device_id uuid, now timestamptz)` (0320, light) | `bl_definer` | `(window_id, club_id)` открытого окна привязки | `POST /api/devices/claim` от контроллера без входа |

`bl_definer` видит только столбцы, нужные этим функциям: у `users`, `auth_tokens`, `staff_terminals`, `consents` (core); `resources(id, club_id, code, active)`, `sessions(id, club_id, status)`, `device_bind_windows(id, club_id, device_id, until, claimed_at, closed_at, created_at)` (light); у денег — свои (`money_object_club`, `money_due`, `server/payments/README.md`). Других функций `SECURITY DEFINER` в `bl` нет: список закреплён тестом `isolation` — новая функция добавляется в него вместе с миграцией.

## Журнал `audit_log`

Поля: `id`, `club_id` (`NULL` — цепочка платформы), `seq`, `created_at`, `actor_type`, `actor_id`, `action`, `object_type`, `object_id`, `reason`, `data jsonb`, `prev_hash`, `hash`.

Приложение делает обычный `INSERT` без `seq`, `created_at`, `prev_hash`, `hash`. Триггер `BEFORE INSERT` (`bl.audit_log_chain`) берёт `pg_advisory_xact_lock` по клубу (отдельно для `club_id IS NULL`), читает голову цепочки и перезаписывает присланные значения: `seq` = следующий номер, `created_at` = `clock_timestamp()`, `prev_hash` = хеш предыдущей записи (у первой — 64 нуля), `hash` — по формуле. `actor_type` и `actor_id` по умолчанию берутся из `app.actor_type`, `app.user_id`. Уникальность `(club_id, seq)` с `NULLS NOT DISTINCT` страхует от развилки цепочки.

`app_api` пишет в цепочку клуба из контекста; в цепочку платформы — только без контекста клуба и от `system`/`support`. Строку платформы `app_api` не видит, поэтому `INSERT … RETURNING` для неё не работает.

### Формула хеша

```
hash = hex(sha256(utf8(prev_hash || canonical)))
canonical = jsonb_build_array('bl.audit.v1', id, club_id, seq, created_at_us,
                              actor_type, actor_id, action, object_type, object_id,
                              reason, data)::text
```

- `sha256` — встроенная функция `pg_catalog` (pgcrypto не нужен: его схема `extensions` принадлежит `postgres`);
- `created_at_us` — `created_at` в микросекундах Unix (`bigint`), без часовых поясов;
- `canonical` — текст jsonb-массива в выводе Postgres: элементы через `", "`, uuid строкой в нижнем регистре, `NULL` → `null`, `data` — как `data::text` (ключи jsonb упорядочены по длине, затем по байтам, разделители `", "` и `": "`);
- пример: `["bl.audit.v1", "<id>", "c1000000-…", 1, 1792598400123456, "system", null, "device.cmd", "device", "d1000000-…", null, {"seq": 1, "type": "ping", "cmd_id": "<uuid>"}]`.

Внешняя проверка берёт `data::text` и `extract(epoch from created_at) * 1000000` из базы; тест `audit_chain.test.mjs` пересчитывает хеш в Node.

### `bl.audit_verify(club uuid)`

Возвращает `ok`, `first_bad_seq` (номер первой испорченной записи; для удалённой — недостающий номер), `checked`, `head_seq`, `head_hash` (голова целой цепочки; уходит владельцу в утренней сводке и выдаёт перезапись хвоста). `NULL` — цепочка платформы. Вызывается с правами вызывающего: `app_api` проверяет только клуб из контекста, для другого клуба — ошибка.

### Запреты

- Триггеры `BEFORE UPDATE OR DELETE` (на строку и на оператор) и `BEFORE TRUNCATE` всегда дают ошибку `bl.audit_log is append-only`. Все триггеры журнала включены как `ENABLE ALWAYS`: `session_replication_role = replica` их не отключает.
- Событийные триггеры `bl_audit_guard_ddl` (`ddl_command_end`) и `bl_audit_guard_drop` (`sql_drop`), `ENABLE ALWAYS`, владелец — суперпользователь, функции — в отдельной схеме `bl_guard` (без прав у кого-либо, чтобы `DROP SCHEMA bl CASCADE` не удалил защиту вместе с журналом). Они отменяют любую DDL над журналом: `ALTER TABLE` (в том числе `DISABLE TRIGGER`, `NO FORCE ROW LEVEL SECURITY`, `OWNER TO`), `DROP` таблицы, схемы, триггеров, политик, ограничений, `CREATE TRIGGER`, `CREATE RULE`, `CREATE POLICY`, замену и переименование функций журнала. DDL других таблиц и ролей не затрагивается.
- Обойти защиту может только суперпользователь (`ALTER EVENT TRIGGER … DISABLE`, правка каталога). Такую подмену выдают `audit_verify` и голова цепочки у владельца (decisions №13).

### Как изменить журнал будущей миграцией

Только явно, в той же транзакции миграции:

```sql
alter event trigger bl_audit_guard_ddl disable;
alter event trigger bl_audit_guard_drop disable;
-- изменения bl.audit_log
alter event trigger bl_audit_guard_ddl enable always;
alter event trigger bl_audit_guard_drop enable always;
```

Восстановление из `pg_dump` целиком работает (данные грузятся до создания триггеров). Загрузка только данных с `--disable-triggers` требует так же снять защиту.

## Сид (`seed.sql`, decisions №17)

«Тестовый клуб», Екатеринбург, `Asia/Yekaterinburg`; владелец `+70000000001`; 8 столов (1–5 пирамида, 6–8 пул) на плане 18 × 14 м; тарифы PRODUCT §9 в копейках для обоих типов (50 000 / 80 000 / 90 000 пн–чт, 60 000 / 100 000 / 110 000 пт–вс; 17:00–00:00 хранится как `end_local = 00:00`); 8 устройств без ключей. Фиксированные UUID: клуб `c1000000-0000-4000-8000-000000000001`, пользователь `a1…01`, столы `e1…01`–`e1…08`, устройства `d1000000-0000-4000-8000-00000000000N` (N — номер стола), тарифы `f1…01`–`f1…12`. Ключи и пароли MQTT задаёт `npm run provision:dev`.

### Сид модулей (`seed.d/`)

`0100_core.sql` — персонал тестового клуба: управляющий `+70000000003` (`a1…03`, `b1…03`) и ресепшн `+70000000004` (`a1…04`, `b1…04`); `+70000000002` занят вторым клубом тестов изоляции. PIN задаёт `npm run provision:dev` (`DEV_STAFF_PIN`, по умолчанию `1234`): хеш зависит от `SECRETS_ENC_KEY`. Вход — `POST /api/auth/dev` или через бота. `0200_money.sql`, `0300_light.sql` — модулей money и light.

## Сессии и устройства (light)

Миграции `0300`–`0330` (backend-light, контракт M1 §6, §13). Все таблицы с `club_id`: `ENABLE` + `FORCE ROW LEVEL SECURITY`, политики `app_api` по `bl.ctx_club_id()`.

| Таблица, столбец | Суть |
|---|---|
| `resources.code` (0300) | код стола для QR: 10 символов Crockford Base32 (50 бит, decisions №47), глобально уникален, по умолчанию `bl.gen_resource_code()`; в сиде — `TEST000001`…`TEST000008` |
| `sessions` (0310) | сессия стола: `active → ending → grace → closed`, `interrupted`, `cancelled`; `payer_user_id`, `started_at`, `paid_until` (единственный источник оплаченного времени), `device_paid_until`, `unplayed_ms`, `warn_ms`, `grace_ms`, `notified`; одна идущая сессия на стол (частичный уникальный индекс) |
| `session_participants` (0310) | участники: `payer` или `player`, порядковый номер «Игрок N» |
| `session_payments` (0310) | связь платежа и сессии, обработка `payment.confirmed` один раз по `payment_id`; `outcome` `applied` или `refunded` |
| `resource_holds` (0310) | удержание стола: `pending` (3 минуты за гостем), `reserved`, `service` (с причиной) |
| `device_commands` (0320) | команды контроллеру: `seq`, тип, тело, статус, попытки, причина (`payment`, `guest`, `staff`, …) |
| `device_events` (0320) | события контроллера, один раз по `(device_id, boot, n)` |
| `device_bind_windows` (0320) | окно привязки контроллера к столу на 30 минут: хеш кода с наклейки (decisions №67), 5 неверных попыток закрывают окно |

Гость дополнительно видит свои сессии и своё участие в любом клубе (`session_participants.user_id = app.user_id`) — для `GET /api/sessions/current`. Срок выбора после `interrupted` — 24 часа (0330, decisions №65). Внешние ключи на платежи — `0390_money_fks.sql`.

## Деньги

Таблицы `0200_money.sql`, `0201_holidays.sql` (платежи, котировки, заявки ресепшена, чеки, возвраты, настройки ЮKassa клуба, праздники), их RLS и узкие функции — `server/payments/README.md`. Тесты — `tests/money_rls.test.mjs`, `tests/money_flow.test.mjs`.

## Тесты базы (`tests/`)

Каждый файл создаёт свою временную базу `bl_test_*` из `template1`, применяет миграции и сид и удаляет её в конце: журнал нельзя очистить, поэтому тесты не пишут в рабочую базу. Пароль `app_api` тесты не меняют — действуют через `SET ROLE app_api` (те же права и RLS); если задан `DATABASE_URL`, дополнительно проверяется вход `app_api` по паролю. Файлы идут по одному (`--test-concurrency=1`), 50 параллельных соединений — нужен `max_connections` ≥ 70.

- `audit_immutable` — `UPDATE`, `DELETE`, `TRUNCATE` падают у суперпользователя (и в режиме `replica`), у владельца журнала и у каждой роли кластера (`SET ROLE`), включая `bl_owner`, `app_api`, `anon`, `authenticated`, `service_role`, `authenticator`, `postgres`, `supabase_read_only_user`; DDL над журналом запрещена; `postgres` не может выдать себе наши роли и `pg_read_all_data`, у неё нет входа и членов.
- `audit_chain` — триггер перезаписывает присланные поля; хеш воспроизводится по формуле; 50 параллельных вставок дают `seq` 1…50 без пропусков и `ok`; цепочки клубов и платформы независимы; подмена данных, удаление записи и перезапись записи вместе с её хешем в обход всех защит находятся `audit_verify`.
- `isolation` — с контекстом клуба A не видно строк клуба B ни в одной таблице, вставка и перенос строки в клуб B падают на RLS; без контекста — ноль строк; функции `SECURITY DEFINER` — только перечисленные.
- `roles` — у ролей Supabase нет прав на `bl`, роли с `BYPASSRLS` и роли `authenticator` получают `permission denied` на каждую таблицу; членов у `pg_read_all_data` нет; права на объекты только у наших ролей; атрибуты ролей; служебные роли Supabase без входа и без `CREATEROLE`, вход под каждой с `POSTGRES_PASSWORD` (или паролем из `DATABASE_ADMIN_URL`) отвергается, входить могут только суперпользователи и `app_api`.
- `main_db` — только чтение и откатываемые попытки на рабочей базе из `DATABASE_ADMIN_URL` (если она уже мигрирована): все миграции применены, журнал неизменяем, роли Supabase не читают `bl`, цепочки целы.
- `core_rls` (M1 core) — RLS включена и принудительна на всех таблицах core; пользователь видит свою строку, персонал не видит гостей; свои членства — только в личном контексте; токены, согласия, ключи идемпотентности, подписки — только свои; nonce — только платформе; outbox, уведомления, тревоги — по клубу; `auth_resolve` не отдаёт истёкший и отозванный токен и токен отозванного терминала; слияние учёток и `BL409`; маска телефона; `DELETE` у `app_api` только у `outbox`, `bot_link_nonces`, `idempotency_keys`.
- Тесты сервера с базой — `npm run test:db -w @billiardum/server` (`server/test/db`), та же схема временных баз.
