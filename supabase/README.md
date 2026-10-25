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
| `users` | пользователь платформы (гость и персонал), не привязан к клубу: `phone` (E.164, необязателен до «Поделиться контактом», уникален при наличии), `telegram_user_id`, `max_user_id`, `notify_channel`, `phone_verified_at`, `merged_into` (учётка мессенджера влита в учётку с тем же телефоном); `name` (0105), `channels_order` (0700) — порядок каналов уведомлений |
| `clubs` | `name`, `city`, `timezone` (IANA, проверяется), `settings jsonb` |
| `club_members` | `club_id`, `user_id`, `role` (`owner`, `manager`, `reception`, `installer`, `bar` — с 0107, №97), `pin_hash` (`scrypt$N$r$p$соль$хеш`), `pin_failed_count`, `pin_locked_until`, `pin_set_at`, `active` |
| `resources` | ресурс (стол или корт): `type` (`billiard_pyramid`, `billiard_pool`, `billiard_snooker`, `billiard_mixed` — 1050, `padel_court` — 1300), `number` (уникален в клубе внутри семьи вида `bl.resource_family(type)`: столы и корты нумеруются отдельно, 1300), `title`, план зала `plan_x`, `plan_y` (центр стола в сантиметрах от левого верхнего угла зала), `plan_rotation` (градусы) |
| `devices` | `id` = device_id = логин MQTT, `resource_id` (уникально), `device_key_enc` (AES-256-GCM в приложении), `last_seq`, `fw`, `caps`, `last_seen_at` |
| `tariff_rules` | `resource_type` или `resource_id`, `days` (ISO 1–7), `start_local`–`end_local` (местное время клуба; конец ≤ начала — через полночь), `price_per_hour` (копейки, строго > 0 — 1054, №163), `step_minutes`, `min_minutes`, `priority`; правило слота (1300, M5.8) — `slot_minutes` (60, 90, 120) и `price_per_slot` (> 0), шаг и минимум равны слоту; у `padel_court` — только правила слота |
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
| `staff_invites` (0702) | приглашения персонала: телефон, роль, 7 дней, кем, принято кем и когда, отзыв; одно открытое на номер в клубе |
| `club_summaries` (0701) | отправленные сводки клуба (утренняя): рабочие сутки, данные, время отправки; одна на сутки |
| `alarms` (0102, 0106) | тревоги клуба: тип, уровень, стол, `open`/`acked`, счётчик повторов (одна открытая тревога типа на стол), `last_notified_at` — повторное уведомление о критичной не раньше чем через 10 минут (№75) |

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
| `bl.booking_due(now, lead, stale, limit)` (0600, booking) | `bl_definer` | `(kind, id, club_id)`: брони (`booking`) — неоплаченные после `pay_until`, подтверждённые и удержанные ближе `lead` к началу, идущие после конца; лист ожидания (`waitlist`) — просроченные предложения и записи старше `stale` | планировщик брони: напоминания, `state.reserved`, сгорание, следующий в очереди |
| `bl.ctx_platform_role()` (0710) | `bl_definer` | роль платформы из `app.platform_role`, если пользователь из контекста — активный участник платформы с этой ролью и клуба в контексте нет; иначе NULL | политики модулей M4 для операторов и Андрея (№134) |
| `bl.platform_recipients(role)` (0710) | `bl_definer` | получатели уведомлений платформы: операторы (нет активных — администраторы) или администраторы | `sendPlatform` |
| `bl.public_clubs()` (0703) | `bl_definer` | `(id, name, city, address, timezone, plan)` активных клубов, без персональных данных | `GET /api/clubs` без входа (№120) |

Миграции core после ревью M3: 0704 — код подтверждения входа через бота (`bot_link_nonces.code_hash`, `code_attempts`, `confirmed_at`, статус `failed`; `done` только с `confirmed_at`); 0705 — очередь уведомлений (`notifications.status` `sending`, `claimed_at`, индекс очереди); 0706 — `staff_revoke` гасит PIN-токены клуба и личные только без других членств, `summary_clubs()` только активных клубов, счётчик неверных PIN терминала (`staff_terminals.pin_failed_count`, `pin_window_started_at`, `locked_at`). 0710 — `platform_members` (роли платформы, №134; своя строка — в личном контексте, все — платформе; писать `app_api` не может), журнал платформы от сотрудника — `actor_type support` по политике M0 (журнал не менялся). 0707 — `bl.is_valid_timezone`: UTC или IANA Область/Место (MSK, posix/…, right/… отклоняются; существующие строки не перепроверяются).
| `bl.summary_clubs()` (0701) | `bl_definer` | `(club_id, timezone, day_start_local, summary_time_local)` всех клубов | планировщик сводок в контексте платформы |
| `bl.staff_accept_invites()` (0702) | `bl_definer` | `(invite_id, club_id, role)` привязанных | при входе: действующие приглашения на номер пользователя из `app.user_id` |
| `bl.staff_revoke(user_id uuid) → integer` (0702) | `bl_definer` | число отозванных токенов; не участник клуба — `NULL` | отзыв доступа в клубе из `app.club_id`: членство, PIN, все токены; владельца — ошибка |
| `bl.user_brief(user_id uuid)` (0103) | `bl_definer` | `phone_masked`, `has_phone` | персонал клуба видит гостя только маской; без контекста клуба — только себя |
| `bl.club_mode(club uuid) → text` (1000, M5.1) | `bl_definer` | режим клуба `test`, `live`, `suspended` или `NULL` | `app.club_mode` в контексте запроса, публичные страницы; данных клуба не отдаёт |
| `bl.create_club(name, city_name, city_id, timezone, listing_id) → uuid` (1000) | `bl_definer` | id клуба | вошедший пользователь в личном контексте создаёт клуб в `test` и становится владельцем; не больше 3 тестовых клубов (`BLC01`); карточка — только из своей одобренной заявки (`BLC02`); без телефона — `BLC04` |
| `bl.club_go_live(club uuid, offer_version text) → timestamptz` (1000) | `bl_definer` | время перехода | владелец клуба из контекста: `test → live` (повтор — без изменений; приостановлен — `BLC03`) |
| `bl.club_suspend(club, reason)`, `bl.club_resume(club, mode)` (1000) | `bl_definer` | прежний / новый режим | только `platform_admin` (`bl.ctx_platform_role()`): приостановка и возобновление в `test` или `live` |
| `bl.set_is_test()` (1001, триггер) | `bl_definer` | — | `is_test` новой записи по режиму клуба или по родителю |
| `bl.onboarding_due(now, limit)` (1002) | `bl_definer` | `(club_id, kind, id)`: проверочные платежи к сверке и возврату, тревоги «вебхук не настроен» | планировщик `server/clubs` |

| `bl.resource_by_code(code text)` (0300, light) | `bl_definer` | `(resource_id, club_id)` активного стола по коду | `/api/t/{code}` до того, как известен клуб |
| `bl.resource_club(resource_id uuid) → uuid` (0300, light) | `bl_definer` | клуб стола или `NULL` | маршруты `/api/resources/{id}/…` до проверки ролей |
| `bl.session_club(session_id uuid) → uuid` (0310, light) | `bl_definer` | клуб сессии или `NULL` | маршруты сессий и `GET /api/stream?session=` до проверки прав |
| `bl.light_open_sessions()` (0310, 0330, light) | `bl_definer` | `(session_id, club_id)` идущих и прерванных (`interrupted`) сессий всех клубов | планировщик восстанавливает таймеры после перезапуска |
| `bl.device_bind_window(device_id uuid, now timestamptz)` (0320, light) | `bl_definer` | `(window_id, club_id)` открытого окна привязки | `POST /api/devices/claim` от контроллера без входа |

| `bl.pos_object_club(kind text, id uuid) → uuid` (0420, pos) | `bl_definer` | клуб заказа бара (`order`) или продажи кассы (`sale`) | маршруты заказов и продаж по id до проверки ролей |
| `bl.pos_due(limit integer)` (0420, pos) | `bl_definer` | `(club_id, sale_id)` продаж в `pending`, у которых платёж уже `succeeded` или `canceled` | планировщик кассы завершает или отменяет продажу |
| `bl.kkt_due(cutoff timestamptz, limit integer)` (0500, kkt) | `bl_definer` | `(club_id, receipt_id)` чеков ККТ в `receipt_pending` дольше порога без тревоги | тревога «чек не пробит больше 10 минут» |

`bl_definer` видит только столбцы, нужные этим функциям: у `users` (в том числе `channels_order`, 0700), `auth_tokens` (отзыв), `staff_terminals`, `consents`, `clubs(id, timezone, settings)`, `club_members` и `staff_invites` (персонал, 0702) (core); `resources(id, club_id, code, active)`, `sessions(id, club_id, status)`, `device_bind_windows(id, club_id, device_id, until, claimed_at, closed_at, created_at)` (light); `payments(id, club_id, status, provider, created_at, checked_at)` (money: `money_object_club`, `money_due`, `server/payments/README.md`); `orders(id, club_id)`, `pos_sales(id, club_id, status, payment_id, created_at)` (pos, `server/orders/README.md`); `bookings(id, club_id, status, starts_at, ends_at, pay_until)`, `waitlist(id, club_id, status, offer_until, created_at)` (booking); `tariff_packages(id, club_id, active)` (money, `money_object_club` с видом `package`); `receipts(id, club_id, channel, status, created_at, alarmed_at)` (kkt, `server/kkt/README.md`). Других функций `SECURITY DEFINER` в `bl` нет: список закреплён тестом `isolation` — новая функция добавляется в него вместе с миграцией.

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

## Настройки платформы (`bl.platform_settings`)

Таблица `0400_pos_catalog.sql` (создал backend-pos, владелец настроек платформы — backend-core): `key` → `value jsonb`, без клуба. RLS включена и принудительна; у `app_api` только `SELECT` (политика `using (true)`: настройки одинаковы для всех клубов, данных клубов и гостей в них нет). Меняет только суперпользователь, например `update bl.platform_settings set value = 'true', updated_at = now() where key = 'qr_alcohol_allowed';` — алкоголь в QR-меню включает Андрей после заключения юриста (decisions №76). Сейчас ключ один: `qr_alcohol_allowed` (по умолчанию `false`).

## Касса, бар, смены, ККТ (M2)

Миграции `0400`–`0430` (backend-pos: каталог, платежи бара, заказы, продажи кассы, склад) — `server/orders/README.md`; `0500`–`0510` (backend-kkt: очередь чеков ККТ, мосты, смены) — `server/kkt/README.md`. Узкие функции — в таблице выше.

## Бронь, пакеты, депозит, уведомления и персонал (M3)

Контракт `docs/contracts/m3.md`, решения №104–112. Все таблицы с `club_id`: `ENABLE` + `FORCE ROW LEVEL SECURITY`, политики `app_api` по `bl.ctx_club_id()`.

| Миграция | Таблица, поле | Суть |
|---|---|---|
| `0600` (booking) | `bookings` | бронь стола: `starts_at`–`ends_at` (`period tstzrange`), статусы `pending_payment → confirmed → reserved → started → completed`, `expired` (`unpaid`, `no_show`), `canceled`; источник (`app`, `site`, `phone`, `staff`), имя и телефон для брони по телефону, предоплата (`none`, `deposit`, `full`, сумма, `prepayment_id` — мягкая ссылка на платёж), `hold_minutes`, `forfeit_percent`. Пересечения живых броней стола запрещены `exclude using gist (resource_id with =, period with &&)` (№105, расширение `btree_gist` в схеме `extensions`). Гость видит свои брони в личном контексте |
| `0600` (booking) | `waitlist` | лист ожидания стола: `waiting → offered` (предложение на 5 минут, `offer_until`) `→ accepted` или `expired`, `canceled`; одна живая запись гостя на стол; гость видит свои записи |
| `0650` (money) | `payments` | `kind` += `booking` (предоплата брони), `package` (покупка пакета); `provider`/`method` += `balance` (игра балансом минут); `booking_id`, `package_id`, `balance_minutes`, `deposit` (депозит наличными для «Без лимита»), `settlement_status` (`open → settled | forfeited`), `settled_kopecks`, `settled_at`; у `quotes` — `balance_minutes` |
| `0650` (money) | `receipts` | `settles_payment_id` и `settlement_kopecks` — чек зачёта предоплаты; `provider_receipt_id` — чек ЮKassa `/v3/receipts` (уникален) |
| `0650` (money) | `club_payment_settings.booking_forfeit_percent` | сколько процентов предоплаты удержать при сгорании брони (по умолчанию 100, №108) |
| `0650` (money) | `tariff_packages` | пакеты часов клуба «N часов за X ₽ на M дней»; не меняются — новый пакет новой строкой |
| `0650` (money) | `balance_lots` | минуты гостя по покупкам пакетов: всего, осталось, цена, срок; `source_key` уникален (покупка зачисляется один раз) |
| `0650` (money) | `balance_debits` | списания минут на игру: лот, платёж, минуты, стоимость для чека зачёта, `restored_at` — возврат минут |
| `0700` (core) | `users.channels_order`, `notifications.actions` | порядок каналов уведомлений гостя; действия уведомления `[{id, title, url}]` (№110) |
| `0701` (core) | `club_summaries` | отправленные утренние сводки (см. выше) |
| `0702` (core) | `staff_invites` | приглашения персонала (см. выше) |
| `0750` (light) | `sessions.booking_id`, `sessions.deposit_kopecks` | сессия по брони (одна бронь — не больше одной сессии) и по депозиту наличными; `device_commands.queue_no` — порядок очереди команд |

Подробности — `server/payments/README.md` (деньги) и README модулей брони и сессий.

## Каталог клубов, заявки, отзывы (M4 directory, 0800)

Миграция 0800 (backend-directory, решения №132–135, №139). Доступ: публичное — политиками select (видимые карточки, опубликованные отзывы); клуб — по `bl.ctx_club_id()`; оператор и Андрей — `bl.ctx_platform_staff()` (= `bl.ctx_platform_role()` из 0710 или фон платформы `bl.ctx_is_platform()`).

| Таблица | Что хранит |
|---|---|
| `platform_members` (0710, core) | роли платформы: `platform_operator`, `platform_admin` (Андрей); своя строка — в личном контексте |
| `cities` | справочник городов платформы: слаг (транслит, уникален), название, регион, пояс, `active` |
| `club_public` | карточка клуба в агрегаторе: `listed` / `claimed` / `platform` (у `platform` есть `club_id`), город и слаг (уникален в городе), адрес, координаты, часы, телефон и ссылки клуба, дисциплины, число столов, цена от, описание, `visible`; `contact_user_id` (кому уходят заявки) наружу не отдаётся; правки — триггер `club_public_guard` |
| `club_requests` | заявка гостя в клуб без программы (T25): карточка, гость, телефон гостя для перезвона, время, минуты, люди, комментарий; `sent → accepted / declined / operator → closed`; ответ по одноразовой ссылке (sha256 токена), `escalate_at` — через 15 минут оператору |
| `directory_claims` | «Подтвердить клуб» (`claim`, карточка обязательна) и «Добавить клуб» (`add`, данные в `payload`) → оператору: `new → approved / rejected`, причина; одна открытая заявка на карточку и пользователя |
| `leads` | заявки клубов на программу (`/dlya-klubov/`): имя, клуб, город, телефон, столы, версия согласия, IP только хешем; воронка `new → contacted → demo → won / lost / spam` |
| `reviews` | отзывы: карточка, клуб, автор, оценка 1–5, текст до 1 000, `published / hidden`, ответ клуба; один на гостя и клуб; оценку и текст меняет только автор, ответ — только клуб, скрывает — платформа (триггер `reviews_guard`) |
| `review_reports` | жалобы на отзывы → оператору: `new → hidden / kept`, решение с причиной; одна открытая на отзыв и автора жалобы |

## Подключение клуба без выезда (M5.1 backend-A, 1000–1003)

Контракт `docs/contracts/m5-1.md`, решения №152–154, №160; модуль — `server/clubs/README.md`.

| Миграция | Таблица, поле | Суть |
|---|---|---|
| `1000` | `clubs.mode` (`test`, `live`, `suspended`; по умолчанию `live` — клубы администратора базы и клубы до M5.1), `mode_before_suspend`, `created_by`, `city_id`, `listing_id` (уникален), `went_live_at`, `offer_version`, `offer_accepted_at`, `offer_accepted_by`, `suspended_at`, `suspended_reason` | режим клуба; меняют только узкие функции. У `app_api` `UPDATE` на `clubs` сужен до `name`, `city`, `timezone`, `settings`, `address`. `bl.public_clubs()` — только `live` |
| `1001` | `is_test` у `sessions`, `payments`, `refunds`, `receipts`, `orders`, `pos_sales`, `shifts`, `bookings`, `matches`, `tournaments`, `tournament_entries` | тестовая запись: ставит триггер `bl.set_is_test` при вставке (по режиму клуба; возвраты и чеки — по платежу, записи турнира — по турниру, партии — по турниру или сессии); изменить нельзя (`bl.is_test_guard`). Чек `is_test` может быть `printed` без ФД и не может иметь ФД, ФП, ФН |
| `1002` | `club_payment_settings.test_shop_id`, `test_secret_key_enc`, `{test,live}_verified_at`, `{test,live}_me` | тестовая пара магазина ЮKassa (боевая — прежние `shop_id`, `secret_key_enc`) и последняя проверка `GET /v3/me` |
| `1002` | `payments.webhook_at`, `webhook_alarm_at` | пришёл ли вебхук по платежу; тревога «вебхук не настроен» поднята |
| `1003` | `kkt_ops.is_test` | задание смены ККТ тестового режима (по `shifts.is_test`, без смены — по режиму клуба; триггер `bl.set_is_test`): открытие не создаётся, закрытие — нефискальный «ТЕСТ». `bl_definer` видит `shifts(id, is_test)` |
| `1002` | `shop_checks` | проверочный платёж 1 ₽ магазина клуба: пара, статус, подтверждение (вебхук или сверка), возврат, вебхук, тревога; RLS по клубу |

`bl_definer` дополнительно видит: `clubs(mode, mode_before_suspend, created_by, city_id, listing_id, went_live_at)` и вставляет и меняет столбцы режима, `directory_claims(id, kind, card_id, user_id, status)`, `club_public(id, club_id, status, city_id)`, `cities(id, name, timezone, active)`, `club_payment_settings(club_id)` (вставка строки нового клуба), `is_test` платежей, возвратов, сессий и турниров, поля вебхука платежей и `shop_checks`. Тесты — `server/clubs/test/db`.

## Дашборд и касса управляющего (M5.2, 1100–1102)

Контракт `docs/contracts/m5-2.md`, решения №166–179; формулы — `server/dashboard/README.md`.

| Миграция | Таблица, функция | Суть |
|---|---|---|
| `1100` | `stats_daily`, `stats_hourly` | агрегаты закрытых рабочих суток клуба (итоги и структура суток в `data`) и минуты по столу и местному часу; `app_api` только читает (RLS по клубу), пишет только `bl.stats_put_day` |
| `1100` | `stats_dirty` | закрытые сутки к пересчёту: отметки ставит триггер `stats_dirty_mark` на `payments`, `refunds`, `sessions`, `resource_holds`, `bookings`, `alarms` (функция `bl.stats_mark_dirty`), счётчик `gen` |
| `1100` | `bl.stats_day_of(ts, tz, day_start)` | рабочие сутки момента (не definer) |
| `1100` | индексы | `payments (club_id, confirmed_at)`, `refunds (club_id, created_at)`, `sessions (club_id, started_at)`, `resource_holds (club_id, created_at) where service`, `alarms (club_id, raised_at)`, `device_commands (club_id, created_at)` |
| `1101` | `cashbook_categories`, `cashbook_entries` | касса управляющего: статьи клуба; записи книги только добавляются (триггер `bl.cashbook_append_only` на UPDATE, DELETE, TRUNCATE всем ролям, `ENABLE ALWAYS`), сторно — новой записью (`reverses_id` уникален, сумма — минус исходной, причина обязательна, проверка `bl.cashbook_storno_check`); инкассация — одна на смену (уникальный `shift_id`); `is_test` — `bl.set_is_test` |

Узкие функции (`bl_definer`, `search_path = pg_catalog, pg_temp`, `EXECUTE` у `app_api`; `bl_definer` получил `EXECUTE` на `ctx_club_id`, `ctx_user_id`, `ctx_actor_type` и `SELECT (created_at, active)` у `clubs`):

| Функция | Возвращает | Зачем |
|---|---|---|
| `bl.stats_clubs()` (1100) | `(club_id, timezone, day_start_local, created_at)` активных клубов | планировщик дашборда в контексте платформы |
| `bl.stats_put_day(day, gen, version, daily, hourly)` (1100) | — | записать сутки клуба из контекста; только `actor_type = system`; снимает отметку «грязных», если `gen` не вырос |
| `bl.stats_mark_dirty()` (1100, триггер) | — | отметить закрытые сутки клуба к пересчёту в любом контексте записи; ошибка — предупреждение, запись денег идёт |
| `bl.guest_phone(session_id, user_id)` (1102) | телефон участника игры или `NULL` | «Кто играл за столом» (№179): только участник игры клуба из контекста и только активному владельцу этого клуба; плательщика сервер берёт сам под RLS (столбца `sessions.payer_user_id` владелец функций не видит) |

## Подписка клубов (M5.3 backend-billing, 1150)

Деньги платформы — отдельно от денег гостей: свои таблицы, свой магазин ЮKassa (ключи только в `.env`), свой вебхук. Подробно — `server/billing/README.md`.

| Таблица | Суть | `app_api` |
|---|---|---|
| `billing_settings` | `released_at` — выкатка M5.3: начало пробного периода клубов, работавших в `live` раньше (№181) | чтение |
| `billing_plans` | тарифы платформы (№180), старт — «Клуб» 79 000 коп. за стол в месяц, 60 дней пробного периода | чтение; изменение — только `platform_admin` |
| `club_subscriptions` | подписка клуба: план, персональная цена с причиной, пробный период, день счёта, `paid_until`, автоплатёж, способ оплаты (зашифрован в приложении), маска карты, email для чека | чтение — свой клуб и платформа; служебные поля — только контекст платформы; цены, пробного периода и `paid_until` в правах нет |
| `billing_invoices` | счёт за месяц вперёд: столы × цена, `open`/`paid`, способ оплаты (`card`, `manual`, `free`), попытки | чтение — свой клуб и платформа; запись — только контекст платформы; «оплачен» — только `bl.billing_settle_invoice` |
| `billing_payments` | платежи в магазин платформы: привязка карты и оплата счёта; `provider_payment_id` и `idempotence_key` уникальны | чтение — свой клуб и платформа; владелец создаёт только `pending`; итог — только контекст платформы |

| Функция | Возвращает | Кто и зачем |
|---|---|---|
| `bl.billing_ensure_subscription(club)` (1150) | `true`, если создана | подписка с пробным периодом клубу в боевом режиме; свой клуб, платформа, фоновые задачи |
| `bl.billing_settle_invoice(invoice, via, payment, reason, document, now)` (1150) | `true` — оплачен сейчас, `false` — уже был | `card`/`free` — только `bl.ctx_is_platform()` (платёж сверен с суммой счёта); `manual` — `platform_admin` с причиной и номером платёжки; продлевает `paid_until` |
| `bl.billing_set_price(club, price, reason, now)` (1150) | прежняя персональная цена | только `platform_admin`, с причиной; `NULL` — цена плана |
| `bl.billing_disable_autopay(club, now)` (1150) | была ли карта | владелец клуба из контекста: автоплатёж выключен, способ оплаты забыт |
| `bl.billing_resume(club, now)` (1150) | `{kind: 'shift' \| 'restart', from, to}` или `NULL` | только фоновые задачи (№188): после приостановки срок сдвигается на её длительность; если он кончился до приостановки — `paid_until` = дата возобновления, долг остаётся |
| `bl.billing_clubs()` (1150) | клубы для подписки: название, город, пояс, режим, `suspended_at`, столы в работе | платформа и фоновые задачи |

Узкие функции читают контекст через `bl.billing_ctx()` (без SECURITY DEFINER, владелец `bl_definer`): у `bl_definer` нет права на `bl.ctx_*`.

## Сети клубов (M5.5, 1350–1352)

Подробно — `server/networks/README.md`, решения №190–194. Все таблицы — ENABLE и FORCE RLS, владелец `bl_owner`; кто видит — через `bl.network_access(network)`: `owner` / `manager` в личном контексте (`app.club_id` пуст), `club` — в контексте клуба этой сети, иначе `NULL` (без контекста — ничего).

| Таблица | Суть | `app_api` |
|---|---|---|
| `networks` | сеть владельца: название, режим шаблонов `tariffs_mode`/`menu_mode` (`hard`/`soft`), версии шаблонов, архив | чтение — владелец, управляющие, клубы сети; изменение названия, режимов и версий — владелец; создание и архив — узкие функции |
| `network_clubs` | клубы сети (история; активная строка — клуб в сети, уникальна по клубу — не больше одной сети), переопределение тарифов, применённые версии | чтение — своя строка клуба (контекст клуба), клубы сети — владелец и управляющие; клуб отмечает переопределение и версии; состав — только узкие функции |
| `network_members` | управляющие сети: телефон, привязка при входе, отзыв | чтение — владелец сети, пользователь — свои строки; клубу не видно; запись — только узкие функции |
| `network_tariff_rules` | шаблон тарифов: правило мастера (`rule jsonb`; у корта — слот, 1351), `price_per_hour` — цена правила (часа или слота), > 0 (№163) | чтение — сеть видна; запись — владелец в личном контексте |
| `network_products` | шаблон меню: товар, цена в копейках (≥ 1), алкоголь, НДС, предмет расчёта | так же |

Столбцы в старых таблицах: `club_members.network_id` — членство выдано сетью (управляющий сети, `role = 'manager'`); `app_api` не вставляет и не меняет такие строки и сам `network_id` (триггер `club_members_network_guard`, код `BLN10`). `products.network_product_id`, `products.network_override` — товар шаблона меню и «переопределён клубом». План `billing_plans.code = 'network'` («Сеть», 119 000 коп., меняет `platform_admin`); триггер `club_subscriptions_network_plan` даёт его новой подписке клуба сети.

| Функция | Кто | Что |
|---|---|---|
| `bl.network_access(network) → text` | политики, сервер | `owner` · `manager` · `club` · `NULL` |
| `bl.network_create(name) → uuid` | вошедший в личном контексте | сеть, не больше 5 (`BLN05`) |
| `bl.network_add_club(network, club) → uuid` | владелец сети | только клуб, где он — активный владелец напрямую (`BLN01`); клуб в другой сети — `BLN02`; нет сети или не его — `BLN03`; 100 клубов — `BLN04`; затем доступ управляющих и план |
| `bl.network_remove_club(network, club) → boolean` | владелец сети | клуб выходит: доступ управляющих сети к нему снимается, план — «Клуб» |
| `bl.network_invite(network, phone, expires) → uuid`, `bl.network_revoke_member(network, member) → uuid` | владелец сети | приглашение управляющего (уже управляющий — `BLN06`), отзыв (нет — `BLN07`) |
| `bl.network_accept_invites()` | пользователь из контекста (при входе) | привязать приглашения на его номер и выдать доступ |
| `bl.network_members_list(network)` | владелец сети | управляющие и приглашения: телефон (сервер маскирует), имя |
| `bl.network_archive(network) → integer` | владелец сети | архив: клубы выходят, управляющие отзываются |
| `bl.network_sync_access(network)` (1352), `bl.network_sync_billing(network)`, `bl.network_plan_for(club)`, `bl.network_me()`, `bl.network_owned(network)` | только узкие функции (у `app_api` нет `EXECUTE`) | строки `club_members` управляющих сети; план «Сеть» клубам сети из 2+ клубов; проверки контекста и владения; с 1352 вывод клуба, отзыв управляющего и архив сети отзывают и терминалы клуба, заведённые этим управляющим (`bl_definer`: `select (created_by)` и `update (revoked_at)` на `staff_terminals`), прямое членство не трогается |

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

## M5.8: падел-корт (`1300_padel_court.sql`, сид `seed.d/1300_padel.sql`)

- `bl.resource_family(type)` — `court` для `padel_court`, иначе `table` (IMMUTABLE, без SECURITY DEFINER; EXECUTE — `app_api`).
  Уникальность номера — индекс `resources_club_family_number_key (club_id, bl.resource_family(type), number)` вместо `(club_id, number)`.
- `tariff_rules.slot_minutes`, `price_per_slot` и ограничения: слот 60/90/120 с ценой > 0 и `step_minutes = min_minutes = slot_minutes`;
  у `padel_court` — только правила слота; почасовой шаг — 1…60, как раньше.
- `club_public.disciplines` — и `padel`.
- Сид: корты 1 и 2 клуба сида (`e1…101`, `e1…102`, коды `TESTC00001`, `TESTC00002`), контроллеры `d1…101`, `d1…102` (`SIM-0101/0102`,
  в `devices.json` симулятора — `table_number` 101 и 102), тариф слотов 90 минут. Столы 1–8 и их устройства не менялись.
  Тесты сценариев столов, которые считают ресурсы сида, выводят корты из работы (`deactivateSeedCourts` в `tests/helpers.mjs`).
