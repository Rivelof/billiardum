-- 0102 (backend-core): подписки Web Push, уведомления, тревоги.
--
-- Контракт M1 §7, PRODUCT §8, §12; decisions №53 (в теле push нет персональных данных).
-- Доставка уведомления идёт обработчиком outbox в контексте платформы: он читает
-- подписки получателя и пишет статус. Персонал клуба видит тревоги и уведомления своего
-- клуба; гость — свои уведомления и подписки в личном контексте.

-- push_subscriptions ----------------------------------------------------------------------
-- PushSubscription браузера: endpoint (только https, хост проверяет сервер) и ключи
-- p256dh (точка P-256 без сжатия, 65 байт) и auth (16 байт) в base64url.

create table bl.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references bl.users (id),
  endpoint text not null check (endpoint ~ '^https://[^\s]+$' and length(endpoint) <= 1000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{22}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  failed_count integer not null default 0 check (failed_count >= 0),
  revoked_at timestamptz,
  unique (user_id, endpoint)
);

-- notifications ---------------------------------------------------------------------------
-- Одна запись на сообщение получателю; attempts — попытки по каналам цепочки
-- [{channel, status, code?, at}]. Текст пишут модули: номер стола и время, без телефонов.

create table bl.notifications (
  id uuid primary key default gen_random_uuid(),
  club_id uuid references bl.clubs (id),
  user_id uuid not null references bl.users (id),
  kind text not null check (kind ~ '^[a-z][a-z0-9_.]{0,63}$'),
  level text not null default 'info' check (level in ('critical', 'important', 'info')),
  text text not null check (length(text) between 1 and 1000),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  channel text check (channel in ('max', 'telegram', 'webpush')),
  attempts jsonb not null default '[]'::jsonb check (jsonb_typeof(attempts) = 'array'),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notifications_user_idx on bl.notifications (user_id, created_at desc);
create index notifications_club_idx on bl.notifications (club_id, created_at desc);

-- alarms ------------------------------------------------------------------------------------
-- Тревога клуба (PRODUCT §8): пока тревога того же типа по тому же столу открыта,
-- повтор увеличивает count, а не создаёт новую строку.

create table bl.alarms (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  type text not null check (type ~ '^[a-z][a-z0-9_.]{0,63}$'),
  level text not null check (level in ('critical', 'important', 'info')),
  resource_id uuid,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  state text not null default 'open' check (state in ('open', 'acked')),
  count integer not null default 1 check (count >= 1),
  raised_at timestamptz not null default now(),
  last_raised_at timestamptz not null default now(),
  acked_at timestamptz,
  acked_by uuid references bl.users (id),
  unique (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  check ((state = 'acked') = (acked_at is not null))
);
create unique index alarms_open_key on bl.alarms (club_id, type, coalesce(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where state = 'open';
create index alarms_club_idx on bl.alarms (club_id, state, last_raised_at desc);

-- Владелец, RLS, права -------------------------------------------------------------------------

alter table bl.push_subscriptions owner to bl_owner;
alter table bl.notifications owner to bl_owner;
alter table bl.alarms owner to bl_owner;

alter table bl.push_subscriptions enable row level security;
alter table bl.push_subscriptions force row level security;
alter table bl.notifications enable row level security;
alter table bl.notifications force row level security;
alter table bl.alarms enable row level security;
alter table bl.alarms force row level security;

-- Свои подписки — в личном контексте; все — доставке уведомлений (платформа).
create policy push_subscriptions_self on bl.push_subscriptions for all to app_api
  using ((bl.ctx_club_id() is null and user_id = bl.ctx_user_id()) or bl.ctx_is_platform())
  with check ((bl.ctx_club_id() is null and user_id = bl.ctx_user_id()) or bl.ctx_is_platform());

-- Уведомления клуба — в контексте клуба; свои — в личном контексте; все — доставке.
-- Пишутся с club_id из контекста (без клуба — NULL).
create policy notifications_select on bl.notifications for select to app_api
  using (
    club_id = bl.ctx_club_id()
    or (bl.ctx_club_id() is null and user_id = bl.ctx_user_id())
    or bl.ctx_is_platform()
  );
create policy notifications_insert on bl.notifications for insert to app_api
  with check (club_id is not distinct from bl.ctx_club_id());
create policy notifications_update on bl.notifications for update to app_api
  using (bl.ctx_is_platform())
  with check (bl.ctx_is_platform());

create policy alarms_app on bl.alarms for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

revoke all on bl.push_subscriptions, bl.notifications, bl.alarms from public;

grant select, insert on bl.push_subscriptions to app_api;
grant update (p256dh, auth, updated_at, last_success_at, failed_count, revoked_at) on bl.push_subscriptions to app_api;
grant select, insert on bl.notifications to app_api;
grant update (status, channel, attempts, sent_at) on bl.notifications to app_api;
grant select, insert on bl.alarms to app_api;
grant update (state, count, last_raised_at, data, acked_at, acked_by) on bl.alarms to app_api;

comment on table bl.push_subscriptions is 'Подписки Web Push пользователя (RFC 8030/8291). Видит сам пользователь и доставка уведомлений.';
comment on table bl.notifications is 'Уведомления: получатель, текст без персональных данных, статус и попытки по каналам.';
comment on table bl.alarms is 'Тревоги клуба (PRODUCT §8): уровень, стол, открыта/подтверждена, счётчик повторов.';
