-- 0330 (backend-light): срок выбора после interrupted (decisions №65).
--
-- Гость выбирает «Продолжить» или «Вернуть» 24 часа; затем планировщик сам возвращает
-- деньги за неотыгранное время. Для этого после перезапуска сервера планировщик должен
-- найти и прерванные сессии: bl.light_open_sessions() возвращает и их.

create or replace function bl.light_open_sessions()
returns table (session_id uuid, club_id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select s.id, s.club_id from bl.sessions s
   where s.status in ('active', 'ending', 'grace', 'interrupted')
$$;

alter function bl.light_open_sessions() owner to bl_definer;
revoke all on function bl.light_open_sessions() from public;
grant execute on function bl.light_open_sessions() to app_api;

comment on function bl.light_open_sessions() is 'SECURITY DEFINER: (session_id, club_id) сессий, которым нужен планировщик (идут или ждут выбора после interrupted). Только планировщик.';

create index sessions_interrupted_idx on bl.sessions (interrupted_at) where status = 'interrupted';
