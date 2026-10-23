-- 0850 (backend-plus, M4 §1 п. 7–10, §3; решения №136, №137): Бильярдум+.
--
-- * players — профиль игрока: ник (уникален без учёта регистра, без телефона), приватность.
-- * ratings — рейтинг Эло по дисциплине (pyramid, pool, snooker) и сезону: 'all' — общий,
--   'YYYY-MM' — календарный месяц по Москве (1 200 + сумма изменений за месяц).
-- * matches — партия: сессия стола клуба (source session) или матч турнира (source tournament);
--   статусы pending → confirmed → counted | rejected (причина), disputed → решение управляющего.
-- * match_confirmations — подтверждения и споры игроков (только вставка).
-- * rating_history — изменения рейтинга по партиям (только вставка, одна строка на игрока и партию).
-- * friendships, friend_requests — друзья (взаимно, по запросу); lfg — «Ищу соперника»;
--   invites — «Сыграем?»; achievements — достижения (каждое один раз, только вставка).
--
-- Доступ app_api: своё — по bl.ctx_user_id(); партии и подтверждения клуба — по bl.ctx_club_id().
-- Чужие профили, таблицы рейтинга, кандидаты «Ищу соперника», «друзья в клубе» — только узкие
-- функции SECURITY DEFINER (bl_definer) с публичными полями и приватностью в самой функции.
-- Рейтинг пишет только bl.plus_settle_match (bl_definer): засчитывание по правилам T22/T23
-- и пересчёт Эло атомарно и один раз на партию. Время событий — от сервера (ctx.clock).

-- players ----------------------------------------------------------------------------------

create table bl.players (
  user_id uuid primary key references bl.users (id),
  nick text not null check (
    nick ~ '^[0-9A-Za-zА-ЯЁа-яё_-]{3,20}$'
    and length(regexp_replace(nick, '[^0-9]', '', 'g')) <= 6
  ),
  show_history boolean not null default false,
  show_achievements boolean not null default false,
  show_clubs boolean not null default false,
  friends_see_in_club boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create unique index players_nick_key on bl.players (lower(nick));

comment on table bl.players is 'Профиль Бильярдум+: ник и приватность (№137). По умолчанию другим видны только ник, уровень и рейтинг.';

-- ratings ----------------------------------------------------------------------------------

create table bl.ratings (
  user_id uuid not null references bl.users (id),
  discipline text not null check (discipline in ('pyramid', 'pool', 'snooker')),
  season text not null check (season = 'all' or season ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  rating integer not null default 1200 check (rating between -10000 and 10000),
  games integer not null default 0 check (games >= 0),
  wins integer not null default 0 check (wins between 0 and games),
  updated_at timestamptz not null,
  primary key (user_id, discipline, season)
);
create index ratings_table_idx on bl.ratings (discipline, season, rating desc);

comment on table bl.ratings is 'Эло по дисциплине: season all — общий, YYYY-MM — месяц по Москве. Пишет только bl.plus_settle_match.';

-- matches ----------------------------------------------------------------------------------

create table bl.matches (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  source text not null check (source in ('session', 'tournament')),
  session_id uuid,
  resource_id uuid,
  tournament_id uuid,
  tournament_match_id uuid unique,
  discipline text not null check (discipline in ('pyramid', 'pool', 'snooker')),
  player_a uuid not null references bl.users (id),
  player_b uuid not null references bl.users (id),
  score_a smallint not null check (score_a between 0 and 99),
  score_b smallint not null check (score_b between 0 and 99),
  winner_id uuid generated always as (case when score_a > score_b then player_a else player_b end) stored,
  status text not null check (status in ('pending', 'confirmed', 'disputed', 'rejected', 'counted')),
  reject_reason text check (reject_reason in ('pair_daily_limit', 'not_same_session', 'confirm_timeout', 'annulled')),
  multiplier_x10 smallint not null default 10 check (multiplier_x10 in (10, 15)),
  played_at timestamptz not null,
  confirm_until timestamptz,
  counted_at timestamptz,
  created_by uuid references bl.users (id),
  dispute_by uuid references bl.users (id),
  dispute_reason text check (length(btrim(dispute_reason)) between 1 and 500),
  disputed_at timestamptz,
  resolution text check (resolution in ('a', 'b', 'annul')),
  resolved_by uuid references bl.users (id),
  resolved_reason text check (length(btrim(resolved_reason)) between 1 and 2000),
  resolved_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (club_id, id),
  foreign key (club_id, session_id) references bl.sessions (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  check (player_a <> player_b),
  check (score_a <> score_b),
  check ((source = 'session') = (session_id is not null)),
  check (source <> 'session' or confirm_until is not null),
  check (source <> 'tournament' or (tournament_id is not null and tournament_match_id is not null and multiplier_x10 = 15)),
  check (source <> 'session' or multiplier_x10 = 10),
  check ((status = 'rejected') = (reject_reason is not null)),
  check ((status = 'counted') = (counted_at is not null)),
  check ((resolution is null) = (resolved_by is null) and (resolution is null) = (resolved_at is null) and (resolution is null) = (resolved_reason is null)),
  check ((dispute_by is null) = (disputed_at is null) and (dispute_by is null) = (dispute_reason is null))
);
create index matches_session_idx on bl.matches (session_id) where session_id is not null;
create index matches_player_a_idx on bl.matches (player_a, played_at desc);
create index matches_player_b_idx on bl.matches (player_b, played_at desc);
create index matches_club_status_idx on bl.matches (club_id, status);
create index matches_pending_idx on bl.matches (confirm_until) where status = 'pending';
create index matches_pair_counted_idx on bl.matches (least(player_a, player_b), greatest(player_a, player_b), played_at)
  where status = 'counted' and source = 'session';

comment on table bl.matches is 'Партии Бильярдум+ (T22, T23): засчитанная (counted) и отклонённая (rejected) — окончательны; удаление запрещено.';

-- match_confirmations ------------------------------------------------------------------------

create table bl.match_confirmations (
  match_id uuid not null,
  club_id uuid not null,
  user_id uuid not null references bl.users (id),
  decision text not null check (decision in ('confirm', 'dispute')),
  reason text check (length(btrim(reason)) between 1 and 500),
  created_at timestamptz not null,
  primary key (match_id, user_id),
  foreign key (club_id, match_id) references bl.matches (club_id, id),
  check (decision <> 'dispute' or reason is not null)
);

-- rating_history ---------------------------------------------------------------------------

create table bl.rating_history (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null,
  club_id uuid not null,
  user_id uuid not null references bl.users (id),
  opponent_id uuid not null references bl.users (id),
  discipline text not null check (discipline in ('pyramid', 'pool', 'snooker')),
  season text not null check (season ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  result text not null check (result in ('win', 'loss')),
  rating_before integer not null,
  rating_after integer not null,
  delta integer not null,
  k smallint not null check (k in (20, 40)),
  multiplier_x10 smallint not null check (multiplier_x10 in (10, 15)),
  games_before integer not null check (games_before >= 0),
  created_at timestamptz not null,
  unique (match_id, user_id),
  foreign key (club_id, match_id) references bl.matches (club_id, id),
  check (rating_after = rating_before + delta)
);
create index rating_history_user_idx on bl.rating_history (user_id, discipline, created_at desc);
create index rating_history_club_idx on bl.rating_history (club_id, discipline, season, user_id);

-- friendships, friend_requests -------------------------------------------------------------

create table bl.friendships (
  user_id uuid not null references bl.users (id),
  friend_id uuid not null references bl.users (id),
  created_at timestamptz not null,
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
create index friendships_friend_idx on bl.friendships (friend_id);

create table bl.friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references bl.users (id),
  to_user uuid not null references bl.users (id),
  status text not null check (status in ('pending', 'accepted', 'declined', 'canceled')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (from_user <> to_user)
);
create unique index friend_requests_pending_key on bl.friend_requests (from_user, to_user) where status = 'pending';
create index friend_requests_to_idx on bl.friend_requests (to_user) where status = 'pending';
create index friend_requests_from_created_idx on bl.friend_requests (from_user, created_at);

-- lfg («Ищу соперника») -------------------------------------------------------------------

create table bl.lfg (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references bl.users (id),
  discipline text not null check (discipline in ('pyramid', 'pool', 'snooker')),
  from_at timestamptz not null,
  to_at timestamptz not null,
  club_ids uuid[] not null check (cardinality(club_ids) between 1 and 10 and array_position(club_ids, null) is null),
  status text not null check (status in ('open', 'closed')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (to_at > from_at and to_at - from_at <= interval '24 hours')
);
create unique index lfg_open_user_key on bl.lfg (user_id) where status = 'open';
create index lfg_open_idx on bl.lfg (discipline, to_at) where status = 'open';

-- invites («Сыграем?») ----------------------------------------------------------------------

create table bl.invites (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references bl.users (id),
  to_user uuid not null references bl.users (id),
  discipline text not null check (discipline in ('pyramid', 'pool', 'snooker')),
  club_id uuid not null references bl.clubs (id),
  starts_at timestamptz not null,
  minutes integer not null check (minutes between 30 and 360),
  status text not null check (status in ('pending', 'accepted', 'declined', 'canceled')),
  booking_id uuid,
  responded_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (from_user <> to_user),
  check (status <> 'accepted' or booking_id is not null)
);
create index invites_from_created_idx on bl.invites (from_user, created_at);
create index invites_to_idx on bl.invites (to_user, created_at desc);
create unique index invites_pending_pair_key on bl.invites (from_user, to_user) where status = 'pending';

-- achievements ------------------------------------------------------------------------------

create table bl.achievements (
  user_id uuid not null references bl.users (id),
  code text not null check (code in ('dry', 'regular', 'night_shift', 'tournament', 'five_clubs', 'comeback')),
  earned_at timestamptz not null,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  primary key (user_id, code)
);

-- Защита: только вставка, партии не удаляются, итог партии не меняется -------------------------

create function bl.plus_append_only() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'bl.% is append-only: % is forbidden', tg_table_name, tg_op using errcode = '42501';
end
$$;
alter function bl.plus_append_only() owner to bl_owner;
revoke all on function bl.plus_append_only() from public;

create trigger match_confirmations_append_only before update or delete on bl.match_confirmations
  for each row execute function bl.plus_append_only();
create trigger rating_history_append_only before update or delete on bl.rating_history
  for each row execute function bl.plus_append_only();
create trigger achievements_append_only before update or delete on bl.achievements
  for each row execute function bl.plus_append_only();
create trigger matches_no_delete before delete on bl.matches
  for each row execute function bl.plus_append_only();
create trigger plus_no_truncate before truncate on bl.matches
  for each statement execute function bl.plus_append_only();
create trigger plus_no_truncate before truncate on bl.match_confirmations
  for each statement execute function bl.plus_append_only();
create trigger plus_no_truncate before truncate on bl.rating_history
  for each statement execute function bl.plus_append_only();
create trigger plus_no_truncate before truncate on bl.achievements
  for each statement execute function bl.plus_append_only();
alter table bl.match_confirmations enable always trigger match_confirmations_append_only;
alter table bl.rating_history enable always trigger rating_history_append_only;
alter table bl.achievements enable always trigger achievements_append_only;
alter table bl.matches enable always trigger matches_no_delete;

-- Партия: участники, клуб, источник и время не меняются; засчитанная и отклонённая — окончательны;
-- засчитать (counted) и отклонить по лимиту пары может только bl.plus_settle_match (bl_definer).
create function bl.plus_matches_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id is distinct from old.id or new.club_id is distinct from old.club_id or new.source is distinct from old.source
     or new.session_id is distinct from old.session_id or new.resource_id is distinct from old.resource_id
     or new.tournament_id is distinct from old.tournament_id or new.tournament_match_id is distinct from old.tournament_match_id
     or new.discipline is distinct from old.discipline or new.player_a is distinct from old.player_a
     or new.player_b is distinct from old.player_b or new.multiplier_x10 is distinct from old.multiplier_x10
     or new.played_at is distinct from old.played_at or new.confirm_until is distinct from old.confirm_until
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'bl.matches: identity columns are immutable' using errcode = '42501';
  end if;
  if old.status in ('counted', 'rejected') then
    raise exception 'bl.matches: final match is immutable' using errcode = '42501';
  end if;
  if new.status = 'pending' and old.status <> 'pending' then
    raise exception 'bl.matches: status cannot return to pending' using errcode = '42501';
  end if;
  if (new.status = 'counted' or new.reject_reason = 'pair_daily_limit' or new.counted_at is not null)
     and current_user <> 'bl_definer' then
    raise exception 'bl.matches: counted only by bl.plus_settle_match' using errcode = '42501';
  end if;
  if (new.score_a is distinct from old.score_a or new.score_b is distinct from old.score_b) and new.resolution is null then
    raise exception 'bl.matches: score changes only by resolution' using errcode = '42501';
  end if;
  return new;
end
$$;
alter function bl.plus_matches_guard() owner to bl_owner;
revoke all on function bl.plus_matches_guard() from public;
create trigger matches_guard before update on bl.matches for each row execute function bl.plus_matches_guard();
alter table bl.matches enable always trigger matches_guard;

-- Владелец, RLS, права ---------------------------------------------------------------------

alter table bl.players owner to bl_owner;
alter table bl.ratings owner to bl_owner;
alter table bl.matches owner to bl_owner;
alter table bl.match_confirmations owner to bl_owner;
alter table bl.rating_history owner to bl_owner;
alter table bl.friendships owner to bl_owner;
alter table bl.friend_requests owner to bl_owner;
alter table bl.lfg owner to bl_owner;
alter table bl.invites owner to bl_owner;
alter table bl.achievements owner to bl_owner;

alter table bl.players enable row level security;
alter table bl.players force row level security;
alter table bl.ratings enable row level security;
alter table bl.ratings force row level security;
alter table bl.matches enable row level security;
alter table bl.matches force row level security;
alter table bl.match_confirmations enable row level security;
alter table bl.match_confirmations force row level security;
alter table bl.rating_history enable row level security;
alter table bl.rating_history force row level security;
alter table bl.friendships enable row level security;
alter table bl.friendships force row level security;
alter table bl.friend_requests enable row level security;
alter table bl.friend_requests force row level security;
alter table bl.lfg enable row level security;
alter table bl.lfg force row level security;
alter table bl.invites enable row level security;
alter table bl.invites force row level security;
alter table bl.achievements enable row level security;
alter table bl.achievements force row level security;

-- Своё: профиль, рейтинг, достижения, «Ищу соперника».
create policy players_self on bl.players for all to app_api
  using (user_id = bl.ctx_user_id()) with check (user_id = bl.ctx_user_id());
create policy ratings_self on bl.ratings for select to app_api
  using (user_id = bl.ctx_user_id());
create policy achievements_self on bl.achievements for all to app_api
  using (user_id = bl.ctx_user_id()) with check (user_id = bl.ctx_user_id());
create policy lfg_self on bl.lfg for all to app_api
  using (user_id = bl.ctx_user_id()) with check (user_id = bl.ctx_user_id());

-- Партии: клуб из контекста (персонал, обработчики outbox, игроки после перехода в клуб партии)
-- и свои партии игрока в личном контексте; писать — только в контексте клуба партии.
create policy matches_select on bl.matches for select to app_api
  using (club_id = bl.ctx_club_id() or player_a = bl.ctx_user_id() or player_b = bl.ctx_user_id());
create policy matches_insert on bl.matches for insert to app_api
  with check (club_id = bl.ctx_club_id());
create policy matches_update on bl.matches for update to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());

create policy match_confirmations_select on bl.match_confirmations for select to app_api
  using (
    club_id = bl.ctx_club_id()
    or user_id = bl.ctx_user_id()
    or exists (select 1 from bl.matches m where m.id = match_id and (m.player_a = bl.ctx_user_id() or m.player_b = bl.ctx_user_id()))
  );
-- Подтверждает и спорит игрок сам за себя, в контексте клуба партии.
create policy match_confirmations_insert on bl.match_confirmations for insert to app_api
  with check (club_id = bl.ctx_club_id() and user_id = bl.ctx_user_id());

create policy rating_history_select on bl.rating_history for select to app_api
  using (
    user_id = bl.ctx_user_id()
    or club_id = bl.ctx_club_id()
    or exists (select 1 from bl.matches m where m.id = match_id and (m.player_a = bl.ctx_user_id() or m.player_b = bl.ctx_user_id()))
  );

create policy friendships_select on bl.friendships for select to app_api
  using (user_id = bl.ctx_user_id() or friend_id = bl.ctx_user_id());
create policy friendships_insert on bl.friendships for insert to app_api
  with check (user_id = bl.ctx_user_id() or friend_id = bl.ctx_user_id());
create policy friendships_delete on bl.friendships for delete to app_api
  using (user_id = bl.ctx_user_id() or friend_id = bl.ctx_user_id());

create policy friend_requests_select on bl.friend_requests for select to app_api
  using (from_user = bl.ctx_user_id() or to_user = bl.ctx_user_id());
create policy friend_requests_insert on bl.friend_requests for insert to app_api
  with check (from_user = bl.ctx_user_id());
create policy friend_requests_update on bl.friend_requests for update to app_api
  using (from_user = bl.ctx_user_id() or to_user = bl.ctx_user_id())
  with check (from_user = bl.ctx_user_id() or to_user = bl.ctx_user_id());

create policy invites_select on bl.invites for select to app_api
  using (from_user = bl.ctx_user_id() or to_user = bl.ctx_user_id());
create policy invites_insert on bl.invites for insert to app_api
  with check (from_user = bl.ctx_user_id());
create policy invites_update on bl.invites for update to app_api
  using (from_user = bl.ctx_user_id() or to_user = bl.ctx_user_id())
  with check (from_user = bl.ctx_user_id() or to_user = bl.ctx_user_id());

revoke all on bl.players, bl.ratings, bl.matches, bl.match_confirmations, bl.rating_history,
  bl.friendships, bl.friend_requests, bl.lfg, bl.invites, bl.achievements from public;

grant select, insert on bl.players to app_api;
grant update (nick, show_history, show_achievements, show_clubs, friends_see_in_club, updated_at) on bl.players to app_api;
grant select on bl.ratings to app_api;
grant select, insert on bl.matches to app_api;
grant update (status, reject_reason, score_a, score_b, dispute_by, dispute_reason, disputed_at,
  resolution, resolved_by, resolved_reason, resolved_at, updated_at) on bl.matches to app_api;
grant select, insert on bl.match_confirmations to app_api;
grant select on bl.rating_history to app_api;
grant select, insert, delete on bl.friendships to app_api;
grant select, insert on bl.friend_requests to app_api;
grant update (status, updated_at) on bl.friend_requests to app_api;
grant select, insert on bl.lfg to app_api;
grant update (discipline, from_at, to_at, club_ids, status, updated_at) on bl.lfg to app_api;
grant select, insert on bl.invites to app_api;
grant update (status, booking_id, responded_at, updated_at) on bl.invites to app_api;
grant select, insert on bl.achievements to app_api;

-- bl_definer: чтение для узких функций, запись рейтинга и итога партии.
grant select on bl.players, bl.ratings, bl.matches, bl.match_confirmations, bl.rating_history,
  bl.friendships, bl.lfg, bl.achievements to bl_definer;
grant insert, update on bl.ratings to bl_definer;
grant insert on bl.rating_history to bl_definer;
grant update (status, reject_reason, counted_at, updated_at) on bl.matches to bl_definer;
create policy players_definer on bl.players for select to bl_definer using (true);
create policy ratings_definer on bl.ratings for all to bl_definer using (true) with check (true);
create policy matches_definer_select on bl.matches for select to bl_definer using (true);
create policy matches_definer_update on bl.matches for update to bl_definer using (true) with check (true);
create policy match_confirmations_definer on bl.match_confirmations for select to bl_definer using (true);
create policy rating_history_definer_select on bl.rating_history for select to bl_definer using (true);
create policy rating_history_definer_insert on bl.rating_history for insert to bl_definer with check (true);
create policy friendships_definer on bl.friendships for select to bl_definer using (true);
create policy lfg_definer on bl.lfg for select to bl_definer using (true);
create policy achievements_definer on bl.achievements for select to bl_definer using (true);

-- «Друзья в клубе сейчас» (light, 0310): кто в идущей сессии — без денег и платежей.
grant select (session_id, user_id, joined_at) on bl.session_participants to bl_definer;
create policy session_participants_plus_definer on bl.session_participants for select to bl_definer using (true);

-- Узкие функции SECURITY DEFINER ------------------------------------------------------------

-- Итог подтверждённой партии (T22, T23) и пересчёт Эло — атомарно и один раз:
-- * только партия в статусе confirmed; counted — повторный вызов ничего не меняет (applied false);
-- * партия сессии: оба игрока подтвердили до confirm_until (или решение управляющего);
--   не больше 3 засчитанных партий пары за рабочие сутки клуба (day_start_local, по умолчанию
--   06:00 по поясу клуба), четвёртая — rejected с причиной pair_daily_limit;
-- * Эло: E = 1 / (1 + 10^((Rb − Ra)/400)), K = 40 при < 20 партиях дисциплины, иначе 20,
--   Δ = round(K × множитель × (S − E)) (половина — от нуля), множитель 1 или 1,5 (турнир);
--   общий рейтинг и сезон (месяц партии по Москве: 1 200 + сумма Δ).
create function bl.plus_settle_match(p_match uuid, p_now timestamptz)
returns table (status text, reject_reason text, applied boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  m bl.matches%rowtype;
  v_tz text;
  v_ds text;
  v_day date;
  v_from timestamptz;
  v_to timestamptz;
  v_n integer;
  v_season text;
  v_mult numeric;
  ra integer; rb integer; ga integer; gb integer;
  ea numeric; eb numeric; ka integer; kb integer; da integer; db_ integer; sa integer;
begin
  if p_match is null or p_now is null then
    raise exception 'plus_settle_match: arguments' using errcode = '22023';
  end if;
  select * into m from bl.matches x where x.id = p_match for update;
  if not found then
    return;
  end if;
  if m.status <> 'confirmed' then
    return query select m.status, m.reject_reason, false;
    return;
  end if;

  if m.source = 'session' then
    if m.resolution is null then
      select count(*) into v_n from bl.match_confirmations c
       where c.match_id = m.id and c.decision = 'confirm' and c.user_id in (m.player_a, m.player_b)
         and c.created_at <= m.confirm_until;
      if v_n < 2 then
        raise exception 'plus_settle_match: not confirmed by both players' using errcode = '55000';
      end if;
    end if;
    -- Лимит пары: параллельные партии одной пары считаются по очереди.
    perform pg_advisory_xact_lock(hashtextextended('bl.plus.pair:' || least(m.player_a, m.player_b)::text || ':' || greatest(m.player_a, m.player_b)::text, 0));
    select c.timezone, coalesce(nullif(c.settings->>'day_start_local', ''), '06:00') into v_tz, v_ds
      from bl.clubs c where c.id = m.club_id;
    if v_ds !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      v_ds := '06:00';
    end if;
    v_day := ((m.played_at at time zone v_tz) - v_ds::interval)::date;
    v_from := (v_day + v_ds::time) at time zone v_tz;
    v_to := ((v_day + 1) + v_ds::time) at time zone v_tz;
    select count(*) into v_n from bl.matches x
     where x.status = 'counted' and x.source = 'session' and x.id <> m.id
       and least(x.player_a, x.player_b) = least(m.player_a, m.player_b)
       and greatest(x.player_a, x.player_b) = greatest(m.player_a, m.player_b)
       and x.played_at >= v_from and x.played_at < v_to;
    if v_n >= 3 then
      update bl.matches x set status = 'rejected', reject_reason = 'pair_daily_limit', updated_at = p_now where x.id = m.id;
      return query select 'rejected'::text, 'pair_daily_limit'::text, false;
      return;
    end if;
  end if;

  update bl.matches x set status = 'counted', counted_at = p_now, updated_at = p_now where x.id = m.id;

  v_season := to_char(m.played_at at time zone 'Europe/Moscow', 'YYYY-MM');
  v_mult := m.multiplier_x10::numeric / 10;
  insert into bl.ratings (user_id, discipline, season, rating, games, wins, updated_at) values
    (m.player_a, m.discipline, 'all', 1200, 0, 0, p_now),
    (m.player_b, m.discipline, 'all', 1200, 0, 0, p_now),
    (m.player_a, m.discipline, v_season, 1200, 0, 0, p_now),
    (m.player_b, m.discipline, v_season, 1200, 0, 0, p_now)
  on conflict do nothing;
  perform 1 from bl.ratings r
   where r.user_id in (m.player_a, m.player_b) and r.discipline = m.discipline and r.season in ('all', v_season)
   order by r.user_id, r.season
     for update;
  select r.rating, r.games into ra, ga from bl.ratings r where r.user_id = m.player_a and r.discipline = m.discipline and r.season = 'all';
  select r.rating, r.games into rb, gb from bl.ratings r where r.user_id = m.player_b and r.discipline = m.discipline and r.season = 'all';

  sa := case when m.score_a > m.score_b then 1 else 0 end;
  ea := 1 / (1 + power(10::numeric, (rb - ra)::numeric / 400));
  eb := 1 / (1 + power(10::numeric, (ra - rb)::numeric / 400));
  ka := case when ga < 20 then 40 else 20 end;
  kb := case when gb < 20 then 40 else 20 end;
  da := round(ka * v_mult * (sa - ea));
  db_ := round(kb * v_mult * ((1 - sa) - eb));

  insert into bl.rating_history (match_id, club_id, user_id, opponent_id, discipline, season, result,
                                 rating_before, rating_after, delta, k, multiplier_x10, games_before, created_at) values
    (m.id, m.club_id, m.player_a, m.player_b, m.discipline, v_season, case when sa = 1 then 'win' else 'loss' end,
     ra, ra + da, da, ka, m.multiplier_x10, ga, p_now),
    (m.id, m.club_id, m.player_b, m.player_a, m.discipline, v_season, case when sa = 0 then 'win' else 'loss' end,
     rb, rb + db_, db_, kb, m.multiplier_x10, gb, p_now);

  update bl.ratings r set rating = r.rating + da, games = r.games + 1, wins = r.wins + sa, updated_at = p_now
   where r.user_id = m.player_a and r.discipline = m.discipline and r.season in ('all', v_season);
  update bl.ratings r set rating = r.rating + db_, games = r.games + 1, wins = r.wins + (1 - sa), updated_at = p_now
   where r.user_id = m.player_b and r.discipline = m.discipline and r.season in ('all', v_season);

  return query select 'counted'::text, null::text, true;
end
$$;

-- Ник и общий рейтинг по дисциплинам — для списков (участники сессии, друзья, приглашения,
-- посев турнира). Только публичные поля; не больше 500 пользователей за вызов.
create function bl.plus_briefs(p_ids uuid[])
returns table (user_id uuid, nick text, ratings jsonb)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select u.id, p.nick,
         coalesce((select jsonb_object_agg(r.discipline, jsonb_build_object('rating', r.rating, 'games', r.games))
                     from bl.ratings r where r.user_id = u.id and r.season = 'all'), '{}'::jsonb)
    from (select distinct x.id from unnest(p_ids[1:500]) as x(id) where x.id is not null) u
    left join bl.players p on p.user_id = u.id
$$;

-- Пользователь по нику (без учёта регистра) или NULL.
create function bl.plus_user_by_nick(p_nick text)
returns uuid
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select p.user_id from bl.players p where lower(p.nick) = lower(p_nick) and length(p_nick) <= 20
$$;

-- Карточка игрока для зрителя nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid (№137): рейтинги всегда; достижения, история
-- и клубы — только самому игроку или по его выбору; ник соперника в истории — самому игроку,
-- самому сопернику или если соперник открыл историю. Приватность — здесь, не в приложении.
create function bl.plus_card(p_user uuid, p_nick text, p_season text)
returns table (user_id uuid, nick text, is_self boolean, privacy jsonb, ratings jsonb, achievements jsonb, history jsonb)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  with pl as (
    select p.*, (p.user_id = nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid) as me
      from bl.players p
     where (p_user is not null and p.user_id = p_user)
        or (p_user is null and p_nick is not null and lower(p.nick) = lower(p_nick))
     limit 1
  )
  select pl.user_id, pl.nick, coalesce(pl.me, false),
         case when pl.me then jsonb_build_object('show_history', pl.show_history, 'show_achievements', pl.show_achievements,
                                                 'show_clubs', pl.show_clubs, 'friends_see_in_club', pl.friends_see_in_club) end,
         (select jsonb_agg(jsonb_build_object(
                    'discipline', d.discipline,
                    'rating', coalesce(ra.rating, 1200),
                    'games', coalesce(ra.games, 0),
                    'season_rating', coalesce(rs.rating, 1200),
                    'season_games', coalesce(rs.games, 0)) order by d.ord)
            from (values ('pyramid', 1), ('pool', 2), ('snooker', 3)) as d(discipline, ord)
            left join bl.ratings ra on ra.user_id = pl.user_id and ra.discipline = d.discipline and ra.season = 'all'
            left join bl.ratings rs on rs.user_id = pl.user_id and rs.discipline = d.discipline and rs.season = p_season),
         case when pl.me or pl.show_achievements then
           coalesce((select jsonb_agg(jsonb_build_object('code', a.code, 'earned_at', a.earned_at) order by a.earned_at, a.code)
                       from bl.achievements a where a.user_id = pl.user_id), '[]'::jsonb)
         end,
         case when pl.me or pl.show_history then
           coalesce((select jsonb_agg(h.item order by h.at desc) from (
              select m.played_at as at, jsonb_build_object(
                       'match_id', m.id,
                       'discipline', m.discipline,
                       'opponent_nick', case when pl.me or op.user_id = nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid or op.show_history then op.nick end,
                       'my_score', case when m.player_a = pl.user_id then m.score_a else m.score_b end,
                       'opponent_score', case when m.player_a = pl.user_id then m.score_b else m.score_a end,
                       'result', case when m.winner_id = pl.user_id then 'win' else 'loss' end,
                       'delta', rh.delta,
                       'counted', m.status = 'counted',
                       'not_counted_reason', m.reject_reason,
                       'at', m.played_at,
                       'club_name', case when pl.me or pl.show_clubs then c.name end,
                       'tournament', m.source = 'tournament') as item
                from bl.matches m
                join bl.clubs c on c.id = m.club_id
                left join bl.players op on op.user_id = case when m.player_a = pl.user_id then m.player_b else m.player_a end
                left join bl.rating_history rh on rh.match_id = m.id and rh.user_id = pl.user_id
               where (m.player_a = pl.user_id or m.player_b = pl.user_id) and m.status in ('counted', 'rejected')
               order by m.played_at desc
               limit 20) h), '[]'::jsonb)
         end
    from pl
$$;

-- Таблица рейтинга (публичная): ник и рейтинг игроков с партиями в сезоне; p_club_ids — клубы
-- (таблица клуба или города: игроки с засчитанными партиями в этих клубах), NULL — страна.
-- Строки страницы и строка самого зрителя (nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid), если он в таблице.
create function bl.plus_rating_table(p_discipline text, p_season text, p_club_ids uuid[], p_limit integer, p_offset integer)
returns table (place bigint, user_id uuid, nick text, rating integer, games integer)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  with base as (
    select r.user_id, p.nick, r.rating, r.games
      from bl.ratings r
      join bl.players p on p.user_id = r.user_id
     where r.discipline = p_discipline and r.season = p_season and r.games > 0
       and (p_club_ids is null or exists (
             select 1 from bl.rating_history h
              where h.user_id = r.user_id and h.discipline = p_discipline and h.club_id = any (p_club_ids)
                and (p_season = 'all' or h.season = p_season)))
  ), ranked as (
    select row_number() over (order by b.rating desc, b.games desc, lower(b.nick), b.user_id) as place, b.*
      from base b
  )
  select k.place, k.user_id, k.nick, k.rating, k.games
    from ranked k
   where (k.place > greatest(p_offset, 0) and k.place <= greatest(p_offset, 0) + least(greatest(p_limit, 0), 100))
      or k.user_id = nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
   order by k.place
$$;

-- «Друзья в клубе сейчас» для nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid: только друзья, разрешившие это (friends_see_in_club).
create function bl.plus_friends_in_club()
returns table (friend_id uuid, club_id uuid, club_name text, since timestamptz)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select distinct on (f.friend_id) f.friend_id, s.club_id, c.name, sp.joined_at
    from bl.friendships f
    join bl.players p on p.user_id = f.friend_id and p.friends_see_in_club
    join bl.session_participants sp on sp.user_id = f.friend_id
    join bl.sessions s on s.id = sp.session_id and s.status in ('active', 'ending', 'grace')
    join bl.clubs c on c.id = s.club_id
   where f.user_id = nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
   order by f.friend_id, sp.joined_at desc
$$;

-- Кандидаты «Ищу соперника» для nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid: открытые заявки других игроков той же
-- дисциплины, время пересекается, есть общий клуб, рейтинг ±150.
create function bl.plus_lfg_candidates(p_discipline text, p_from timestamptz, p_to timestamptz, p_club_ids uuid[], p_rating integer, p_now timestamptz)
returns table (user_id uuid, nick text, rating integer, club_ids uuid[])
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select l.user_id, p.nick, coalesce(r.rating, 1200), l.club_ids
    from bl.lfg l
    join bl.players p on p.user_id = l.user_id
    left join bl.ratings r on r.user_id = l.user_id and r.discipline = p_discipline and r.season = 'all'
   where nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid is not null and l.user_id <> nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
     and l.status = 'open' and l.discipline = p_discipline and l.to_at > p_now
     and l.from_at < p_to and l.to_at > p_from
     and l.club_ids && p_club_ids
     and abs(coalesce(r.rating, 1200) - p_rating) <= 150
   order by abs(coalesce(r.rating, 1200) - p_rating), l.created_at
   limit 50
$$;

-- Партии, которые ждут подтверждения дольше confirm_until (планировщик plus, все клубы).
create function bl.plus_due(p_now timestamptz, p_limit integer)
returns table (match_id uuid, club_id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select m.id, m.club_id from bl.matches m
   where m.status = 'pending' and m.confirm_until < p_now
   order by m.confirm_until
   limit least(greatest(p_limit, 0), 500)
$$;

alter function bl.plus_settle_match(uuid, timestamptz) owner to bl_definer;
alter function bl.plus_briefs(uuid[]) owner to bl_definer;
alter function bl.plus_user_by_nick(text) owner to bl_definer;
alter function bl.plus_card(uuid, text, text) owner to bl_definer;
alter function bl.plus_rating_table(text, text, uuid[], integer, integer) owner to bl_definer;
alter function bl.plus_friends_in_club() owner to bl_definer;
alter function bl.plus_lfg_candidates(text, timestamptz, timestamptz, uuid[], integer, timestamptz) owner to bl_definer;
alter function bl.plus_due(timestamptz, integer) owner to bl_definer;
revoke all on function bl.plus_settle_match(uuid, timestamptz), bl.plus_briefs(uuid[]), bl.plus_user_by_nick(text),
  bl.plus_card(uuid, text, text), bl.plus_rating_table(text, text, uuid[], integer, integer), bl.plus_friends_in_club(),
  bl.plus_lfg_candidates(text, timestamptz, timestamptz, uuid[], integer, timestamptz), bl.plus_due(timestamptz, integer) from public;
grant execute on function bl.plus_settle_match(uuid, timestamptz), bl.plus_briefs(uuid[]), bl.plus_user_by_nick(text),
  bl.plus_card(uuid, text, text), bl.plus_rating_table(text, text, uuid[], integer, integer), bl.plus_friends_in_club(),
  bl.plus_lfg_candidates(text, timestamptz, timestamptz, uuid[], integer, timestamptz), bl.plus_due(timestamptz, integer) to app_api;

comment on function bl.plus_settle_match(uuid, timestamptz) is 'SECURITY DEFINER: итог подтверждённой партии (лимит пары T23) и Эло один раз на партию.';
comment on function bl.plus_briefs(uuid[]) is 'SECURITY DEFINER: ник и общий рейтинг по дисциплинам (публичные поля).';
comment on function bl.plus_user_by_nick(text) is 'SECURITY DEFINER: пользователь по нику.';
comment on function bl.plus_card(uuid, text, text) is 'SECURITY DEFINER: карточка игрока с приватностью для зрителя из контекста.';
comment on function bl.plus_rating_table(text, text, uuid[], integer, integer) is 'SECURITY DEFINER: таблица рейтинга (ник, рейтинг, партии).';
comment on function bl.plus_friends_in_club() is 'SECURITY DEFINER: друзья в клубе сейчас — только с их разрешения.';
comment on function bl.plus_lfg_candidates(text, timestamptz, timestamptz, uuid[], integer, timestamptz) is 'SECURITY DEFINER: кандидаты «Ищу соперника» (±150).';
comment on function bl.plus_due(timestamptz, integer) is 'SECURITY DEFINER: партии с истёкшим подтверждением (планировщик).';
