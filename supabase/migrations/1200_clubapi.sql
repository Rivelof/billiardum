-- 1200 (backend, M5.7 №199–202): публичный API клуба — ключи API и исходящие вебхуки.
--
-- * bl.api_keys — ключи API клуба. Ключ blk_… показывается владельцу один раз; в базе — только
--   HMAC-SHA256 ключа с перцем из SECRETS_ENC_KEY (key_hash, 64 hex) и префикс для показа.
--   app_api хеш не читает (права по столбцам), меняет только revoked_at и revoked_by; отзыв
--   необратим (триггер). Не больше 5 активных ключей на клуб — проверка сервера под блокировкой
--   клуба и триггер-страховка. Проверка ключа — узкая функция bl.clubapi_key_auth(hash):
--   клуб, права и режим клуба действующего ключа; last_used_at — не чаще раза в минуту.
-- * bl.webhooks — адреса вебхуков клуба (https, события из закрытого списка), секрет подписи —
--   AES-256-GCM в приложении (decisions №23), база его не видит. Выключение необратимо.
-- * bl.webhook_deliveries — очередь и журнал доставок (одна строка — событие × адрес), без ПДн:
--   полезная нагрузка собирается сервером по белому списку полей. bl.webhook_attempts — попытки.
--   Воркер доставки (server/clubapi) работает в контексте платформы (захват) и клуба (итог).
-- RLS по club_id, ENABLE и FORCE; DELETE — только уборке старых доставок в контексте платформы.

-- Ключи API ------------------------------------------------------------------------------------

create table bl.api_keys (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  name text not null check (length(btrim(name)) between 1 and 100),
  prefix text not null check (prefix ~ '^blk_[A-Za-z0-9_-]{8}$'),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null check (
    cardinality(scopes) between 1 and 5
    and array_position(scopes, null) is null
    and scopes <@ array['tables:read', 'tariffs:read', 'availability:read', 'sales:read', 'bookings:read']::text[]
  ),
  created_by uuid not null references bl.users (id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references bl.users (id),
  last_used_at timestamptz,
  unique (club_id, id),
  check ((revoked_at is null) = (revoked_by is null))
);
create index api_keys_club_idx on bl.api_keys (club_id, created_at desc);

-- Отзыв необратим; имя, права, хеш и клуб не меняются.
create function bl.api_keys_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bl.api_keys:' || new.club_id::text, 0));
    if new.revoked_at is null and (select count(*) from bl.api_keys k where k.club_id = new.club_id and k.revoked_at is null) >= 5 then
      raise exception 'bl.api_keys: not more than 5 active keys per club' using errcode = '23514', constraint = 'api_keys_active_limit';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.club_id is distinct from old.club_id or new.name is distinct from old.name
     or new.prefix is distinct from old.prefix or new.key_hash is distinct from old.key_hash or new.scopes is distinct from old.scopes
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
     or (old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at or new.revoked_by is distinct from old.revoked_by)) then
    raise exception 'bl.api_keys: only revoke once and last_used_at' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger api_keys_guard before insert or update on bl.api_keys for each row execute function bl.api_keys_guard();

-- Вебхуки ----------------------------------------------------------------------------------------

create table bl.webhooks (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  url text not null check (length(url) between 12 and 2048 and url ~ '^https://[^\s]+$'),
  events text[] not null check (
    cardinality(events) between 1 and 5
    and array_position(events, null) is null
    and events <@ array['session.started', 'session.ended', 'booking.created', 'booking.canceled', 'shift.closed']::text[]
  ),
  description text check (length(btrim(description)) between 1 and 200),
  secret_enc text not null check (secret_enc ~ '^v1:' and length(secret_enc) between 10 and 1000),
  created_by uuid not null references bl.users (id),
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_by uuid references bl.users (id),
  unique (club_id, id),
  check ((disabled_at is null) = (disabled_by is null))
);
create index webhooks_club_idx on bl.webhooks (club_id, created_at desc);

create function bl.webhooks_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id is distinct from old.id or new.club_id is distinct from old.club_id or new.url is distinct from old.url
     or new.events is distinct from old.events or new.description is distinct from old.description
     or new.secret_enc is distinct from old.secret_enc or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or (old.disabled_at is not null and (new.disabled_at is distinct from old.disabled_at or new.disabled_by is distinct from old.disabled_by)) then
    raise exception 'bl.webhooks: only disable once' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger webhooks_guard before update on bl.webhooks for each row execute function bl.webhooks_guard();

create table bl.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  webhook_id uuid not null,
  -- Событие для получателя (X-Bl-Event-Id): одно на событие клуба для всех его адресов.
  event_id uuid not null,
  event text not null check (event in ('session.started', 'session.ended', 'booking.created', 'booking.canceled', 'shift.closed', 'ping')),
  -- Откуда событие: outbox:<id> или test:<uuid> («отправить тестовое событие»); повтор не дублирует.
  source text not null check (source ~ '^(outbox:[0-9]{1,20}|test:[0-9a-f-]{36})$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed', 'canceled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_until timestamptz,
  last_attempt_at timestamptz,
  last_http_status smallint check (last_http_status between 100 and 599),
  last_error text check (last_error ~ '^[a-z0-9_:.]{1,64}$'),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (club_id, id),
  unique (webhook_id, source),
  foreign key (club_id, webhook_id) references bl.webhooks (club_id, id)
);
create index webhook_deliveries_due_idx on bl.webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_hook_idx on bl.webhook_deliveries (webhook_id, created_at desc);
create index webhook_deliveries_old_idx on bl.webhook_deliveries (created_at) where status <> 'pending';

create table bl.webhook_attempts (
  id bigint generated always as identity primary key,
  club_id uuid not null references bl.clubs (id),
  delivery_id uuid not null,
  attempt integer not null check (attempt >= 1),
  at timestamptz not null,
  http_status smallint check (http_status between 100 and 599),
  error text check (error ~ '^[a-z0-9_:.]{1,64}$'),
  duration_ms integer check (duration_ms >= 0),
  foreign key (club_id, delivery_id) references bl.webhook_deliveries (club_id, id) on delete cascade
);
create index webhook_attempts_delivery_idx on bl.webhook_attempts (delivery_id, attempt);

-- Владелец, RLS, права ---------------------------------------------------------------------------

alter table bl.api_keys owner to bl_owner;
alter table bl.webhooks owner to bl_owner;
alter table bl.webhook_deliveries owner to bl_owner;
alter table bl.webhook_attempts owner to bl_owner;
alter function bl.api_keys_guard() owner to bl_owner;
alter function bl.webhooks_guard() owner to bl_owner;

alter table bl.api_keys enable row level security;
alter table bl.api_keys force row level security;
alter table bl.webhooks enable row level security;
alter table bl.webhooks force row level security;
alter table bl.webhook_deliveries enable row level security;
alter table bl.webhook_deliveries force row level security;
alter table bl.webhook_attempts enable row level security;
alter table bl.webhook_attempts force row level security;

create policy api_keys_app on bl.api_keys for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy api_keys_definer on bl.api_keys for select to bl_definer using (true);
create policy api_keys_definer_used on bl.api_keys for update to bl_definer using (true) with check (true);

create policy webhooks_app on bl.webhooks for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
-- Воркер доставки (контекст платформы): адрес и секрет захваченной доставки.
create policy webhooks_platform on bl.webhooks for select to app_api using (bl.ctx_is_platform());

create policy webhook_deliveries_app on bl.webhook_deliveries for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy webhook_deliveries_platform on bl.webhook_deliveries for all to app_api
  using (bl.ctx_is_platform()) with check (bl.ctx_is_platform());

create policy webhook_attempts_app on bl.webhook_attempts for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());

revoke all on bl.api_keys, bl.webhooks, bl.webhook_deliveries, bl.webhook_attempts from public;
-- Хеш ключа app_api не читает: только вставка; отзыв — revoked_at, revoked_by.
grant select (id, club_id, name, prefix, scopes, created_by, created_at, revoked_at, revoked_by, last_used_at) on bl.api_keys to app_api;
grant insert (id, club_id, name, prefix, key_hash, scopes, created_by, created_at) on bl.api_keys to app_api;
grant update (revoked_at, revoked_by) on bl.api_keys to app_api;
grant select, insert on bl.webhooks to app_api;
grant update (disabled_at, disabled_by) on bl.webhooks to app_api;
grant select, insert on bl.webhook_deliveries to app_api;
grant update (status, attempts, next_attempt_at, claimed_until, last_attempt_at, last_http_status, last_error, delivered_at)
  on bl.webhook_deliveries to app_api;
-- Уборка доставок старше 30 суток (контекст платформы; попытки удаляются каскадом).
grant delete on bl.webhook_deliveries to app_api;
grant select, insert on bl.webhook_attempts to app_api;

-- Проверка ключа ---------------------------------------------------------------------------------

grant select (id, club_id, key_hash, scopes, revoked_at, last_used_at) on bl.api_keys to bl_definer;
grant update (last_used_at) on bl.api_keys to bl_definer;

create function bl.clubapi_key_auth(p_hash text)
returns table (key_id uuid, club_id uuid, scopes text[], club_mode text)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  update bl.api_keys k set last_used_at = pg_catalog.now()
   where k.key_hash = p_hash and k.revoked_at is null
     and (k.last_used_at is null or k.last_used_at < pg_catalog.now() - interval '1 minute');
  return query
    select k.id, k.club_id, k.scopes, c.mode
      from bl.api_keys k join bl.clubs c on c.id = k.club_id
     where k.key_hash = p_hash and k.revoked_at is null;
end;
$$;
alter function bl.clubapi_key_auth(text) owner to bl_definer;
revoke all on function bl.clubapi_key_auth(text) from public;
grant execute on function bl.clubapi_key_auth(text) to app_api;

comment on table bl.api_keys is 'Ключи API клуба (M5.7 №199): HMAC ключа с перцем, префикс для показа, права; не больше 5 активных.';
comment on table bl.webhooks is 'Адреса вебхуков клуба (M5.7 №201): https, события, секрет подписи AES-256-GCM в приложении.';
comment on table bl.webhook_deliveries is 'Очередь и журнал доставок вебхуков клуба (M5.7 №201), без ПДн гостей.';
comment on table bl.webhook_attempts is 'Попытки доставки вебхука: время, HTTP-статус или код ошибки, длительность.';
comment on function bl.clubapi_key_auth(text) is
  'SECURITY DEFINER (M5.7 №199): действующий ключ API по HMAC — ключ, клуб, права, режим клуба; last_used_at не чаще раза в минуту.';
