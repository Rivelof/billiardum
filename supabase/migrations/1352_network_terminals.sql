-- 1352 (backend, M5.5, находка pentester Н-2): терминалы управляющего сети гаснут вместе с его доступом.
--
-- bl.network_sync_access гасил членство и PIN-токены управляющего сети, но не терминалы ресепшена,
-- заведённые им в клубе (токен терминала живёт 365 дней): обычный отзыв сотрудника их гасит
-- (server/staff.revoke). Теперь вывод клуба из сети, отзыв управляющего и архив сети (все три идут
-- через bl.network_sync_access) отзывают терминалы клуба, заведённые этим пользователем, пока он
-- держал доступ от сети: затрагиваются только строки club_members с network_id этой сети, прямое
-- членство в клубе (network_id пуст) не трогается. PIN-токены других сотрудников на этом терминале
-- перестают работать сами: bl.auth_resolve проверяет, что терминал не отозван.
-- Функция остаётся bl_definer с закреплённым search_path; права bl_definer — только точные столбцы.

grant select (created_by) on bl.staff_terminals to bl_definer;
grant update (revoked_at) on bl.staff_terminals to bl_definer;
create policy staff_terminals_definer_update on bl.staff_terminals for update to bl_definer using (true) with check (true);

create or replace function bl.network_sync_access(p_network uuid) returns integer
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_n integer := 0;
  v_k integer;
  v_live boolean;
  r record;
begin
  select n.archived_at is null into v_live from bl.networks n where n.id = p_network;
  -- Выдать.
  if coalesce(v_live, false) then
    for r in
      select c.club_id, m.user_id
        from bl.network_clubs c
        join bl.network_members m on m.network_id = c.network_id and m.accepted_at is not null and m.revoked_at is null
       where c.network_id = p_network and c.active
    loop
      insert into bl.club_members (club_id, user_id, role, network_id, active)
      values (r.club_id, r.user_id, 'manager', p_network, true)
      on conflict (club_id, user_id) do update
        set role = 'manager', active = true, network_id = excluded.network_id, pin_hash = null
        where not bl.club_members.active;
      get diagnostics v_k = row_count;
      v_n := v_n + v_k;
    end loop;
  end if;
  -- Снять лишнее.
  for r in
    select cm.club_id, cm.user_id
      from bl.club_members cm
     where cm.network_id = p_network and cm.active
       and not (coalesce(v_live, false)
                and exists (select 1 from bl.network_clubs c where c.network_id = p_network and c.club_id = cm.club_id and c.active)
                and exists (select 1 from bl.network_members m where m.network_id = p_network and m.user_id = cm.user_id
                              and m.accepted_at is not null and m.revoked_at is null))
  loop
    update bl.club_members
       set active = false, network_id = null, pin_hash = null, pin_failed_count = 0, pin_locked_until = null
     where club_id = r.club_id and user_id = r.user_id;
    update bl.auth_tokens set revoked_at = now()
     where user_id = r.user_id and club_id = r.club_id and kind = 'pin' and revoked_at is null;
    -- Терминалы клуба, заведённые этим управляющим (1352, Н-2).
    update bl.staff_terminals set revoked_at = now()
     where club_id = r.club_id and created_by = r.user_id and revoked_at is null;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;
