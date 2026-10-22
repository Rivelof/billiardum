-- 0103 (backend-core): узкие функции SECURITY DEFINER входа и уведомлений.
--
-- До входа сервер не знает пользователя, а users под RLS видна только самому
-- пользователю. Поэтому поиск по токену, по телефону, Telegram и MAX и привязка
-- телефона — функции владельца bl_definer (без входа, никому не выдан) с точными
-- правами на столбцы. У всех search_path = pg_catalog, pg_temp, EXECUTE только у app_api.
-- Телефон наружу не отдаётся: только признак «есть» или маска +7999***4567.

-- Права bl_definer на столбцы ---------------------------------------------------------------

grant select (id, phone, telegram_user_id, max_user_id, notify_channel, merged_into) on bl.users to bl_definer;
grant insert (phone, telegram_user_id, max_user_id) on bl.users to bl_definer;
grant update (phone, phone_verified_at, telegram_user_id, max_user_id, merged_into, updated_at) on bl.users to bl_definer;
grant select (id, user_id, token_hash, kind, club_id, terminal_id, expires_at, revoked_at) on bl.auth_tokens to bl_definer;
grant select (id, club_id, token_hash, expires_at, revoked_at) on bl.staff_terminals to bl_definer;
grant select (user_id, version, accepted_at) on bl.consents to bl_definer;
grant insert (user_id, version, accepted_at) on bl.consents to bl_definer;

create policy users_definer on bl.users for all to bl_definer using (true) with check (true);
create policy auth_tokens_definer on bl.auth_tokens for select to bl_definer using (true);
create policy staff_terminals_definer on bl.staff_terminals for select to bl_definer using (true);
create policy consents_definer on bl.consents for all to bl_definer using (true) with check (true);

-- Токен → кто это ----------------------------------------------------------------------------
-- Действующий токен пользователя (не отозван, не истёк, учётка не влита в другую; у токена
-- PIN — действующий терминал) или токен терминала. consents — принятые версии согласия.

create function bl.auth_resolve(p_token_hash text)
returns table (
  token_id uuid,
  kind text,
  user_id uuid,
  club_id uuid,
  terminal_id uuid,
  expires_at timestamptz,
  has_phone boolean,
  consents text[]
)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select t.id, t.kind, t.user_id, t.club_id, t.terminal_id, t.expires_at,
         u.phone is not null,
         coalesce((select array_agg(c.version order by c.version) from bl.consents c where c.user_id = u.id), '{}'::text[])
    from bl.auth_tokens t
    join bl.users u on u.id = t.user_id
   where t.token_hash = p_token_hash
     and t.revoked_at is null
     and t.expires_at > now()
     and u.merged_into is null
     and (t.terminal_id is null or exists (
           select 1 from bl.staff_terminals s
            where s.id = t.terminal_id and s.revoked_at is null and s.expires_at > now()))
  union all
  select s.id, 'terminal', null::uuid, s.club_id, s.id, s.expires_at, false, '{}'::text[]
    from bl.staff_terminals s
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
$$;

-- Найти или создать пользователя по телефону (вход для разработки), Telegram или MAX ----------

create function bl.auth_user_for(p_kind text, p_value text) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_kind = 'phone' then
    if p_value is null or p_value !~ '^\+[1-9][0-9]{7,14}$' then
      raise exception 'bl.auth_user_for: bad phone' using errcode = '22023';
    end if;
    select u.id into v_id from bl.users u where u.phone = p_value;
    if v_id is null then
      insert into bl.users (phone) values (p_value) on conflict (phone) do nothing returning id into v_id;
      if v_id is null then
        select u.id into v_id from bl.users u where u.phone = p_value;
      end if;
    end if;
  elsif p_kind = 'telegram' then
    if p_value is null or p_value !~ '^[1-9][0-9]{0,17}$' then
      raise exception 'bl.auth_user_for: bad telegram id' using errcode = '22023';
    end if;
    select u.id into v_id from bl.users u where u.telegram_user_id = p_value::bigint;
    if v_id is null then
      insert into bl.users (telegram_user_id) values (p_value::bigint)
        on conflict (telegram_user_id) do nothing returning id into v_id;
      if v_id is null then
        select u.id into v_id from bl.users u where u.telegram_user_id = p_value::bigint;
      end if;
    end if;
  elsif p_kind = 'max' then
    if p_value is null or p_value !~ '^[0-9A-Za-z_-]{1,64}$' then
      raise exception 'bl.auth_user_for: bad max id' using errcode = '22023';
    end if;
    select u.id into v_id from bl.users u where u.max_user_id = p_value;
    if v_id is null then
      insert into bl.users (max_user_id) values (p_value) on conflict (max_user_id) do nothing returning id into v_id;
      if v_id is null then
        select u.id into v_id from bl.users u where u.max_user_id = p_value;
      end if;
    end if;
  else
    raise exception 'bl.auth_user_for: unknown kind' using errcode = '22023';
  end if;
  return v_id;
end
$$;

-- Телефон из «Поделиться контактом» для пользователя из контекста (app.user_id) ---------------
-- Номера нет ни у кого — записывается текущему пользователю. Номер уже у другой учётки
-- (например, сотрудник из сида или вход через другой мессенджер) — текущая учётка,
-- созданная входом через мессенджер и ещё без телефона, вливается в неё: идентификаторы
-- мессенджеров и согласия переходят, токены влитой учётки перестают действовать.
-- Конфликт (у текущей уже другой номер или у той учётки другой аккаунт того же мессенджера)
-- — ошибка BL409 phone_conflict. Возвращает id учётки, которой теперь принадлежит номер.

create function bl.auth_attach_phone(p_phone text) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_me uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  me record;
  other record;
begin
  if v_me is null then
    raise exception 'bl.auth_attach_phone: no user in context' using errcode = '42501';
  end if;
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'bl.auth_attach_phone: bad phone' using errcode = '22023';
  end if;
  select u.id, u.phone, u.telegram_user_id, u.max_user_id, u.merged_into into me
    from bl.users u where u.id = v_me for update;
  if not found or me.merged_into is not null then
    raise exception 'bl.auth_attach_phone: user not found' using errcode = '42501';
  end if;
  if me.phone = p_phone then
    update bl.users set phone_verified_at = now(), updated_at = now() where id = v_me;
    return v_me;
  end if;

  select u.id, u.phone, u.telegram_user_id, u.max_user_id, u.merged_into into other
    from bl.users u where u.phone = p_phone for update;
  if not found then
    update bl.users set phone = p_phone, phone_verified_at = now(), updated_at = now() where id = v_me;
    return v_me;
  end if;

  if me.phone is not null
     or (me.telegram_user_id is not null and other.telegram_user_id is not null
         and other.telegram_user_id <> me.telegram_user_id)
     or (me.max_user_id is not null and other.max_user_id is not null
         and other.max_user_id <> me.max_user_id) then
    raise exception 'phone_conflict' using errcode = 'BL409';
  end if;

  update bl.users
     set telegram_user_id = null, max_user_id = null, merged_into = other.id, updated_at = now()
   where id = v_me;
  update bl.users
     set telegram_user_id = coalesce(other.telegram_user_id, me.telegram_user_id),
         max_user_id = coalesce(other.max_user_id, me.max_user_id),
         phone_verified_at = now(),
         updated_at = now()
   where id = other.id;
  insert into bl.consents (user_id, version, accepted_at)
  select other.id, c.version, c.accepted_at from bl.consents c where c.user_id = v_me
  on conflict (user_id, version) do nothing;
  return other.id;
end
$$;

-- Куда доставлять уведомление: канал и идентификаторы мессенджеров, без телефона ---------------

create function bl.notify_route(p_user_id uuid)
returns table (user_id uuid, notify_channel text, telegram_user_id bigint, max_user_id text)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select u.id, u.notify_channel, u.telegram_user_id, u.max_user_id
    from bl.users u
   where u.id = p_user_id and u.merged_into is null
$$;

-- Пользователь глазами персонала: маска телефона. Только с контекстом клуба или для себя. -----

create function bl.user_brief(p_user_id uuid)
returns table (user_id uuid, phone_masked text, has_phone boolean)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select u.id,
         case when u.phone is null then null else left(u.phone, 5) || '***' || right(u.phone, 4) end,
         u.phone is not null
    from bl.users u
   where u.id = p_user_id
     and (pg_catalog.current_setting('app.club_id', true) <> ''
          or u.id = nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid)
$$;

-- Владелец и права -------------------------------------------------------------------------------

alter function bl.auth_resolve(text) owner to bl_definer;
alter function bl.auth_user_for(text, text) owner to bl_definer;
alter function bl.auth_attach_phone(text) owner to bl_definer;
alter function bl.notify_route(uuid) owner to bl_definer;
alter function bl.user_brief(uuid) owner to bl_definer;

revoke all on function bl.auth_resolve(text), bl.auth_user_for(text, text), bl.auth_attach_phone(text),
  bl.notify_route(uuid), bl.user_brief(uuid) from public;
grant execute on function bl.auth_resolve(text), bl.auth_user_for(text, text), bl.auth_attach_phone(text),
  bl.notify_route(uuid), bl.user_brief(uuid) to app_api;

comment on function bl.auth_resolve(text) is 'SECURITY DEFINER: действующий токен пользователя или терминала по sha256.';
comment on function bl.auth_user_for(text, text) is 'SECURITY DEFINER: найти или создать пользователя по телефону, Telegram или MAX.';
comment on function bl.auth_attach_phone(text) is 'SECURITY DEFINER: телефон из «Поделиться контактом» пользователю из контекста (слияние учёток).';
comment on function bl.notify_route(uuid) is 'SECURITY DEFINER: канал уведомлений и id мессенджеров пользователя, без телефона.';
comment on function bl.user_brief(uuid) is 'SECURITY DEFINER: маска телефона пользователя для персонала клуба из контекста.';
