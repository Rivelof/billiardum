-- 0004: служебные роли Supabase без входа (decisions №39).
--
-- Сервисы Supabase мы не запускаем (decisions №11). В образе у postgres пароль
-- POSTGRES_PASSWORD, CREATEROLE и BYPASSRLS: такая роль выдаёт себе любую нашу роль,
-- pg_read_all_data и снимает ограничения с app_api. Входят только суперпользователь
-- (миграции) и app_api.
--
-- NOLOGIN и без пароля (если вход когда-нибудь вернут, старый пароль не сработает);
-- CREATEROLE снимается у всех перечисленных. Роли кластерные, блок идемпотентен;
-- роли, которой нет (обычный Postgres), пропускаются. Суперпользователя не трогаем.

do $$
declare
  r text;
begin
  foreach r in array array[
    'postgres',
    'authenticator',
    'pgbouncer',
    'supabase_auth_admin',
    'supabase_storage_admin',
    'supabase_read_only_user',
    'supabase_replication_admin'
  ] loop
    if exists (select 1 from pg_roles where rolname = r and not rolsuper) then
      execute format('alter role %I with nologin nocreaterole password null', r);
      raise notice 'role % -> nologin, nocreaterole', r;
    end if;
  end loop;
end
$$;
