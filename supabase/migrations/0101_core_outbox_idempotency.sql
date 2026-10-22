-- 0101 (backend-core): outbox и ключи идемпотентности.
--
-- Outbox (контракт M1 §2.2, decisions №48): событие пишется в транзакции вызывающего,
-- обработчики выполняются после коммита по LISTEN/NOTIFY (канал bl_outbox) и опросу раз
-- в секунду. Доставка «хотя бы один раз»: обработчик и отметка «обработано подписчиком»
-- (outbox_done) — в одной транзакции, поэтому успешный обработчик не повторяется,
-- а упавший — повторяется с нарастающей паузой; после 5 неудач — тревога.
--
-- Идемпотентность (контракт §3): повтор запроса с тем же Idempotency-Key у того же
-- пользователя и маршрута в течение 24 часов возвращает сохранённый ответ.

-- outbox ---------------------------------------------------------------------------------

create table bl.outbox (
  id bigint generated always as identity primary key,
  club_id uuid references bl.clubs (id),
  topic text not null check (topic ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and length(topic) <= 100),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text check (length(last_error) <= 500),
  alarmed_at timestamptz,
  processed_at timestamptz
);
create index outbox_pending_idx on bl.outbox (next_attempt_at, id) where processed_at is null;
create index outbox_processed_idx on bl.outbox (processed_at) where processed_at is not null;

-- Подписчик обработал событие (обработчик и эта строка — в одной транзакции).
create table bl.outbox_done (
  event_id bigint not null references bl.outbox (id) on delete cascade,
  subscriber text not null check (length(subscriber) between 1 and 200),
  club_id uuid references bl.clubs (id),
  done_at timestamptz not null default now(),
  primary key (event_id, subscriber)
);

-- Уведомление обработчику после коммита вставки (NOTIFY доставляется только при коммите).
create function bl.outbox_notify() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  perform pg_notify('bl_outbox', '');
  return null;
end
$$;

create trigger outbox_notify
  after insert on bl.outbox
  for each statement execute function bl.outbox_notify();

-- idempotency_keys -------------------------------------------------------------------------

create table bl.idempotency_keys (
  user_id uuid not null references bl.users (id),
  key uuid not null,
  route text not null check (length(route) between 1 and 200),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response_status smallint check (response_status between 100 and 599),
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, key, route),
  check (expires_at > created_at)
);
create index idempotency_keys_expires_idx on bl.idempotency_keys (expires_at);

-- Владелец, RLS, права -----------------------------------------------------------------------

alter table bl.outbox owner to bl_owner;
alter table bl.outbox_done owner to bl_owner;
alter table bl.idempotency_keys owner to bl_owner;
alter function bl.outbox_notify() owner to bl_owner;
revoke all on function bl.outbox_notify() from public;

alter table bl.outbox enable row level security;
alter table bl.outbox force row level security;
alter table bl.outbox_done enable row level security;
alter table bl.outbox_done force row level security;
alter table bl.idempotency_keys enable row level security;
alter table bl.idempotency_keys force row level security;

-- Событие своего клуба видно в контексте клуба; все события — обработчику (платформа).
-- Событие без клуба (например, доставка уведомления) пишется из любого контекста.
create policy outbox_select on bl.outbox for select to app_api
  using (club_id = bl.ctx_club_id() or bl.ctx_is_platform());
create policy outbox_insert on bl.outbox for insert to app_api
  with check (club_id = bl.ctx_club_id() or club_id is null);
create policy outbox_update on bl.outbox for update to app_api
  using (club_id = bl.ctx_club_id() or bl.ctx_is_platform())
  with check (club_id = bl.ctx_club_id() or bl.ctx_is_platform());
create policy outbox_delete on bl.outbox for delete to app_api
  using (bl.ctx_is_platform());

create policy outbox_done_app on bl.outbox_done for all to app_api
  using (club_id = bl.ctx_club_id() or (club_id is null and bl.ctx_is_platform()))
  with check (club_id = bl.ctx_club_id() or (club_id is null and bl.ctx_is_platform()));
create policy outbox_done_platform_select on bl.outbox_done for select to app_api
  using (bl.ctx_is_platform());

create policy idempotency_keys_self on bl.idempotency_keys for all to app_api
  using (user_id = bl.ctx_user_id())
  with check (user_id = bl.ctx_user_id());
create policy idempotency_keys_platform_delete on bl.idempotency_keys for delete to app_api
  using (bl.ctx_is_platform());

revoke all on bl.outbox, bl.outbox_done, bl.idempotency_keys from public;

grant select, insert, delete on bl.outbox to app_api;
grant update (attempts, next_attempt_at, last_error, alarmed_at, processed_at) on bl.outbox to app_api;
grant select, insert on bl.outbox_done to app_api;
grant select, insert, update, delete on bl.idempotency_keys to app_api;

comment on table bl.outbox is 'Outbox: события модулей (payment.confirmed, session.* …). Доставка после коммита по LISTEN/NOTIFY bl_outbox и опросу.';
comment on table bl.outbox_done is 'Подписчик обработал событие outbox (в той же транзакции, что и обработчик).';
comment on table bl.idempotency_keys is 'Ответы на запросы с Idempotency-Key: (user_id, key, route), 24 часа.';
