-- 0753 (backend-light, M3, регресс R1 №128): история связи контроллера. Эпизод без связи —
-- от последнего state (или status offline) до возвращения онлайн; открытый эпизод — online_at
-- null, на устройство не больше одного. Нужна booking (availabilityDuring): стол без связи в
-- окне удержания брони недоступен. Пишет мост MQTT (переходы онлайн/офлайн). ПДн нет.

create table bl.device_offline (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null,
  device_id uuid not null,
  offline_from timestamptz not null,
  online_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (club_id, device_id) references bl.devices (club_id, id),
  check (online_at is null or online_at >= offline_from)
);
create unique index device_offline_open_uidx on bl.device_offline (device_id) where online_at is null;
create index device_offline_device_idx on bl.device_offline (device_id, offline_from);

comment on table bl.device_offline is 'Эпизоды без связи контроллера (мост MQTT); online_at null — связи нет сейчас.';

alter table bl.device_offline owner to bl_owner;
alter table bl.device_offline enable row level security;
alter table bl.device_offline force row level security;
create policy device_offline_app on bl.device_offline for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

revoke all on bl.device_offline from public;
grant select, insert on bl.device_offline to app_api;
grant update (online_at) on bl.device_offline to app_api;
