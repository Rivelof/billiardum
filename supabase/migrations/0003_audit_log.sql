-- 0003: журнал действий bl.audit_log (инвариант 2, decisions №13).
--
-- * Своя цепочка хешей у каждого клуба, у записей платформы (club_id IS NULL) — отдельная.
-- * seq, created_at, prev_hash, hash задаёт триггер BEFORE INSERT и перезаписывает присланные.
-- * UPDATE, DELETE, TRUNCATE запрещены триггерами всем ролям, включая суперпользователя.
--   Триггеры включены как ENABLE ALWAYS: session_replication_role = replica их не отключает.
-- * Таблица и функции журнала принадлежат bl_audit_owner (без входа, никому не выдана).
-- * Событийные триггеры запрещают DDL над журналом (ALTER/DROP таблицы, триггеров,
--   политик, правил, функций журнала). Будущая миграция, которой нужно изменить журнал,
--   явно выключает их в своей транзакции (см. supabase/README.md).
--
-- Формула хеша (supabase/README.md):
--   hash = hex(sha256(utf8(prev_hash || canonical)))
--   canonical = jsonb_build_array('bl.audit.v1', id, club_id, seq, created_at_us,
--                 actor_type, actor_id, action, object_type, object_id, reason, data)::text
--   created_at_us — микросекунды Unix (bigint). sha256 — встроенная функция pg_catalog.

create table bl.audit_log (
  id uuid primary key default gen_random_uuid(),
  club_id uuid references bl.clubs (id),
  seq bigint not null check (seq > 0),
  created_at timestamptz not null,
  actor_type text not null default nullif(current_setting('app.actor_type', true), '')
    check (actor_type in ('user', 'system', 'device', 'support')),
  actor_id uuid default nullif(current_setting('app.user_id', true), '')::uuid,
  action text not null check (length(action) between 1 and 100),
  object_type text check (length(object_type) between 1 and 100),
  object_id uuid,
  reason text check (length(reason) <= 2000),
  data jsonb not null default '{}'::jsonb,
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  constraint audit_log_chain_seq unique nulls not distinct (club_id, seq)
);

comment on table bl.audit_log is 'Журнал действий: только INSERT, цепочка хешей на клуб (club_id IS NULL — платформа). Формула — supabase/README.md.';

-- Хеш записи --------------------------------------------------------------------

create function bl.audit_row_hash(
  p_prev_hash text,
  p_id uuid,
  p_club_id uuid,
  p_seq bigint,
  p_created_at timestamptz,
  p_actor_type text,
  p_actor_id uuid,
  p_action text,
  p_object_type text,
  p_object_id uuid,
  p_reason text,
  p_data jsonb
) returns text
language sql stable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select encode(
    sha256(convert_to(
      p_prev_hash || jsonb_build_array(
        'bl.audit.v1',
        p_id,
        p_club_id,
        p_seq,
        (extract(epoch from p_created_at) * 1000000)::bigint,
        p_actor_type,
        p_actor_id,
        p_action,
        p_object_type,
        p_object_id,
        p_reason,
        p_data
      )::text,
      'UTF8'
    )),
    'hex'
  )
$$;

-- BEFORE INSERT: позиция в цепочке и хеш ------------------------------------------

create function bl.audit_log_chain() returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_seq bigint;
  v_hash text;
begin
  if tg_op <> 'INSERT' or tg_when <> 'BEFORE' or tg_level <> 'ROW' then
    raise exception 'bl.audit_log_chain: unexpected trigger call (% % %)', tg_when, tg_op, tg_level;
  end if;

  -- Одна вставка в цепочку клуба за раз; клубы друг друга не ждут.
  perform pg_advisory_xact_lock(hashtextextended('bl.audit_log/' || coalesce(new.club_id::text, 'platform'), 0));

  if new.club_id is null then
    select a.seq, a.hash into v_seq, v_hash
    from bl.audit_log a
    where a.club_id is null
    order by a.seq desc
    limit 1;
  else
    select a.seq, a.hash into v_seq, v_hash
    from bl.audit_log a
    where a.club_id = new.club_id
    order by a.seq desc
    limit 1;
  end if;

  new.id := coalesce(new.id, gen_random_uuid());
  new.seq := coalesce(v_seq, 0) + 1;
  new.created_at := clock_timestamp();
  new.prev_hash := coalesce(v_hash, repeat('0', 64));
  new.data := coalesce(new.data, '{}'::jsonb);
  new.hash := bl.audit_row_hash(
    new.prev_hash, new.id, new.club_id, new.seq, new.created_at,
    new.actor_type, new.actor_id, new.action, new.object_type, new.object_id,
    new.reason, new.data
  );
  return new;
end
$$;

-- UPDATE, DELETE, TRUNCATE — всегда ошибка ---------------------------------------

create function bl.audit_log_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'bl.audit_log is append-only: % is forbidden', tg_op
    using errcode = 'insufficient_privilege',
          hint = 'Журнал только дополняется (инвариант 2). Исправление — новой записью.';
end
$$;

create trigger audit_log_chain
  before insert on bl.audit_log
  for each row execute function bl.audit_log_chain();

create trigger audit_log_immutable_stmt
  before update or delete on bl.audit_log
  for each statement execute function bl.audit_log_immutable();

create trigger audit_log_immutable_row
  before update or delete on bl.audit_log
  for each row execute function bl.audit_log_immutable();

create trigger audit_log_no_truncate
  before truncate on bl.audit_log
  for each statement execute function bl.audit_log_immutable();

alter table bl.audit_log enable always trigger audit_log_chain;
alter table bl.audit_log enable always trigger audit_log_immutable_stmt;
alter table bl.audit_log enable always trigger audit_log_immutable_row;
alter table bl.audit_log enable always trigger audit_log_no_truncate;

-- Проверка цепочки -------------------------------------------------------------------
-- ok = true, first_bad_seq = NULL — цепочка цела. Иначе first_bad_seq — номер первой
-- испорченной записи (для удалённой записи — её номер, которого не хватает).
-- checked — сколько записей проверено, head_seq и head_hash — голова целой цепочки
-- (при ok = false — NULL)
-- (head_hash уходит владельцу в утренней сводке и выдаёт перезапись хвоста).
-- Вызывается с правами вызывающего: app_api видит только цепочку клуба из контекста.

create function bl.audit_verify(p_club uuid)
returns table (ok boolean, first_bad_seq bigint, checked bigint, head_seq bigint, head_hash text)
language plpgsql stable
set search_path = pg_catalog, pg_temp
as $$
declare
  c refcursor;
  r bl.audit_log%rowtype;
  v_expected bigint := 1;
  v_prev text := repeat('0', 64);
  v_checked bigint := 0;
  v_privileged boolean;
begin
  select (rolsuper or rolbypassrls) into v_privileged from pg_roles where rolname = current_user;
  if not coalesce(v_privileged, false)
     and p_club is distinct from nullif(current_setting('app.club_id', true), '')::uuid then
    raise exception 'bl.audit_verify: club is outside of the request context'
      using errcode = 'insufficient_privilege';
  end if;

  if p_club is null then
    open c for select * from bl.audit_log a where a.club_id is null order by a.seq;
  else
    open c for select * from bl.audit_log a where a.club_id = p_club order by a.seq;
  end if;

  loop
    fetch c into r;
    exit when not found;
    v_checked := v_checked + 1;
    if r.seq <> v_expected
       or r.prev_hash <> v_prev
       or r.hash <> bl.audit_row_hash(
            r.prev_hash, r.id, r.club_id, r.seq, r.created_at,
            r.actor_type, r.actor_id, r.action, r.object_type, r.object_id,
            r.reason, r.data)
    then
      close c;
      return query select false, least(r.seq, v_expected), v_checked, null::bigint, null::text;
      return;
    end if;
    v_expected := r.seq + 1;
    v_prev := r.hash;
  end loop;
  close c;

  return query select true, null::bigint, v_checked,
    case when v_checked = 0 then null else v_expected - 1 end,
    case when v_checked = 0 then null else v_prev end;
end
$$;

-- Владелец, RLS, права --------------------------------------------------------------

alter table bl.audit_log owner to bl_audit_owner;
alter function bl.audit_row_hash(text, uuid, uuid, bigint, timestamptz, text, uuid, text, text, uuid, text, jsonb) owner to bl_audit_owner;
alter function bl.audit_log_chain() owner to bl_audit_owner;
alter function bl.audit_log_immutable() owner to bl_audit_owner;
alter function bl.audit_verify(uuid) owner to bl_audit_owner;

alter table bl.audit_log enable row level security;
alter table bl.audit_log force row level security;

create policy audit_log_app_select on bl.audit_log for select to app_api
  using (club_id = bl.ctx_club_id());

-- Запись в цепочку клуба из контекста; в цепочку платформы — только без контекста
-- клуба и только от system/support. INSERT … RETURNING для записей платформы
-- не работает: строку платформы app_api не видит.
create policy audit_log_app_insert on bl.audit_log for insert to app_api
  with check (
    club_id = bl.ctx_club_id()
    or (club_id is null and bl.ctx_club_id() is null and actor_type in ('system', 'support'))
  );

-- Триггер цепочки (SECURITY DEFINER от bl_audit_owner) читает голову любой цепочки.
create policy audit_log_chain_read on bl.audit_log for select to bl_audit_owner
  using (true);

revoke all on bl.audit_log from public;
grant select, insert on bl.audit_log to app_api;

revoke all on function bl.audit_row_hash(text, uuid, uuid, bigint, timestamptz, text, uuid, text, text, uuid, text, jsonb) from public;
revoke all on function bl.audit_log_chain() from public;
revoke all on function bl.audit_log_immutable() from public;
revoke all on function bl.audit_verify(uuid) from public;
grant execute on function bl.audit_row_hash(text, uuid, uuid, bigint, timestamptz, text, uuid, text, text, uuid, text, jsonb) to app_api;
grant execute on function bl.audit_verify(uuid) to app_api;

-- Защита от DDL над журналом ----------------------------------------------------------
-- Владелец журнала никому не выдан, но суперпользователь и роли с CREATEROLE
-- (в образе Supabase это postgres, supabase_auth_admin, supabase_storage_admin)
-- могут получить права владельца. Событийные триггеры (ENABLE ALWAYS, владелец —
-- суперпользователь) отменяют любую DDL-команду над журналом и его функциями,
-- в том числе DROP SCHEMA bl CASCADE. Обойти их может только суперпользователь
-- (ALTER EVENT TRIGGER … DISABLE); такую подмену выдаёт bl.audit_verify и голова
-- цепочки у владельца.
--
-- Функции защиты лежат в отдельной схеме bl_guard (владелец — суперпользователь,
-- прав ни у кого): каскадное удаление схемы bl не может удалить их вместе с собой.
-- Они читают только pg_catalog, поэтому не мешают DDL ролей без доступа к bl.

create schema bl_guard;
revoke all on schema bl_guard from public;
comment on schema bl_guard is 'Бильярдум: функции событийных триггеров, защищающих bl.audit_log. Владелец — суперпользователь.';

create function bl_guard.audit_ddl() returns event_trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  r record;
  v_tbl oid;
  v_ns oid;
begin
  select c.oid, c.relnamespace into v_tbl, v_ns
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'bl' and c.relname = 'audit_log';
  if v_tbl is null then
    return;
  end if;
  for r in select * from pg_event_trigger_ddl_commands() loop
    if (r.classid = 'pg_class'::regclass and (
          r.objid = v_tbl
          or exists (select 1 from pg_index i where i.indexrelid = r.objid and i.indrelid = v_tbl)))
       or (r.classid = 'pg_trigger'::regclass
           and exists (select 1 from pg_trigger t where t.oid = r.objid and t.tgrelid = v_tbl))
       or (r.classid = 'pg_rewrite'::regclass
           and exists (select 1 from pg_rewrite w where w.oid = r.objid and w.ev_class = v_tbl))
       or (r.classid = 'pg_policy'::regclass
           and exists (select 1 from pg_policy p where p.oid = r.objid and p.polrelid = v_tbl))
       or (r.classid = 'pg_constraint'::regclass
           and exists (select 1 from pg_constraint c where c.oid = r.objid and c.conrelid = v_tbl))
       or (r.classid = 'pg_proc'::regclass
           and exists (
             select 1
             from pg_proc p
             left join pg_roles o on o.oid = p.proowner
             where p.oid = r.objid
               and p.pronamespace = v_ns
               and (p.proname like 'audit\_%'
                    or o.rolname = 'bl_audit_owner'
                    or p.oid in (select t.tgfoid from pg_trigger t where t.tgrelid = v_tbl))))
    then
      raise exception 'bl.audit_log is protected: % on % is forbidden', r.command_tag, r.object_identity
        using errcode = 'insufficient_privilege',
              hint = 'Изменение журнала — только миграцией, которая явно выключает bl_audit_guard_* (supabase/README.md).';
    end if;
  end loop;
end
$$;

create function bl_guard.audit_drop() returns event_trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  r record;
begin
  for r in select * from pg_event_trigger_dropped_objects() loop
    if coalesce(r.schema_name, r.address_names[1]) = 'bl' and (
         r.object_name like 'audit\_%'
         or r.object_name like '\_audit\_%'
         or r.address_names[2] like 'audit\_%'
         or r.object_identity like '% on bl.audit\_log'
       )
    then
      raise exception 'bl.audit_log is protected: DROP % % is forbidden', r.object_type, r.object_identity
        using errcode = 'insufficient_privilege',
              hint = 'Изменение журнала — только миграцией, которая явно выключает bl_audit_guard_* (supabase/README.md).';
    end if;
  end loop;
end
$$;

revoke all on function bl_guard.audit_ddl() from public;
revoke all on function bl_guard.audit_drop() from public;

create event trigger bl_audit_guard_ddl on ddl_command_end
  execute function bl_guard.audit_ddl();
create event trigger bl_audit_guard_drop on sql_drop
  execute function bl_guard.audit_drop();
alter event trigger bl_audit_guard_ddl enable always;
alter event trigger bl_audit_guard_drop enable always;
