-- 0481 (backend-pos, M3): гость пакета часов на кассе — только существующий (decisions №117).
--
-- bl.pos_guest(p_user_id, p_phone) — узкая функция SECURITY DEFINER, только поиск: id учётки гостя
-- по id или по телефону (E.164), если учётка есть, не влита в другую, с телефоном и согласием на
-- обработку данных (bl.consents); иначе NULL. Учётку не создаёт (ресепшн не заводит гостей, 152-ФЗ),
-- отдаёт только id. Отвечает только персоналу кассы: в контексте клуба (app.club_id) и сотруднику
-- этого клуба с ролью reception, manager или owner (app.user_id, активное членство); иначе NULL.

-- Чтение членства для проверки роли (столбцы и политика только на чтение; core 0702 добавляет свои).
grant select (club_id, user_id, role, active) on bl.club_members to bl_definer;
create policy club_members_pos_definer on bl.club_members for select to bl_definer using (true);

create function bl.pos_guest(p_user_id uuid, p_phone text) returns uuid
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select u.id
    from bl.users u
   where exists (
           select 1 from bl.club_members m
            where m.club_id = nullif(pg_catalog.current_setting('app.club_id', true), '')::uuid
              and m.user_id = nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
              and m.active and m.role in ('reception', 'manager', 'owner'))
     and ((p_user_id is not null and p_phone is null and u.id = p_user_id)
          or (p_user_id is null and p_phone ~ '^\+[1-9][0-9]{7,14}$' and u.phone = p_phone))
     and u.merged_into is null
     and u.phone is not null
     and exists (select 1 from bl.consents c where c.user_id = u.id)
   limit 1
$$;

alter function bl.pos_guest(uuid, text) owner to bl_definer;
revoke all on function bl.pos_guest(uuid, text) from public;
grant execute on function bl.pos_guest(uuid, text) to app_api;

comment on function bl.pos_guest(uuid, text) is
  'SECURITY DEFINER, только поиск: id существующего гостя (не влит, с телефоном и согласием) по id или телефону — персоналу кассы клуба из контекста; иначе NULL. Учётку не создаёт (№117).';
