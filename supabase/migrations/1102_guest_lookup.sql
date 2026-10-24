-- 1102 (backend, M5.2 №179): «Кто играл за столом» — полный телефон гостя игры только владельцу.
--
-- Персонал гостей в bl.users не видит (маска — bl.user_brief). Полный номер участника игры отдаёт
-- узкая функция bl.guest_phone(session_id, user_id): игра — клуба из контекста, пользователь —
-- участник этой игры, вызывающий (app.user_id) — активный владелец клуба; иначе NULL. Плательщика
-- игры сервер берёт сам (sessions.payer_user_id под RLS клуба): владелец функций столбец
-- плательщика не видит (у bl_definer по-прежнему только sessions(id, club_id, status, is_test)).
-- Причина, журнал guest.lookup и уведомление владельцу — в сервере (api/routes/who-played.mjs)
-- в той же транзакции.

create function bl.guest_phone(p_session_id uuid, p_user_id uuid) returns text
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select u.phone
    from bl.sessions s
    join bl.session_participants sp on sp.session_id = s.id and sp.user_id = p_user_id
    join bl.users u on u.id = sp.user_id
   where s.id = p_session_id
     and s.club_id = bl.ctx_club_id()
     and exists (select 1 from bl.club_members m
                  where m.club_id = s.club_id and m.user_id = bl.ctx_user_id() and m.role = 'owner' and m.active)
$$;
grant execute on function bl.ctx_user_id() to bl_definer;
alter function bl.guest_phone(uuid, uuid) owner to bl_definer;
revoke all on function bl.guest_phone(uuid, uuid) from public;
grant execute on function bl.guest_phone(uuid, uuid) to app_api;
comment on function bl.guest_phone(uuid, uuid) is
  'SECURITY DEFINER (M5.2 №179): полный телефон участника игры клуба из контекста — только активному владельцу клуба, иначе NULL.';
