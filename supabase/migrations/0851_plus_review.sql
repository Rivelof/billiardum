-- 0851 (backend-plus, решения №144–146): правки Бильярдум+ по ревью M4.
--
-- * №144: таблицы рейтинга клуба и города — только игроки, открывшие клубы (players.show_clubs);
--   таблица страны — все игроки с партиями.
-- * №145: «Камбэк» в M4 не выдаётся (нет хода счёта внутри партии): кода comeback нет.
-- * №146: исправление счёта турнирного матча организатором — tournament.match_finished с revision > 0.
--   bl.plus_correct_match: прежнее изменение рейтинга этой партии откатывается записью-коррекцией
--   (rating_history kind = 'reversal'; история только дополняется), затем применяется новый результат
--   (kind = 'match' новой ревизии). Идемпотентно по (match_id, revision); старые ревизии не применяются.
--   Откат — ровно на прежнюю дельту (рейтинг, партии, победы общего и сезонного рейтинга); партии,
--   сыгранные после, не пересчитываются.

-- №146: ревизии турнирного матча ---------------------------------------------------------------

alter table bl.matches add column revision integer not null default 0 check (revision >= 0);
alter table bl.matches add constraint matches_revision_tournament check (revision = 0 or source = 'tournament');
grant update (score_a, score_b, revision, counted_at) on bl.matches to bl_definer;

alter table bl.rating_history
  add column revision integer not null default 0 check (revision >= 0),
  add column kind text not null default 'match' check (kind in ('match', 'reversal'));
alter table bl.rating_history drop constraint rating_history_match_id_user_id_key;
alter table bl.rating_history add constraint rating_history_match_user_revision_kind_key unique (match_id, user_id, revision, kind);

-- №144 ----------------------------------------------------------------------------------------

create or replace function bl.plus_rating_table(p_discipline text, p_season text, p_club_ids uuid[], p_limit integer, p_offset integer)
returns table (place bigint, user_id uuid, nick text, rating integer, games integer)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  with base as (
    select r.user_id, p.nick, r.rating, r.games
      from bl.ratings r
      join bl.players p on p.user_id = r.user_id
     where r.discipline = p_discipline and r.season = p_season and r.games > 0
       and (p_club_ids is null or (p.show_clubs and exists (
             select 1 from bl.rating_history h
              where h.user_id = r.user_id and h.discipline = p_discipline and h.club_id = any (p_club_ids)
                and h.kind = 'match' and (p_season = 'all' or h.season = p_season))))
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

comment on function bl.plus_rating_table(text, text, uuid[], integer, integer) is
  'SECURITY DEFINER: таблица рейтинга (ник, рейтинг, партии); клуб и город — только игроки с show_clubs.';

-- №145 ----------------------------------------------------------------------------------------

alter table bl.achievements drop constraint achievements_code_check;
alter table bl.achievements add constraint achievements_code_check
  check (code in ('dry', 'regular', 'night_shift', 'tournament', 'five_clubs'));

-- №146: защита партии, засчитывание с ревизией, карточка (дельта текущей ревизии), коррекция ---

create or replace function bl.plus_matches_guard() returns trigger
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
  -- Коррекция турнирного матча (№146): только bl.plus_correct_match, ревизия растёт.
  if new.revision is distinct from old.revision then
    if current_user <> 'bl_definer' or old.source <> 'tournament' or new.revision <= old.revision then
      raise exception 'bl.matches: revision only by bl.plus_correct_match' using errcode = '42501';
    end if;
    return new;
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

create or replace function bl.plus_settle_match(p_match uuid, p_now timestamptz)
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
                                 rating_before, rating_after, delta, k, multiplier_x10, games_before, created_at, revision, kind) values
    (m.id, m.club_id, m.player_a, m.player_b, m.discipline, v_season, case when sa = 1 then 'win' else 'loss' end,
     ra, ra + da, da, ka, m.multiplier_x10, ga, p_now, m.revision, 'match'),
    (m.id, m.club_id, m.player_b, m.player_a, m.discipline, v_season, case when sa = 0 then 'win' else 'loss' end,
     rb, rb + db_, db_, kb, m.multiplier_x10, gb, p_now, m.revision, 'match');

  update bl.ratings r set rating = r.rating + da, games = r.games + 1, wins = r.wins + sa, updated_at = p_now
   where r.user_id = m.player_a and r.discipline = m.discipline and r.season in ('all', v_season);
  update bl.ratings r set rating = r.rating + db_, games = r.games + 1, wins = r.wins + (1 - sa), updated_at = p_now
   where r.user_id = m.player_b and r.discipline = m.discipline and r.season in ('all', v_season);

  return query select 'counted'::text, null::text, true;
end
$$;

create or replace function bl.plus_card(p_user uuid, p_nick text, p_season text)
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
                left join bl.rating_history rh on rh.match_id = m.id and rh.user_id = pl.user_id and rh.revision = m.revision and rh.kind = 'match'
               where (m.player_a = pl.user_id or m.player_b = pl.user_id) and m.status in ('counted', 'rejected')
               order by m.played_at desc
               limit 20) h), '[]'::jsonb)
         end
    from pl
$$;

-- Коррекция турнирного матча (№146): новая ревизия → откат прежнего изменения и новый результат.
-- Возвращает applied = false для старой или той же ревизии (повтор события).
create function bl.plus_correct_match(p_match uuid, p_revision integer, p_score_a integer, p_score_b integer, p_now timestamptz)
returns table (status text, reject_reason text, applied boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  m bl.matches%rowtype;
  h record;
  cur record;
begin
  if p_match is null or p_revision is null or p_now is null or p_score_a is null or p_score_b is null
     or p_score_a = p_score_b or p_score_a not between 0 and 99 or p_score_b not between 0 and 99 then
    raise exception 'plus_correct_match: arguments' using errcode = '22023';
  end if;
  select * into m from bl.matches x where x.id = p_match for update;
  if not found then
    return;
  end if;
  if m.source <> 'tournament' then
    raise exception 'plus_correct_match: only tournament matches' using errcode = '55000';
  end if;
  if p_revision <= m.revision then
    return query select m.status, m.reject_reason, false;
    return;
  end if;
  if m.status = 'counted' then
    -- Откат прежней ревизии: по строкам kind = 'match' ревизии m.revision, по одной на игрока.
    for h in
      select * from bl.rating_history r where r.match_id = m.id and r.revision = m.revision and r.kind = 'match' order by r.user_id
    loop
      perform 1 from bl.ratings r
       where r.user_id = h.user_id and r.discipline = h.discipline and r.season in ('all', h.season)
       order by r.season
         for update;
      select r.rating, r.games into cur from bl.ratings r where r.user_id = h.user_id and r.discipline = h.discipline and r.season = 'all';
      insert into bl.rating_history (match_id, club_id, user_id, opponent_id, discipline, season, result,
                                     rating_before, rating_after, delta, k, multiplier_x10, games_before, created_at, revision, kind)
      values (h.match_id, h.club_id, h.user_id, h.opponent_id, h.discipline, h.season, h.result,
              cur.rating, cur.rating - h.delta, -h.delta, h.k, h.multiplier_x10, cur.games, p_now, p_revision, 'reversal');
      update bl.ratings r
         set rating = r.rating - h.delta,
             games = greatest(r.games - 1, 0),
             wins = greatest(r.wins - case when h.result = 'win' then 1 else 0 end, 0),
             updated_at = p_now
       where r.user_id = h.user_id and r.discipline = h.discipline and r.season in ('all', h.season);
    end loop;
  end if;
  update bl.matches x
     set score_a = p_score_a, score_b = p_score_b, revision = p_revision,
         status = 'confirmed', counted_at = null, updated_at = p_now
   where x.id = m.id;
  return query select s.status, s.reject_reason, s.applied from bl.plus_settle_match(m.id, p_now) s;
end
$$;

alter function bl.plus_correct_match(uuid, integer, integer, integer, timestamptz) owner to bl_definer;
revoke all on function bl.plus_correct_match(uuid, integer, integer, integer, timestamptz) from public;
grant execute on function bl.plus_correct_match(uuid, integer, integer, integer, timestamptz) to app_api;
comment on function bl.plus_correct_match(uuid, integer, integer, integer, timestamptz) is
  'SECURITY DEFINER: исправление счёта турнирного матча (№146) — откат прежнего изменения рейтинга и новый результат, один раз на ревизию.';
