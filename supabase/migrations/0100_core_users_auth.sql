-- 0100 (backend-core): пользователи платформы, вход, согласия, терминалы ресепшена.
--
-- Контракт M1 §4, §13; decisions №41, №49. Пользователь платформы не привязан к клубу:
-- * свою строку users видит сам (bl.ctx_user_id()); участников клуба из контекста видит
--   персонал этого клуба (политика M0); гостей персонал видит только через узкие функции
--   с маской телефона (bl.user_brief, 0103);
-- * поиск пользователя по телефону, Telegram и MAX до входа, привязка телефона и проверка
--   токена — узкие функции SECURITY DEFINER (0103), у app_api прямого доступа нет;
-- * свои членства в клубах и сами клубы пользователь видит только в личном контексте
--   (без клуба): в контексте клуба A строка членства в клубе B не появится даже у её хозяина.
-- Токены и nonce хранятся только как sha256.

-- Контекст «платформа» ------------------------------------------------------------------
-- Системный исполнитель без клуба и без пользователя: обработчик outbox, вебхук бота,
-- вход через бота. Анонимные HTTP-запросы идут с actor_type = user и сюда не попадают.

create or replace function bl.ctx_is_platform() returns boolean
language sql stable parallel safe
as $$
  select coalesce(bl.ctx_actor_type() = 'system', false)
     and bl.ctx_club_id() is null
     and bl.ctx_user_id() is null
$$;
alter function bl.ctx_is_platform() owner to bl_owner;
revoke all on function bl.ctx_is_platform() from public;
grant execute on function bl.ctx_is_platform() to app_api;

comment on function bl.ctx_is_platform() is 'Контекст платформы: actor_type = system, без клуба и пользователя (outbox, боты, вход).';

-- users (decisions №41) -----------------------------------------------------------------
-- Телефон необязателен до «Поделиться контактом» и уникален при наличии.
-- merged_into: учётка, созданная входом через мессенджер, влита в учётку с тем же телефоном.

alter table bl.users alter column phone drop not null;
alter table bl.users
  add column telegram_user_id bigint check (telegram_user_id > 0),
  add column max_user_id text check (max_user_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  add column notify_channel text check (notify_channel in ('max', 'telegram', 'webpush')),
  add column phone_verified_at timestamptz,
  add column merged_into uuid references bl.users (id),
  add column updated_at timestamptz not null default now(),
  add constraint users_telegram_user_id_key unique (telegram_user_id),
  add constraint users_max_user_id_key unique (max_user_id),
  add constraint users_not_merged_into_self check (merged_into is distinct from id);

comment on column bl.users.phone is 'E.164; NULL до «Поделиться контактом». Без телефона и согласия — никаких денежных операций.';

-- Пользователь меняет у себя только канал уведомлений; телефон — через bl.auth_attach_phone.
create policy users_app_update_self on bl.users for update to app_api
  using (id = bl.ctx_user_id())
  with check (id = bl.ctx_user_id());
grant update (notify_channel, updated_at) on bl.users to app_api;

-- Свои членства и свои клубы — только в личном контексте (без клуба) ---------------------

create policy club_members_self on bl.club_members for select to app_api
  using (bl.ctx_club_id() is null and user_id = bl.ctx_user_id());

create policy clubs_member on bl.clubs for select to app_api
  using (
    bl.ctx_club_id() is null
    and exists (
      select 1 from bl.club_members m
       where m.club_id = clubs.id and m.user_id = bl.ctx_user_id() and m.active
    )
  );

-- PIN персонала: 5 ошибок подряд — блок на 15 минут (контракт §4).
alter table bl.club_members
  add column pin_failed_count smallint not null default 0 check (pin_failed_count between 0 and 100),
  add column pin_locked_until timestamptz,
  add column pin_set_at timestamptz,
  add constraint club_members_pin_hash_format check (pin_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$');

-- consents -----------------------------------------------------------------------------
-- Согласие на обработку персональных данных отдельным флажком (PRODUCT §11).

create table bl.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references bl.users (id),
  version text not null check (version ~ '^[0-9A-Za-z._-]{1,32}$'),
  accepted_at timestamptz not null default now(),
  unique (user_id, version)
);

-- staff_terminals ----------------------------------------------------------------------
-- Общее устройство ресепшена: токен терминала даёт только смену сотрудника по PIN.

create table bl.staff_terminals (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  name text not null check (length(name) between 1 and 100),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references bl.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  unique (club_id, id),
  check (expires_at > created_at)
);

-- auth_tokens --------------------------------------------------------------------------
-- kind = session — личный вход (бот, мини-приложение, разработка);
-- kind = pin — смена сотрудника на терминале: действует только в клубе терминала.

create table bl.auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references bl.users (id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('session', 'pin')),
  club_id uuid references bl.clubs (id),
  terminal_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  foreign key (club_id, terminal_id) references bl.staff_terminals (club_id, id),
  check (expires_at > created_at),
  check ((kind = 'pin') = (terminal_id is not null)),
  check ((kind = 'pin') = (club_id is not null))
);
create index auth_tokens_user_idx on bl.auth_tokens (user_id);
create index auth_tokens_terminal_idx on bl.auth_tokens (terminal_id) where terminal_id is not null;

-- bot_link_nonces ----------------------------------------------------------------------
-- Вход в PWA через бота (decisions №49): nonce в стартовом параметре бота, browser_hash —
-- хеш секрета из cookie браузера, который создал nonce: токен получает только он.

create table bl.bot_link_nonces (
  id uuid primary key default gen_random_uuid(),
  nonce_hash text not null unique check (nonce_hash ~ '^[0-9a-f]{64}$'),
  browser_hash text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  channel text not null check (channel in ('telegram', 'max')),
  status text not null default 'pending' check (status in ('pending', 'linked', 'done', 'consumed')),
  external_user_id text check (external_user_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  user_id uuid references bl.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  linked_at timestamptz,
  done_at timestamptz,
  consumed_at timestamptz,
  check (expires_at > created_at),
  check (status = 'pending' or external_user_id is not null),
  check (status not in ('done', 'consumed') or user_id is not null)
);
create index bot_link_nonces_external_idx on bl.bot_link_nonces (channel, external_user_id) where status = 'linked';
create index bot_link_nonces_expires_idx on bl.bot_link_nonces (expires_at);

-- Владелец, RLS, права -------------------------------------------------------------------

alter table bl.consents owner to bl_owner;
alter table bl.staff_terminals owner to bl_owner;
alter table bl.auth_tokens owner to bl_owner;
alter table bl.bot_link_nonces owner to bl_owner;

alter table bl.consents enable row level security;
alter table bl.consents force row level security;
alter table bl.staff_terminals enable row level security;
alter table bl.staff_terminals force row level security;
alter table bl.auth_tokens enable row level security;
alter table bl.auth_tokens force row level security;
alter table bl.bot_link_nonces enable row level security;
alter table bl.bot_link_nonces force row level security;

create policy consents_self on bl.consents for all to app_api
  using (user_id = bl.ctx_user_id())
  with check (user_id = bl.ctx_user_id());

create policy staff_terminals_app on bl.staff_terminals for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

-- Свои токены; токены PIN своего клуба (смена сотрудника отзывает токен предыдущего).
create policy auth_tokens_app on bl.auth_tokens for all to app_api
  using (user_id = bl.ctx_user_id() or (club_id is not null and club_id = bl.ctx_club_id()))
  with check (user_id = bl.ctx_user_id() or (club_id is not null and club_id = bl.ctx_club_id()));

create policy bot_link_nonces_platform on bl.bot_link_nonces for all to app_api
  using (bl.ctx_is_platform())
  with check (bl.ctx_is_platform());

revoke all on bl.consents, bl.staff_terminals, bl.auth_tokens, bl.bot_link_nonces from public;

grant select, insert on bl.consents to app_api;
grant select, insert on bl.staff_terminals to app_api;
grant update (name, revoked_at, last_used_at) on bl.staff_terminals to app_api;
grant select, insert on bl.auth_tokens to app_api;
grant update (revoked_at, last_used_at) on bl.auth_tokens to app_api;
grant select, insert, delete on bl.bot_link_nonces to app_api;
grant update (status, external_user_id, user_id, linked_at, done_at, consumed_at) on bl.bot_link_nonces to app_api;

comment on table bl.consents is 'Согласия на обработку ПДн: версия текста и время. Пользователь видит только свои.';
comment on table bl.staff_terminals is 'Терминалы ресепшена: sha256 токена терминала, отзыв, срок.';
comment on table bl.auth_tokens is 'Токены входа: только sha256, срок и отзыв. kind = pin — смена сотрудника на терминале.';
comment on table bl.bot_link_nonces is 'Вход в PWA через бота: sha256 nonce и секрета браузера. Только контекст платформы.';
