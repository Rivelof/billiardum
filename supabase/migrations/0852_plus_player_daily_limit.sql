-- 0852 (backend-plus, решение №148): лимит засчитанных партий игрока за сутки.
--
-- У одного игрока не больше 6 засчитанных в рейтинг партий в рабочие сутки клуба партии
-- (day_start_local, по умолчанию 06:00 по поясу клуба) — по всем соперникам и клубам, вдобавок
-- к лимиту пары T23 (3 в сутки). Партия сверх лимита — rejected с причиной player_daily_limit
-- (карточка: «в рейтинг не засчитана — лимит партий за сутки»). Как и лимит пары, только для
-- партий сессий (source = 'session'): турнирные партии лимитами не ограничиваются и в счёт лимита
-- не идут. Гонка параллельных подтверждений: advisory-блокировки обоих игроков (в порядке id)
-- после блокировки пары; подсчёт — после блокировок.

alter table bl.matches drop constraint matches_reject_reason_check;
alter table bl.matches add constraint matches_reject_reason_check
  check (reject_reason in ('pair_daily_limit', 'player_daily_limit', 'not_same_session', 'confirm_timeout', 'annulled'));

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
  if (new.status = 'counted' or new.reject_reason in ('pair_daily_limit', 'player_daily_limit') or new.counted_at is not null)
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
    -- Лимит игрока (№148): параллельные партии одного игрока с разными соперниками — тоже по очереди.
    -- Блокировки игроков — всегда в порядке id (после блокировки пары): без взаимных блокировок.
    perform pg_advisory_xact_lock(hashtextextended('bl.plus.player:' || least(m.player_a, m.player_b)::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('bl.plus.player:' || greatest(m.player_a, m.player_b)::text, 0));
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
    -- №148: у каждого из игроков не больше 6 засчитанных партий сессий за те же рабочие сутки
    -- клуба партии — по всем соперникам и клубам.
    select greatest(count(*) filter (where m.player_a in (x.player_a, x.player_b)),
                    count(*) filter (where m.player_b in (x.player_a, x.player_b)))
      into v_n
      from bl.matches x
     where x.status = 'counted' and x.source = 'session' and x.id <> m.id
       and (x.player_a in (m.player_a, m.player_b) or x.player_b in (m.player_a, m.player_b))
       and x.played_at >= v_from and x.played_at < v_to;
    if v_n >= 6 then
      update bl.matches x set status = 'rejected', reject_reason = 'player_daily_limit', updated_at = p_now where x.id = m.id;
      return query select 'rejected'::text, 'player_daily_limit'::text, false;
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

comment on function bl.plus_settle_match(uuid, timestamptz) is
  'SECURITY DEFINER: итог подтверждённой партии (лимит пары T23, лимит игрока №148) и Эло один раз на партию.';
