-- 0001: роли, схема bl, учёт миграций, функции контекста запроса.
--
-- Выполняет суперпользователь (DATABASE_ADMIN_URL) через supabase/bin/migrate.mjs,
-- каждая миграция — в своей транзакции. Пароль app_api здесь не задаётся:
-- его ставит раннер из DB_APP_PASSWORD (готовым хешем SCRAM, пароль в SQL не попадает).
-- Роли общие для всего кластера, поэтому блок идемпотентен.

-- Роли ------------------------------------------------------------------------

do $$
declare
  r text;
begin
  foreach r in array array['bl_owner', 'bl_audit_owner', 'bl_definer', 'app_api'] loop
    begin
      execute format('create role %I nologin', r);
    exception when duplicate_object then
      null;
    end;
  end loop;
end
$$;

-- Владелец таблиц схемы bl (роль миграций). Без входа, никому не выдаётся.
alter role bl_owner with nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
-- Владелец audit_log и функций журнала. Без входа, никому не выдаётся.
alter role bl_audit_owner with nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
-- Владелец узких функций SECURITY DEFINER (поиск устройства). Видит только devices(id, club_id).
alter role bl_definer with nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
-- Рабочая роль сервера: вход по паролю, без BYPASSRLS, ничем не владеет.
alter role app_api with login nosuperuser nocreatedb nocreaterole inherit noreplication nobypassrls connection limit -1;
alter role app_api set statement_timeout = '15s';
alter role app_api set idle_in_transaction_session_timeout = '60s';

-- Наши роли ни в кого не входят, и в них никто не входит.
do $$
declare
  m record;
begin
  for m in
    select r.rolname as role_name, u.rolname as member_name
    from pg_auth_members am
    join pg_roles r on r.oid = am.roleid
    join pg_roles u on u.oid = am.member
    where r.rolname in ('bl_owner', 'bl_audit_owner', 'bl_definer', 'app_api')
       or u.rolname in ('bl_owner', 'bl_audit_owner', 'bl_definer', 'app_api')
  loop
    execute format('revoke %I from %I', m.role_name, m.member_name);
    raise notice 'revoked membership % from %', m.role_name, m.member_name;
  end loop;
end
$$;

-- Образ supabase/postgres выдаёт postgres и supabase_read_only_user членство
-- в pg_read_all_data, а у обеих ролей есть BYPASSRLS: без этой правки они читают
-- схему bl целиком в обход RLS. Читать и писать всё подряд может только суперпользователь.
do $$
declare
  m record;
begin
  for m in
    select r.rolname as role_name, u.rolname as member_name
    from pg_auth_members am
    join pg_roles r on r.oid = am.roleid
    join pg_roles u on u.oid = am.member
    where r.rolname in ('pg_read_all_data', 'pg_write_all_data')
      and not u.rolsuper
  loop
    execute format('revoke %I from %I', m.role_name, m.member_name);
    raise notice 'revoked % from %', m.role_name, m.member_name;
  end loop;
end
$$;

-- Схема ------------------------------------------------------------------------
-- Владелец схемы — суперпользователь, который выполняет миграции: владелец схемы
-- может удалять в ней чужие объекты, поэтому это не bl_owner.

create schema if not exists bl;
revoke all on schema bl from public;
grant usage on schema bl to bl_owner, bl_audit_owner, bl_definer, app_api;

comment on schema bl is 'Бильярдум: все объекты платформы. Права только у app_api и ролей-владельцев bl_*; роли Supabase прав не имеют.';

-- Учёт миграций --------------------------------------------------------------

create table if not exists bl.schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);
alter table bl.schema_migrations owner to bl_owner;
revoke all on bl.schema_migrations from public;

comment on table bl.schema_migrations is 'Применённые миграции supabase/migrations: версия, имя файла, sha256 содержимого.';

-- Контекст запроса -----------------------------------------------------------
-- Сервер в каждой транзакции вызывает set_config('app.club_id' | 'app.user_id' |
-- 'app.actor_type', …, true). Пустое значение — контекста нет. Неверный UUID —
-- ошибка запроса (закрыто по умолчанию).

create or replace function bl.ctx_club_id() returns uuid
language sql stable parallel safe
as $$ select nullif(pg_catalog.current_setting('app.club_id', true), '')::uuid $$;

create or replace function bl.ctx_user_id() returns uuid
language sql stable parallel safe
as $$ select nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid $$;

create or replace function bl.ctx_actor_type() returns text
language sql stable parallel safe
as $$ select nullif(pg_catalog.current_setting('app.actor_type', true), '') $$;

alter function bl.ctx_club_id() owner to bl_owner;
alter function bl.ctx_user_id() owner to bl_owner;
alter function bl.ctx_actor_type() owner to bl_owner;
revoke all on function bl.ctx_club_id(), bl.ctx_user_id(), bl.ctx_actor_type() from public;
grant execute on function bl.ctx_club_id(), bl.ctx_user_id(), bl.ctx_actor_type() to app_api;
