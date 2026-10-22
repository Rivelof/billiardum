-- 0320 (backend-light): команды и события контроллера, окна привязки.
--
-- device_commands — каждая команда контроллеру (контракт M1 §6): бизнес-транзакция ставит
-- строку queued и pg_notify('bl_light', …); мост после коммита в своей транзакции выделяет
-- seq, пишет device.cmd в журнал и публикует (protocol v1 §6).
-- device_events — событие контроллера один раз по (device_id, boot_id, n) (decisions №33, №37).
-- device_bind_windows — окно привязки 30 минут (protocol §7): код привязки хранится хешем,
-- сгорает при первом успешном claim.

-- device_commands ------------------------------------------------------------------

create table bl.device_commands (
  id uuid primary key,
  club_id uuid not null,
  device_id uuid not null,
  seq bigint check (seq between 1 and 9007199254740991),
  type text not null check (type ~ '^[a-z][a-z_.]{1,31}$'),
  body jsonb not null default '{}'::jsonb check (jsonb_typeof(body) = 'object'),
  -- queued → sent → acked | failed | no_ack | abandoned; queued → superseded | cancelled.
  status text not null check (status in ('queued', 'sent', 'acked', 'failed', 'no_ack', 'abandoned', 'superseded', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  error text check (error ~ '^[a-z_]{1,32}$'),
  cause text not null check (cause in ('payment', 'guest', 'staff', 'sync', 'hold', 'system')),
  session_id uuid,
  payment_id uuid,
  created_at timestamptz not null,
  sent_at timestamptz,
  acked_at timestamptz,
  foreign key (club_id, device_id) references bl.devices (club_id, id),
  foreign key (club_id, session_id) references bl.sessions (club_id, id),
  check (status = 'queued' or status in ('superseded', 'cancelled') or seq is not null)
);
create index device_commands_queued_idx on bl.device_commands (device_id, created_at) where status = 'queued';
create index device_commands_session_idx on bl.device_commands (session_id);

-- device_events ----------------------------------------------------------------------

create table bl.device_events (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null,
  device_id uuid not null,
  boot bigint check (boot between 0 and 9007199254740991),
  boot_id text not null check (boot_id ~ '^[0-9a-f]{8}$'),
  n bigint not null check (n between 1 and 9007199254740991),
  type text not null check (type ~ '^[a-z][a-z0-9_]{0,39}$'),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  at_uptime_ms bigint check (at_uptime_ms >= 0),
  received_at timestamptz not null,
  constraint device_events_once unique (device_id, boot_id, n),
  foreign key (club_id, device_id) references bl.devices (club_id, id)
);
create index device_events_device_type_idx on bl.device_events (device_id, type, received_at);

-- device_bind_windows ------------------------------------------------------------------

create table bl.device_bind_windows (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  device_id uuid not null,
  resource_id uuid not null,
  -- hex(sha256(utf8(device_id || ':' || claim_code))); код в базе не хранится.
  claim_code_hash text not null check (claim_code_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references bl.users (id),
  created_at timestamptz not null,
  until timestamptz not null,
  claimed_at timestamptz,
  closed_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 100),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  check (until > created_at)
);
create index device_bind_windows_open_idx on bl.device_bind_windows (device_id, until)
  where claimed_at is null and closed_at is null;

-- Владелец, RLS, права ------------------------------------------------------------------

alter table bl.device_commands owner to bl_owner;
alter table bl.device_events owner to bl_owner;
alter table bl.device_bind_windows owner to bl_owner;

alter table bl.device_commands enable row level security;
alter table bl.device_commands force row level security;
alter table bl.device_events enable row level security;
alter table bl.device_events force row level security;
alter table bl.device_bind_windows enable row level security;
alter table bl.device_bind_windows force row level security;

create policy device_commands_app on bl.device_commands for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());
create policy device_events_app on bl.device_events for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());
create policy device_bind_windows_app on bl.device_bind_windows for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

revoke all on bl.device_commands, bl.device_events, bl.device_bind_windows from public;
grant select, insert on bl.device_commands to app_api;
grant update (type, seq, body, status, attempts, error, sent_at, acked_at) on bl.device_commands to app_api;
grant select, insert on bl.device_events to app_api;
grant select, insert on bl.device_bind_windows to app_api;
grant update (claimed_at, closed_at, failed_attempts) on bl.device_bind_windows to app_api;

-- Узкая функция SECURITY DEFINER ----------------------------------------------------------
-- POST /api/devices/claim приходит от контроллера без входа: клуб окна привязки нужно
-- узнать до контекста. Возвращает только открытое окно (не использовано, не закрыто,
-- до until); bl_definer видит у окон только эти столбцы.

grant select (id, club_id, device_id, until, claimed_at, closed_at, created_at) on bl.device_bind_windows to bl_definer;
create policy device_bind_windows_definer on bl.device_bind_windows for select to bl_definer using (true);

create function bl.device_bind_window(p_device_id uuid, p_now timestamptz)
returns table (window_id uuid, club_id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select w.id, w.club_id from bl.device_bind_windows w
   where w.device_id = p_device_id
     and w.claimed_at is null and w.closed_at is null
     and w.until > p_now
   order by w.created_at desc
   limit 1
$$;

alter function bl.device_bind_window(uuid, timestamptz) owner to bl_definer;
revoke all on function bl.device_bind_window(uuid, timestamptz) from public;
grant execute on function bl.device_bind_window(uuid, timestamptz) to app_api;

comment on function bl.device_bind_window(uuid, timestamptz) is 'SECURITY DEFINER: (window_id, club_id) открытого окна привязки устройства. Только POST /api/devices/claim.';
