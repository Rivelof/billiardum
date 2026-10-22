-- 0706 (backend-core, решение №130 п. 11, 15; ревью входа п. 5).
--
-- * staff_revoke: гаснут PIN-токены этого клуба; личные токены — только если у пользователя
--   не осталось других активных членств (сотрудник другого клуба не теряет вход там).
--   Терминалы, заведённые сотрудником в этом клубе, отзывает вызывающий (server/staff).
-- * summary_clubs: только активные клубы.
-- * Терминалы: общий счётчик неверных PIN на терминал — 10 за час, и терминал блокируется
--   для входа по PIN до разблокировки владельцем (тревога terminal_locked).

create or replace function bl.staff_revoke(p_user_id uuid)
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
  update bl.auth_tokens t set revoked_at = now()
   where t.user_id = p_user_id and t.revoked_at is null
     and (t.club_id = v_club
          or (t.club_id is null and not exists (
                select 1 from bl.club_members m
                 where m.user_id = p_user_id and m.active and m.club_id <> v_club)));
  get diagnostics v_n = row_count;
  return v_n;
end
$$;
comment on function bl.staff_revoke(uuid) is
  'SECURITY DEFINER: отозвать доступ сотрудника клуба из контекста: членство, PIN, PIN-токены клуба; личные токены — если других членств нет.';

create or replace function bl.summary_clubs()
returns table (club_id uuid, timezone text, day_start_local text, summary_time_local text)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select c.id, c.timezone,
         coalesce(nullif(c.settings->>'day_start_local', ''), '06:00'),
         coalesce(nullif(c.settings->>'summary_time_local', ''), '10:00')
    from bl.clubs c
   where c.active
   order by c.id
$$;

alter table bl.staff_terminals
  add column pin_failed_count integer not null default 0 check (pin_failed_count >= 0),
  add column pin_window_started_at timestamptz,
  add column locked_at timestamptz;

grant update (pin_failed_count, pin_window_started_at, locked_at) on bl.staff_terminals to app_api;

comment on column bl.staff_terminals.pin_failed_count is 'Неверные PIN на терминале в текущем окне (час).';
comment on column bl.staff_terminals.locked_at is 'Вход по PIN на терминале заблокирован (10 ошибок за час) до разблокировки владельцем.';
