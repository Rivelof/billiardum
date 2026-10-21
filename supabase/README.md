# База «Бильярдума» (`@billiardum/db`)

Postgres из образа `supabase/postgres` (decisions №11). Клиенты в базу не ходят; сервер работает под ролью `app_api`, RLS по клубу действует и на него. Контракт — `docs/contracts/m0.md` §5.

## Команды

| Команда (из корня) | Что делает | Переменные |
|---|---|---|
| `npm run db:migrate` | применяет `migrations/NNNN_name.sql` по порядку, каждую в своей транзакции; учёт в `bl.schema_migrations` (версия, имя, sha256); изменённая после применения миграция — ошибка; задаёт пароль `app_api` | `DATABASE_ADMIN_URL`, `DB_APP_PASSWORD` |
| `npm run db:seed` | `seed.sql`: синтетический клуб, повторный запуск ничего не дублирует; при `NODE_ENV=production` отказ | `DATABASE_ADMIN_URL` |
| `npm run db:reset` | снимает защиту журнала, стирает схемы `bl` и `bl_guard`, затем migrate и seed; при `NODE_ENV=production` отказ | `DATABASE_ADMIN_URL`, `DB_APP_PASSWORD` |
| `npm run test:db` | тесты базы на поднятом Postgres (ниже) | `DATABASE_ADMIN_URL`, по желанию `DATABASE_URL` |
| `npm test -w @billiardum/db` | юнит-тесты без базы (SCRAM, учёт миграций) | — |

`DATABASE_ADMIN_URL` — суперпользователь (`supabase_admin`): миграции создают роли и событийные триггеры. Если переменной нет в окружении, инструменты читают `.env` из корня (окружение главнее файла).

Пароль `app_api` уходит в базу готовым хешем SCRAM-SHA-256, посчитанным в Node: открытого пароля нет ни в SQL, ни в логах Postgres, ни в `pg_stat_statements`. Пароль — печатный ASCII без пробелов, 12–256 символов.

## Схема `bl`

Все объекты — в схеме `bl` (decisions №34). Владелец схемы — суперпользователь, который выполняет миграции. У ролей Supabase прав на `bl` нет.

| Таблица | Суть |
|---|---|
| `users` | `id`, `phone` (E.164), `created_at` — персонал и владельцы (гости — M1) |
| `clubs` | `name`, `city`, `timezone` (IANA, проверяется), `settings jsonb` |
| `club_members` | `club_id`, `user_id`, `role` (`owner`, `manager`, `reception`, `installer`), `pin_hash`, `active` |
| `resources` | стол: `type` (`billiard_pyramid`, `billiard_pool`, `billiard_snooker`), `number`, `title`, план зала `plan_x`, `plan_y` (центр стола в сантиметрах от левого верхнего угла зала), `plan_rotation` (градусы) |
| `devices` | `id` = device_id = логин MQTT, `resource_id` (уникально), `device_key_enc` (AES-256-GCM в приложении), `last_seq`, `fw`, `caps`, `last_seen_at` |
| `tariff_rules` | `resource_type` или `resource_id`, `days` (ISO 1–7), `start_local`–`end_local` (местное время клуба; конец ≤ начала — через полночь), `price_per_hour` (копейки), `step_minutes`, `min_minutes`, `priority` |
| `audit_log` | журнал, см. ниже |
| `schema_migrations` | учёт миграций (у `app_api` прав нет) |

Ресурс и устройство, тариф и ресурс связаны составными ключами `(club_id, id)`: строка не сошлётся на стол другого клуба.

### Контекст запроса и RLS

В каждой транзакции сервер вызывает (`server/lib/store.mjs`, `withContext`):

```sql
select set_config('app.club_id', $club, true), set_config('app.user_id', $user, true), set_config('app.actor_type', $type, true);
```

`actor_type`: `user`, `system`, `device`, `support`. Пустое значение — контекста нет; неверный UUID — ошибка запроса.
На всех таблицах `ENABLE` и `FORCE ROW LEVEL SECURITY`. Политики `TO app_api`: строка видна и пишется, только если `club_id = app.club_id` (для `clubs` — `id`). Без контекста `app_api` не видит ни одной строки. `users` видны сам себе (`app.user_id`) и участникам клуба из контекста.

Права `app_api`: `SELECT` всех таблиц кроме `schema_migrations`; `INSERT`/`UPDATE` — `club_members`, `resources`, `tariff_rules`; `UPDATE` у `clubs`; у `devices` — `INSERT` и `UPDATE` только столбцов `resource_id`, `serial`, `device_key_enc`, `last_seq`, `fw`, `caps`, `last_seen_at`; журнал — только `SELECT`, `INSERT`. `DELETE` и `TRUNCATE` нет ни на что.

## Роли

| Роль | Вход | Назначение |
|---|---|---|
| `bl_owner` | нет | владелец таблиц и функций контекста (роль миграций); никому не выдана |
| `bl_audit_owner` | нет | владелец `audit_log` и функций журнала; никому не выдана |
| `bl_definer` | нет | владелец узких функций `SECURITY DEFINER`; видит только `devices(id, club_id)` |
| `app_api` | да | рабочая роль сервера: без `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, ничем не владеет; `statement_timeout` 15 с |

Миграция `0001` отзывает `pg_read_all_data` и `pg_write_all_data` у всех ролей, кроме суперпользователей: в образе их получают `postgres` и `supabase_read_only_user`, у которых есть `BYPASSRLS`, — иначе они читали бы `bl` целиком в обход RLS. Это изменение ролей кластера.

Ограничение образа: у `postgres` (пароль = `POSTGRES_PASSWORD`), `supabase_auth_admin`, `supabase_storage_admin` есть `CREATEROLE`, у `postgres` ещё и `BYPASSRLS`. В Postgres 15 такая роль может выдать себе любую нашу роль или `pg_read_all_data` и снять ограничения с `app_api`. Журнал это переживает (триггеры и защита DDL, проверено тестом), изоляцию клубов — нет. Пароль `postgres` равнозначен паролю суперпользователя.

## Узкие функции `SECURITY DEFINER`

У всех `search_path = pg_catalog, pg_temp`, `EXECUTE` только у `app_api`.

| Функция | Владелец | Возвращает | Зачем |
|---|---|---|---|
| `bl.device_club(device_id uuid) → uuid` | `bl_definer` | `club_id` устройства или `NULL` | мост MQTT узнаёт клуб устройства до того, как известен контекст |
| `bl.device_total() → bigint` | `bl_definer` | число устройств во всех клубах | `total` в логе `devices_online` |
| `bl.audit_log_chain()` (триггер) | `bl_audit_owner` | — | читает голову цепочки любого клуба при вставке |

Других функций `SECURITY DEFINER` в `bl` нет (проверяется тестом).

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

## Тесты базы (`tests/`)

Каждый файл создаёт свою временную базу `bl_test_*` из `template1`, применяет миграции и сид и удаляет её в конце: журнал нельзя очистить, поэтому тесты не пишут в рабочую базу. Пароль `app_api` тесты не меняют — действуют через `SET ROLE app_api` (те же права и RLS); если задан `DATABASE_URL`, дополнительно проверяется вход `app_api` по паролю. Файлы идут по одному (`--test-concurrency=1`), 50 параллельных соединений — нужен `max_connections` ≥ 70.

- `audit_immutable` — `UPDATE`, `DELETE`, `TRUNCATE` падают у суперпользователя (и в режиме `replica`), у владельца журнала и у каждой роли кластера (`SET ROLE`), включая `bl_owner`, `app_api`, `anon`, `authenticated`, `service_role`, `authenticator`, `postgres`, `supabase_read_only_user`; DDL над журналом запрещена; `postgres` с `CREATEROLE` выдаёт себе владельца журнала, но изменить его не может.
- `audit_chain` — триггер перезаписывает присланные поля; хеш воспроизводится по формуле; 50 параллельных вставок дают `seq` 1…50 без пропусков и `ok`; цепочки клубов и платформы независимы; подмена данных, удаление записи и перезапись записи вместе с её хешем в обход всех защит находятся `audit_verify`.
- `isolation` — с контекстом клуба A не видно строк клуба B ни в одной таблице, вставка и перенос строки в клуб B падают на RLS; без контекста — ноль строк; функции `SECURITY DEFINER` — только перечисленные.
- `roles` — у ролей Supabase нет прав на `bl`, роли с `BYPASSRLS` и роли `authenticator` получают `permission denied` на каждую таблицу; членов у `pg_read_all_data` нет; права на объекты только у наших ролей; атрибуты ролей.
- `main_db` — только чтение и откатываемые попытки на рабочей базе из `DATABASE_ADMIN_URL` (если она уже мигрирована): все миграции применены, журнал неизменяем, роли Supabase не читают `bl`, цепочки целы.
