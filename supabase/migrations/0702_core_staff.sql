-- 0702 (backend-core, M3): персонал клуба (контракт M3 §1 п. 9, decisions №111).
--
-- Владелец приглашает по телефону с ролью; приглашение действует 7 дней и привязывается при
-- первом входе с этим номером (bl.staff_accept_invites — пользователь из контекста).
-- Отзыв доступа гасит членство, PIN и токены сотрудника (bl.staff_revoke_tokens).

create table bl.staff_invites (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  role text not null check (role in ('manager', 'reception', 'installer', 'bar')),
  invited_by uuid not null references bl.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_user_id uuid references bl.users (id),
  revoked_at timestamptz,
  unique (club_id, id),
  check (expires_at > created_at)
);
create unique index staff_invites_open_key on bl.staff_invites (club_id, phone) where accepted_at is null and revoked_at is null;
create index staff_invites_phone_idx on bl.staff_invites (phone) where accepted_at is null and revoked_at is null;

alter table bl.staff_invites owner to bl_owner;
alter table bl.staff_invites enable row level security;
alter table bl.staff_invites force row level security;
create policy staff_invites_app on bl.staff_invites for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());
revoke all on bl.staff_invites from public;
grant select, insert on bl.staff_invites to app_api;
grant update (revoked_at, expires_at, role) on bl.staff_invites to app_api;

comment on table bl.staff_invites is 'Приглашения персонала по телефону: роль, 7 дней, привязка при первом входе с номером.';

-- Права bl_definer для привязки приглашений и отзыва токенов.
grant select (id, club_id, phone, role, expires_at, accepted_at, revoked_at) on bl.staff_invites to bl_definer;
grant update (accepted_at, accepted_user_id) on bl.staff_invites to bl_definer;
create policy staff_invites_definer on bl.staff_invites for all to bl_definer using (true) with check (true);
grant select (id, club_id, user_id, role, active) on bl.club_members to bl_definer;
grant insert (club_id, user_id, role) on bl.club_members to bl_definer;
grant update (role, active, pin_hash, pin_failed_count, pin_locked_until) on bl.club_members to bl_definer;
create policy club_members_definer on bl.club_members for all to bl_definer using (true) with check (true);
grant update (revoked_at) on bl.auth_tokens to bl_definer;
create policy auth_tokens_definer_update on bl.auth_tokens for update to bl_definer using (true) with check (true);

-- Привязать действующие приглашения на номер пользователя из контекста (app.user_id).
-- Возвращает (invite_id, club_id, role) привязанных; уже активный участник клуба не меняется.
create function bl.staff_accept_invites()
returns table (invite_id uuid, club_id uuid, role text)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  v_me uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  v_phone text;
  r record;
begin
  if v_me is null then
    return;
  end if;
  select u.phone into v_phone from bl.users u where u.id = v_me and u.merged_into is null;
  if v_phone is null then
    return;
  end if;
  for r in
    select i.id, i.club_id, i.role from bl.staff_invites i
     where i.phone = v_phone and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
     for update
  loop
    insert into bl.club_members (club_id, user_id, role) values (r.club_id, v_me, r.role)
      on conflict (club_id, user_id) do update
        set role = excluded.role, active = true
        where not bl.club_members.active;
    update bl.staff_invites set accepted_at = now(), accepted_user_id = v_me where id = r.id;
    invite_id := r.id;
    club_id := r.club_id;
    role := r.role;
    return next;
  end loop;
end
$$;

-- Отзыв доступа (контекст клуба app.club_id): членство гаснет, PIN стирается, все токены
-- сотрудника отзываются (личные — тоже: доступ закрывается сразу, вход — заново).
-- Владельца так не отозвать. Возвращает число отозванных токенов; не участник клуба — NULL.
create function bl.staff_revoke(p_user_id uuid)
returns integer
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_club uuid := nullif(pg_catalog.current_setting('app.club_id', true), '')::uuid;
  v_role text;
  v_n integer;
begin
  if v_club is null then
    raise exception 'bl.staff_revoke: no club in context' using errcode = '42501';
  end if;
  select m.role into v_role from bl.club_members m where m.club_id = v_club and m.user_id = p_user_id for update;
  if not found then
    return null;
  end if;
  if v_role = 'owner' then
    raise exception 'bl.staff_revoke: owner cannot be revoked' using errcode = '42501';
  end if;
  update bl.club_members
     set active = false, pin_hash = null, pin_failed_count = 0, pin_locked_until = null
   where club_id = v_club and user_id = p_user_id;
  update bl.auth_tokens set revoked_at = now() where user_id = p_user_id and revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

alter function bl.staff_accept_invites() owner to bl_definer;
alter function bl.staff_revoke(uuid) owner to bl_definer;
revoke all on function bl.staff_accept_invites(), bl.staff_revoke(uuid) from public;
grant execute on function bl.staff_accept_invites(), bl.staff_revoke(uuid) to app_api;
comment on function bl.staff_accept_invites() is 'SECURITY DEFINER: привязать приглашения персонала на номер пользователя из контекста.';
comment on function bl.staff_revoke(uuid) is 'SECURITY DEFINER: отозвать доступ сотрудника клуба из контекста: членство, PIN, все токены.';
