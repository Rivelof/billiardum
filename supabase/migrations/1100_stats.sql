-- 1100 (backend, M5.2): суточные агрегаты дашборда владельца (docs/contracts/m5-2.md, решения №166–172).
--
-- * bl.stats_daily — клуб × рабочие сутки (с day_start_local, пояс клуба): итоги суток числами
--   (выручка, возвраты, игр, минуты игры, ёмкость) и вся структура суток в data (jsonb). Формулы —
--   server/dashboard (те же запросы денег, что у отчёта смены и утренней сводки, №168).
-- * bl.stats_hourly — клуб × стол × рабочие сутки × местный час: минуты игры, сервиса, брони,
--   ёмкость и число начатых игр. №187: игра (количество) — в сутках начала, минуты — фактические
--   внутри каждых суток.
-- * bl.stats_dirty — «грязные» закрытые сутки: в них пришёл возврат, подтверждение или списание
--   платежа, закрылась сессия, сервис, бронь, тревога. Отметку ставит триггер (ниже), снимает
--   функция записи суток, если отметку не обновили во время пересчёта (gen).
--
-- Пишет агрегаты только узкая функция bl.stats_put_day (SECURITY DEFINER, клуб из контекста,
-- только actor_type system — планировщик), app_api только читает (№169). RLS по club_id,
-- ENABLE и FORCE (№12). Записи is_test в агрегаты не входят (это обеспечивают запросы сервера).

create table bl.stats_daily (
  club_id uuid not null references bl.clubs (id),
  day date not null,
  version smallint not null check (version between 1 and 1000),
  computed_at timestamptz not null default now(),
  revenue_total_kopecks bigint not null check (revenue_total_kopecks >= 0),
  refunds_kopecks bigint not null check (refunds_kopecks >= 0),
  net_kopecks bigint not null,
  games integer not null check (games >= 0),
  play_minutes integer not null check (play_minutes >= 0),
  capacity_minutes bigint not null check (capacity_minutes >= 0),
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 1048576),
  primary key (club_id, day),
  check (net_kopecks = revenue_total_kopecks - refunds_kopecks)
);

create table bl.stats_hourly (
  club_id uuid not null,
  day date not null,
  resource_id uuid not null,
  hour smallint not null check (hour between 0 and 23),
  play_minutes integer not null default 0 check (play_minutes between 0 and 100000),
  service_minutes integer not null default 0 check (service_minutes between 0 and 100000),
  booking_minutes integer not null default 0 check (booking_minutes between 0 and 100000),
  capacity_minutes integer not null default 0 check (capacity_minutes between 0 and 120),
  games integer not null default 0 check (games between 0 and 10000),
  primary key (club_id, day, resource_id, hour),
  foreign key (club_id, day) references bl.stats_daily (club_id, day) on delete cascade,
  foreign key (club_id, resource_id) references bl.resources (club_id, id)
);
create index stats_hourly_resource_idx on bl.stats_hourly (club_id, resource_id, day);

create table bl.stats_dirty (
  club_id uuid not null references bl.clubs (id),
  day date not null,
  gen bigint not null default 1 check (gen >= 1),
  marked_at timestamptz not null default now(),
  primary key (club_id, day)
);

comment on table bl.stats_daily is 'Дашборд (M5.2 №169): итоги закрытых рабочих суток клуба; пишет только bl.stats_put_day.';
comment on table bl.stats_hourly is 'Дашборд (M5.2 №169): минуты игры, сервиса, брони и ёмкость по столу и местному часу суток.';
comment on table bl.stats_dirty is 'Дашборд (M5.2 №169): закрытые сутки, которые нужно пересчитать (поздний возврат, исправление).';

alter table bl.stats_daily owner to bl_owner;
alter table bl.stats_hourly owner to bl_owner;
alter table bl.stats_dirty owner to bl_owner;

alter table bl.stats_daily enable row level security;
alter table bl.stats_daily force row level security;
alter table bl.stats_hourly enable row level security;
alter table bl.stats_hourly force row level security;
alter table bl.stats_dirty enable row level security;
alter table bl.stats_dirty force row level security;

-- app_api — только чтение своего клуба.
create policy stats_daily_app on bl.stats_daily for select to app_api using (club_id = bl.ctx_club_id());
create policy stats_hourly_app on bl.stats_hourly for select to app_api using (club_id = bl.ctx_club_id());
create policy stats_dirty_app on bl.stats_dirty for select to app_api using (club_id = bl.ctx_club_id());

-- bl_definer (функция записи суток) — только клуб из контекста.
create policy stats_daily_definer on bl.stats_daily for all to bl_definer
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy stats_hourly_definer on bl.stats_hourly for all to bl_definer
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
-- Отметку ставит триггер в любом контексте записи (вебхук платформы, outbox), снимает — функция
-- записи суток в контексте клуба.
create policy stats_dirty_definer_mark on bl.stats_dirty for select to bl_definer using (true);
create policy stats_dirty_definer_insert on bl.stats_dirty for insert to bl_definer with check (true);
create policy stats_dirty_definer_update on bl.stats_dirty for update to bl_definer using (true) with check (true);
create policy stats_dirty_definer_delete on bl.stats_dirty for delete to bl_definer using (club_id = bl.ctx_club_id());

revoke all on bl.stats_daily, bl.stats_hourly, bl.stats_dirty from public;
grant select on bl.stats_daily, bl.stats_hourly, bl.stats_dirty to app_api;
grant select, insert, update, delete on bl.stats_daily, bl.stats_hourly to bl_definer;
grant select, insert, update, delete on bl.stats_dirty to bl_definer;
-- Функции контекста — для политик и проверок в узких функциях дашборда.
grant execute on function bl.ctx_club_id(), bl.ctx_actor_type() to bl_definer;
-- Начало истории клуба для догоняющего пересчёта.
grant select (created_at, active) on bl.clubs to bl_definer;

-- Индексы под выборки суток (время в UTC, клуб — первым).
create index if not exists payments_club_confirmed_idx on bl.payments (club_id, confirmed_at) where confirmed_at is not null;
create index if not exists refunds_club_created_idx on bl.refunds (club_id, created_at);
create index if not exists sessions_club_started_idx on bl.sessions (club_id, started_at);
create index if not exists resource_holds_club_service_idx on bl.resource_holds (club_id, created_at) where kind = 'service';
create index if not exists alarms_club_raised_idx on bl.alarms (club_id, raised_at);
create index if not exists device_commands_club_created_idx on bl.device_commands (club_id, created_at);

-- Рабочие сутки момента ts в клубе: местная дата минус day_start_local (06:00 по умолчанию).
create function bl.stats_day_of(p_ts timestamptz, p_tz text, p_day_start text) returns date
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select ((p_ts at time zone p_tz) - (coalesce(nullif(p_day_start, ''), '06:00')::time - time '00:00'))::date
$$;
alter function bl.stats_day_of(timestamptz, text, text) owner to bl_owner;
revoke all on function bl.stats_day_of(timestamptz, text, text) from public;
grant execute on function bl.stats_day_of(timestamptz, text, text) to app_api, bl_definer;

-- Триггер отметки: закрытые сутки (раньше текущих рабочих суток клуба по часам базы) от p_from до p_to.
-- Ошибка отметки не мешает записи денег и сессий: предупреждение в лог Postgres, запись идёт.
create function bl.stats_mark_dirty() returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_club uuid;
  v_tz text;
  v_ds text;
  v_today date;
  v_ranges tstzrange[] := '{}';
  v_r tstzrange;
  v_d1 date;
  v_d2 date;
begin
  begin
    v_club := new.club_id;
    if tg_table_name = 'payments' then
      if new.is_test then return null; end if;
      if new.confirmed_at is not null then v_ranges := v_ranges || tstzrange(new.confirmed_at, new.confirmed_at, '[]'); end if;
      if tg_op = 'UPDATE' and old.confirmed_at is not null then v_ranges := v_ranges || tstzrange(old.confirmed_at, old.confirmed_at, '[]'); end if;
    elsif tg_table_name = 'refunds' then
      if new.is_test then return null; end if;
      v_ranges := v_ranges || tstzrange(new.created_at, new.created_at, '[]');
    elsif tg_table_name = 'sessions' then
      if new.is_test then return null; end if;
      v_ranges := v_ranges || tstzrange(new.started_at, greatest(new.started_at, coalesce(new.ended_at, new.interrupted_at, new.started_at)), '[]');
      if tg_op = 'UPDATE' then
        v_ranges := v_ranges || tstzrange(old.started_at, greatest(old.started_at, coalesce(old.ended_at, old.interrupted_at, old.started_at)), '[]');
      end if;
    elsif tg_table_name = 'resource_holds' then
      if new.kind <> 'service' then return null; end if;
      v_ranges := v_ranges || tstzrange(new.created_at, greatest(new.created_at, coalesce(new.released_at, new.until)), '[]');
    elsif tg_table_name = 'bookings' then
      if new.is_test then return null; end if;
      v_ranges := v_ranges || tstzrange(new.starts_at, greatest(new.starts_at, new.ends_at), '[]') || tstzrange(new.created_at, new.created_at, '[]');
    elsif tg_table_name = 'alarms' then
      v_ranges := v_ranges || tstzrange(new.raised_at, new.raised_at, '[]');
    else
      return null;
    end if;
    if cardinality(v_ranges) = 0 then return null; end if;
    select c.timezone, c.settings->>'day_start_local' into v_tz, v_ds from bl.clubs c where c.id = v_club;
    if v_tz is null then return null; end if;
    v_today := bl.stats_day_of(now(), v_tz, v_ds);
    foreach v_r in array v_ranges loop
      v_d1 := bl.stats_day_of(lower(v_r), v_tz, v_ds);
      v_d2 := least(bl.stats_day_of(upper(v_r), v_tz, v_ds), v_today - 1, v_d1 + 62);
      if v_d1 <= v_d2 then
        insert into bl.stats_dirty (club_id, day, gen, marked_at)
        select v_club, d::date, 1, clock_timestamp() from generate_series(v_d1, v_d2, interval '1 day') d
        on conflict (club_id, day) do update set gen = bl.stats_dirty.gen + 1, marked_at = excluded.marked_at;
      end if;
    end loop;
  exception when others then
    raise warning 'bl.stats_mark_dirty: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end
$$;
alter function bl.stats_mark_dirty() owner to bl_definer;
revoke all on function bl.stats_mark_dirty() from public;
comment on function bl.stats_mark_dirty() is 'SECURITY DEFINER (триггер, M5.2 №169): отметить закрытые сутки клуба к пересчёту дашборда.';

create trigger stats_dirty_mark after insert or update on bl.payments for each row execute function bl.stats_mark_dirty();
create trigger stats_dirty_mark after insert or update on bl.refunds for each row execute function bl.stats_mark_dirty();
create trigger stats_dirty_mark after insert or update on bl.sessions for each row execute function bl.stats_mark_dirty();
create trigger stats_dirty_mark after insert or update on bl.resource_holds for each row execute function bl.stats_mark_dirty();
create trigger stats_dirty_mark after insert or update on bl.bookings for each row execute function bl.stats_mark_dirty();
create trigger stats_dirty_mark after insert or update on bl.alarms for each row execute function bl.stats_mark_dirty();

-- Клубы для планировщика (контекст платформы клубов не видит): пояс, начало суток, начало истории.
create function bl.stats_clubs()
returns table (club_id uuid, timezone text, day_start_local text, created_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select c.id, c.timezone, coalesce(nullif(c.settings->>'day_start_local', ''), '06:00'), c.created_at
    from bl.clubs c
   where c.active
   order by c.id
$$;
alter function bl.stats_clubs() owner to bl_definer;
revoke all on function bl.stats_clubs() from public;
grant execute on function bl.stats_clubs() to app_api;
comment on function bl.stats_clubs() is 'SECURITY DEFINER (M5.2): активные клубы с поясом, началом рабочих суток и созданием — планировщик дашборда.';

-- Записать сутки клуба из контекста (только планировщик, actor_type system): итоги, часы, снять
-- отметку «грязных», если её не обновили после чтения (gen ≤ p_gen).
create function bl.stats_put_day(p_day date, p_gen bigint, p_version smallint, p_daily jsonb, p_hourly jsonb) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_club uuid := bl.ctx_club_id();
  t jsonb;
begin
  if v_club is null or bl.ctx_actor_type() is distinct from 'system' then
    raise exception 'bl.stats_put_day: only scheduler in club context' using errcode = 'insufficient_privilege';
  end if;
  if p_day is null or p_version is null or jsonb_typeof(p_daily) is distinct from 'object' or jsonb_typeof(p_hourly) is distinct from 'array'
     or jsonb_array_length(p_hourly) > 24 * 500 then
    raise exception 'bl.stats_put_day: bad arguments' using errcode = 'check_violation';
  end if;
  t := p_daily->'totals';
  insert into bl.stats_daily (club_id, day, version, computed_at, revenue_total_kopecks, refunds_kopecks, net_kopecks,
                              games, play_minutes, capacity_minutes, data)
  values (v_club, p_day, p_version, now(), (t->>'revenue_total_kopecks')::bigint, (t->>'refunds_kopecks')::bigint,
          (t->>'net_kopecks')::bigint, (t->>'games')::integer, (t->>'play_minutes')::integer, (t->>'capacity_minutes')::bigint, p_daily)
  on conflict (club_id, day) do update
    set version = excluded.version, computed_at = excluded.computed_at, revenue_total_kopecks = excluded.revenue_total_kopecks,
        refunds_kopecks = excluded.refunds_kopecks, net_kopecks = excluded.net_kopecks, games = excluded.games,
        play_minutes = excluded.play_minutes, capacity_minutes = excluded.capacity_minutes, data = excluded.data;
  delete from bl.stats_hourly where club_id = v_club and day = p_day;
  insert into bl.stats_hourly (club_id, day, resource_id, hour, play_minutes, service_minutes, booking_minutes, capacity_minutes, games)
  select v_club, p_day, h.resource_id, h.hour, coalesce(h.play_minutes, 0), coalesce(h.service_minutes, 0), coalesce(h.booking_minutes, 0),
         coalesce(h.capacity_minutes, 0), coalesce(h.games, 0)
    from jsonb_to_recordset(p_hourly) as h(resource_id uuid, hour smallint, play_minutes integer, service_minutes integer,
                                         booking_minutes integer, capacity_minutes integer, games integer);
  delete from bl.stats_dirty where club_id = v_club and day = p_day and gen <= coalesce(p_gen, 0);
end
$$;
alter function bl.stats_put_day(date, bigint, smallint, jsonb, jsonb) owner to bl_definer;
revoke all on function bl.stats_put_day(date, bigint, smallint, jsonb, jsonb) from public;
grant execute on function bl.stats_put_day(date, bigint, smallint, jsonb, jsonb) to app_api;
comment on function bl.stats_put_day(date, bigint, smallint, jsonb, jsonb) is
  'SECURITY DEFINER (M5.2 №169): записать агрегаты рабочих суток клуба из контекста; только actor_type system (планировщик).';
