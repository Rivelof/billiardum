-- 1250 (backend, M5.6 №198): обслуживание столов — журнал событий, расход в кассе управляющего,
-- уведомления о пороге часов игры (docs/contracts/m5-5-8.md, server/maintenance).
--
-- * bl.maintenance_events — события обслуживания стола: вид (cloth — сукно, balls — шары,
--   cushions — резина бортов, leveling — выравнивание, other — другое), рабочие сутки события,
--   комментарий, стоимость в копейках, кто отметил. Только добавление (UPDATE, DELETE и TRUNCATE
--   запрещены триггерами всем ролям); исправление — новая запись со ссылкой corrects_id на
--   исправляемую и причиной (одна на запись), void — исправление «события не было».
-- * bl.cashbook_entries.maintenance_event_id — расход кассы управляющего (статья «Ремонт столов»)
--   по событию со стоимостью > 0: одна действующая запись на событие (уникальный индекс), сторно
--   несёт ту же ссылку.
-- * bl.maintenance_alerts — отметка «уведомление о пороге отправлено»: одна на (стол, вид,
--   последнее событие вида, порог в часах). Только добавление.
-- Пороги по виду — clubs.settings.maintenance_thresholds (по умолчанию — server/maintenance).
-- RLS по club_id, ENABLE и FORCE (№12).

create table bl.maintenance_events (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  resource_id uuid not null,
  kind text not null check (kind in ('cloth', 'balls', 'cushions', 'leveling', 'other')),
  occurred_on date not null,
  comment text check (length(btrim(comment)) between 1 and 500),
  cost_kopecks bigint not null default 0 check (cost_kopecks between 0 and 100000000000),
  corrects_id uuid,
  reason text check (length(btrim(reason)) between 1 and 2000),
  voided boolean not null default false,
  created_by uuid references bl.users (id),
  created_at timestamptz not null,
  unique (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  foreign key (club_id, corrects_id) references bl.maintenance_events (club_id, id),
  check ((corrects_id is null) = (reason is null)),
  check (not voided or (corrects_id is not null and cost_kopecks = 0)),
  check (corrects_id is distinct from id)
);
-- Одно исправление на запись: второе (в том числе параллельное) упирается в индекс.
create unique index maintenance_events_corrects_uidx on bl.maintenance_events (corrects_id) where corrects_id is not null;
create index maintenance_events_club_idx on bl.maintenance_events (club_id, resource_id, kind, occurred_on desc);
create index maintenance_events_created_idx on bl.maintenance_events (club_id, created_at desc);

comment on table bl.maintenance_events is 'Обслуживание столов (M5.6 №198): только добавление; исправление — новая запись с corrects_id и причиной.';

create table bl.maintenance_alerts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  resource_id uuid not null,
  kind text not null check (kind in ('cloth', 'balls', 'cushions', 'leveling', 'other')),
  -- Последнее действующее событие вида, от которого считались часы (null — с начала учёта).
  event_id uuid,
  threshold_hours integer not null check (threshold_hours between 1 and 100000),
  hours_at numeric(10, 1) not null check (hours_at >= 0),
  created_at timestamptz not null,
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  foreign key (club_id, event_id) references bl.maintenance_events (club_id, id),
  constraint maintenance_alerts_once unique nulls not distinct (club_id, resource_id, kind, event_id, threshold_hours)
);

comment on table bl.maintenance_alerts is 'Обслуживание столов (M5.6 №198): уведомление о пороге часов — одно на (стол, вид, событие, порог).';

alter table bl.cashbook_entries add column maintenance_event_id uuid;
alter table bl.cashbook_entries add constraint cashbook_entries_maintenance_fk
  foreign key (club_id, maintenance_event_id) references bl.maintenance_events (club_id, id);
alter table bl.cashbook_entries add constraint cashbook_entries_maintenance_check
  check (maintenance_event_id is null or kind = 'expense');
create unique index cashbook_entries_maintenance_uidx on bl.cashbook_entries (maintenance_event_id)
  where maintenance_event_id is not null and reverses_id is null;
comment on column bl.cashbook_entries.maintenance_event_id is 'Расход по событию обслуживания стола (M5.6 №198); у сторно — та же ссылка.';

alter table bl.maintenance_events owner to bl_owner;
alter table bl.maintenance_alerts owner to bl_owner;
alter table bl.maintenance_events enable row level security;
alter table bl.maintenance_events force row level security;
alter table bl.maintenance_alerts enable row level security;
alter table bl.maintenance_alerts force row level security;

create policy maintenance_events_app_select on bl.maintenance_events for select to app_api using (club_id = bl.ctx_club_id());
create policy maintenance_events_app_insert on bl.maintenance_events for insert to app_api with check (club_id = bl.ctx_club_id());
create policy maintenance_alerts_app_select on bl.maintenance_alerts for select to app_api using (club_id = bl.ctx_club_id());
create policy maintenance_alerts_app_insert on bl.maintenance_alerts for insert to app_api with check (club_id = bl.ctx_club_id());

revoke all on bl.maintenance_events, bl.maintenance_alerts from public;
grant select, insert on bl.maintenance_events, bl.maintenance_alerts to app_api;

-- Только добавление: правка и удаление запрещены всем ролям (как журнал и касса).
create function bl.maintenance_append_only() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'bl.%: append-only', tg_table_name using errcode = 'insufficient_privilege';
end
$$;
alter function bl.maintenance_append_only() owner to bl_owner;
revoke all on function bl.maintenance_append_only() from public;

create trigger maintenance_events_no_update before update or delete on bl.maintenance_events for each row execute function bl.maintenance_append_only();
create trigger maintenance_events_no_truncate before truncate on bl.maintenance_events for each statement execute function bl.maintenance_append_only();
create trigger maintenance_alerts_no_update before update or delete on bl.maintenance_alerts for each row execute function bl.maintenance_append_only();
create trigger maintenance_alerts_no_truncate before truncate on bl.maintenance_alerts for each statement execute function bl.maintenance_append_only();
alter table bl.maintenance_events enable always trigger maintenance_events_no_update;
alter table bl.maintenance_events enable always trigger maintenance_events_no_truncate;
alter table bl.maintenance_alerts enable always trigger maintenance_alerts_no_update;
alter table bl.maintenance_alerts enable always trigger maintenance_alerts_no_truncate;
