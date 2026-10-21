-- 0002: пользователи, клубы, участники, ресурсы (столы), устройства, тарифы.
--
-- Все таблицы с club_id: ENABLE + FORCE ROW LEVEL SECURITY, политики только для app_api
-- по bl.ctx_club_id() (decisions №12). Владелец — bl_owner (без входа).
-- Деньги — bigint в копейках, время — timestamptz (UTC), идентификаторы — uuid.

-- Проверка часового пояса IANA: имя вида Area/Location, которое знает Postgres.
create or replace function bl.is_valid_timezone(tz text) returns boolean
language plpgsql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
begin
  if tz is null or tz !~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)*$' then
    return false;
  end if;
  perform pg_catalog.timezone(tz, timestamptz '2000-01-01 00:00:00+00');
  return true;
exception when others then
  return false;
end
$$;
alter function bl.is_valid_timezone(text) owner to bl_owner;
revoke all on function bl.is_valid_timezone(text) from public;
grant execute on function bl.is_valid_timezone(text) to app_api;

-- users ------------------------------------------------------------------------
-- Минимум M0: персонал и владельцы. Гости — отдельная модель (M1).

create table bl.users (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at timestamptz not null default now()
);

-- clubs ------------------------------------------------------------------------

create table bl.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  city text not null check (length(city) between 1 and 100),
  timezone text not null check (bl.is_valid_timezone(timezone)),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now()
);

-- club_members -----------------------------------------------------------------

create table bl.club_members (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  user_id uuid not null references bl.users (id),
  role text not null check (role in ('owner', 'manager', 'reception', 'installer')),
  pin_hash text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (club_id, user_id)
);
create index club_members_user_idx on bl.club_members (user_id);

-- resources --------------------------------------------------------------------
-- Ресурс универсальный, в интерфейсе бильярда — «стол». План зала: центр стола
-- в сантиметрах от левого верхнего угла зала, поворот в градусах по часовой стрелке.

create table bl.resources (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  type text not null check (type in ('billiard_pyramid', 'billiard_pool', 'billiard_snooker')),
  number integer not null check (number > 0),
  title text not null check (length(title) between 1 and 100),
  plan_x integer not null default 0 check (plan_x >= 0),
  plan_y integer not null default 0 check (plan_y >= 0),
  plan_rotation smallint not null default 0 check (plan_rotation >= 0 and plan_rotation < 360),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (club_id, number),
  unique (club_id, id)
);

-- devices ----------------------------------------------------------------------
-- id = device_id = логин MQTT. device_key_enc — AES-256-GCM в приложении
-- (decisions №23, server/lib/secrets.mjs), база ключа не видит.

create table bl.devices (
  id uuid primary key,
  club_id uuid not null references bl.clubs (id),
  resource_id uuid unique,
  serial text unique check (length(serial) between 1 and 100),
  device_key_enc text check (length(device_key_enc) between 1 and 1000),
  mqtt_username text not null unique,
  last_seq bigint not null default 0 check (last_seq >= 0 and last_seq <= 9007199254740991),
  fw text check (length(fw) <= 50),
  caps text[] not null default '{}',
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  check (mqtt_username = id::text)
);

-- tariff_rules -----------------------------------------------------------------
-- Правило: тип ресурса или конкретный ресурс, дни ISO (1 = пн … 7 = вс), интервал
-- местного времени клуба. end_local <= start_local — интервал через полночь.
-- Семантика ночных интервалов и праздников — M1 (decisions №35).

create table bl.tariff_rules (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  resource_type text check (resource_type in ('billiard_pyramid', 'billiard_pool', 'billiard_snooker')),
  resource_id uuid,
  days smallint[] not null check (
    cardinality(days) between 1 and 7
    and array_position(days, null) is null
    and days <@ '{1,2,3,4,5,6,7}'::smallint[]
  ),
  start_local time not null,
  end_local time not null,
  price_per_hour bigint not null check (price_per_hour >= 0),
  step_minutes integer not null default 1 check (step_minutes between 1 and 60),
  min_minutes integer not null default 30 check (min_minutes between 0 and 1440),
  priority integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (num_nonnulls(resource_type, resource_id) = 1),
  foreign key (club_id, resource_id) references bl.resources (club_id, id)
);
create index tariff_rules_club_idx on bl.tariff_rules (club_id);

-- Владелец -----------------------------------------------------------------------

alter table bl.users owner to bl_owner;
alter table bl.clubs owner to bl_owner;
alter table bl.club_members owner to bl_owner;
alter table bl.resources owner to bl_owner;
alter table bl.devices owner to bl_owner;
alter table bl.tariff_rules owner to bl_owner;

-- RLS -----------------------------------------------------------------------------

alter table bl.users enable row level security;
alter table bl.users force row level security;
alter table bl.clubs enable row level security;
alter table bl.clubs force row level security;
alter table bl.club_members enable row level security;
alter table bl.club_members force row level security;
alter table bl.resources enable row level security;
alter table bl.resources force row level security;
alter table bl.devices enable row level security;
alter table bl.devices force row level security;
alter table bl.tariff_rules enable row level security;
alter table bl.tariff_rules force row level security;

create policy clubs_app on bl.clubs for all to app_api
  using (id = bl.ctx_club_id())
  with check (id = bl.ctx_club_id());

create policy club_members_app on bl.club_members for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

create policy resources_app on bl.resources for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

create policy devices_app on bl.devices for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

create policy tariff_rules_app on bl.tariff_rules for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

-- Пользователь виден сам себе и участникам клуба из контекста.
create policy users_app_select on bl.users for select to app_api
  using (
    id = bl.ctx_user_id()
    or exists (
      select 1 from bl.club_members m
      where m.user_id = users.id and m.club_id = bl.ctx_club_id()
    )
  );

-- Узкие функции SECURITY DEFINER видят только devices(id, club_id).
create policy devices_definer on bl.devices for select to bl_definer using (true);

-- Права ---------------------------------------------------------------------------

revoke all on bl.users, bl.clubs, bl.club_members, bl.resources, bl.devices, bl.tariff_rules from public;

grant select on bl.users to app_api;
grant select, update on bl.clubs to app_api;
grant select, insert, update on bl.club_members to app_api;
grant select, insert, update on bl.resources to app_api;
grant select, insert on bl.devices to app_api;
grant update (resource_id, serial, device_key_enc, last_seq, fw, caps, last_seen_at) on bl.devices to app_api;
grant select, insert, update on bl.tariff_rules to app_api;

grant select (id, club_id) on bl.devices to bl_definer;

-- Узкие функции SECURITY DEFINER (список — supabase/README.md) ---------------------
-- Мосту MQTT нужно узнать клуб устройства по device_id до того, как известен
-- контекст клуба, и число устройств для лога devices_online.

create or replace function bl.device_club(p_device_id uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$ select d.club_id from bl.devices d where d.id = p_device_id $$;

create or replace function bl.device_total() returns bigint
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$ select count(*) from bl.devices $$;

alter function bl.device_club(uuid) owner to bl_definer;
alter function bl.device_total() owner to bl_definer;
revoke all on function bl.device_club(uuid), bl.device_total() from public;
grant execute on function bl.device_club(uuid), bl.device_total() to app_api;

comment on function bl.device_club(uuid) is 'SECURITY DEFINER: club_id устройства по device_id или NULL. Только для моста MQTT.';
comment on function bl.device_total() is 'SECURITY DEFINER: число устройств во всех клубах (лог devices_online).';
