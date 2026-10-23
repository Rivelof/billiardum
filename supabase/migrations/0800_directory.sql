-- 0800 (backend-directory, M4 §1 п. 2–6, 12; решения №132–135, №139): каталог клубов сайта.
--
-- * cities — справочник городов платформы (слаг — транслит, уникален).
-- * club_public — карточка клуба в агрегаторе: listed (добавлена, не подтверждена), claimed
--   (владелец подтвердил), platform (клуб в программе: живые данные). Публичные поля читаются
--   всеми (видимые карточки) — ПДн в карточке нет: телефон и мессенджеры — клуба, контакт для
--   заявок (contact_user_id) наружу не отдаётся.
-- * club_requests — заявка гостя в клуб без программы (T25): клубу в канал, без ответа 15 минут —
--   оператору платформы.
-- * directory_claims — «Подтвердить клуб» / «Добавить клуб» → оператору.
-- * leads — заявки клубов на программу (уведомление Андрею); IP хранится только хешем.
-- * reviews, review_reports — отзывы гостей с игрой или бронью за 90 дней; жалобы — оператору.
--
-- Доступ: публичное — политиками select; клуб — по bl.ctx_club_id(); оператор и администратор
-- платформы — bl.ctx_platform_role() (core, 0710); фоновые задачи — bl.ctx_is_platform().

-- cities ----------------------------------------------------------------------------------

create table bl.cities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 60),
  name text not null check (length(btrim(name)) between 1 and 100),
  region text check (length(btrim(region)) between 1 and 100),
  timezone text not null check (bl.is_valid_timezone(timezone)),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- club_public -----------------------------------------------------------------------------

create table bl.club_public (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references bl.cities (id),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  name text not null check (length(btrim(name)) between 1 and 200),
  status text not null check (status in ('listed', 'claimed', 'platform')),
  club_id uuid unique references bl.clubs (id),
  visible boolean not null default true,
  address text check (length(btrim(address)) between 1 and 300),
  lat numeric(9, 6) check (lat between -90 and 90),
  lng numeric(9, 6) check (lng between -180 and 180),
  hours_text text check (length(btrim(hours_text)) between 1 and 300),
  around_the_clock boolean not null default false,
  phone text check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  url text check (url ~ '^https://[^\s<>"]{3,255}$'),
  max_url text check (max_url ~ '^https://[^\s<>"]{3,255}$'),
  telegram_url text check (telegram_url ~ '^https://t\.me/[A-Za-z0-9_]{3,64}$'),
  disciplines text[] not null default '{}' check (disciplines <@ '{pyramid,pool,snooker}'::text[]),
  tables_count smallint check (tables_count between 1 and 200),
  -- Цена от (за час) для клубов без программы — со слов клуба; у platform — из тарифов.
  price_from_kopecks bigint check (price_from_kopecks between 0 and 100000000),
  description text check (length(description) <= 2000),
  -- Кому из клуба уходят заявки гостей (владелец, подтвердивший или добавивший клуб). Не публикуется.
  contact_user_id uuid references bl.users (id),
  created_by uuid references bl.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (city_id, slug),
  check (status <> 'platform' or club_id is not null)
);
create index club_public_city_idx on bl.club_public (city_id) where visible;

-- Статус, клуб, слаг, город и видимость меняет только платформа; клуб — свои описательные поля.
create function bl.club_public_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Сервер (app_api) — по правилам ниже; миграции и сид (владелец базы) — без ограничений.
  if current_user <> 'app_api' or bl.ctx_platform_role() is not null or bl.ctx_is_platform() then
    return new;
  end if;
  if new.status is distinct from old.status or new.club_id is distinct from old.club_id
     or new.slug is distinct from old.slug or new.city_id is distinct from old.city_id
     or new.visible is distinct from old.visible or new.contact_user_id is distinct from old.contact_user_id
     or new.created_by is distinct from old.created_by then
    raise exception 'club_public: поле меняет только платформа' using errcode = '42501';
  end if;
  return new;
end
$$;
alter function bl.club_public_guard() owner to bl_owner;
create trigger club_public_guard before update on bl.club_public for each row execute function bl.club_public_guard();

-- club_requests ---------------------------------------------------------------------------
-- Статусы (m4-api.md): sent → accepted | declined (клуб) | operator (нет ответа 15 минут) →
-- closed (оператор или гость). Ответ клуба по ссылке — одноразовый токен (в базе sha256).

create table bl.club_requests (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references bl.club_public (id),
  club_id uuid references bl.clubs (id),
  user_id uuid not null references bl.users (id),
  -- Телефон гостя на момент заявки: клубу (по ссылке) и оператору — перезвонить. Гость дал его,
  -- отправляя заявку; гостей платформа и клуб без программы иначе не видят (users — RLS).
  guest_phone text check (guest_phone ~ '^\+[1-9][0-9]{7,14}$'),
  starts_at timestamptz not null,
  minutes integer not null check (minutes between 30 and 720),
  people smallint not null check (people between 1 and 20),
  comment text check (length(comment) <= 500),
  status text not null check (status in ('sent', 'accepted', 'declined', 'operator', 'closed')),
  answer_text text check (length(answer_text) <= 500),
  answered_via text check (answered_via in ('link', 'program', 'operator', 'guest')),
  token_hash text check (token_hash ~ '^[0-9a-f]{64}$'),
  token_until timestamptz,
  -- Когда передать оператору: через 15 минут, сразу — если у карточки нет контакта для заявок.
  escalate_at timestamptz not null,
  escalated_at timestamptz,
  answered_at timestamptz,
  operator_id uuid references bl.users (id),
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index club_requests_due_idx on bl.club_requests (escalate_at) where status = 'sent';
create index club_requests_user_idx on bl.club_requests (user_id, created_at desc);
create index club_requests_club_idx on bl.club_requests (club_id, created_at desc) where club_id is not null;

-- directory_claims ------------------------------------------------------------------------

create table bl.directory_claims (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('claim', 'add')),
  card_id uuid references bl.club_public (id),
  user_id uuid not null references bl.users (id),
  user_phone text check (user_phone ~ '^\+[1-9][0-9]{7,14}$'),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and length(payload::text) <= 4000),
  status text not null default 'new' check (status in ('new', 'approved', 'rejected')),
  operator_id uuid references bl.users (id),
  reason text check (length(reason) <= 2000),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (kind <> 'claim' or card_id is not null)
);
create index directory_claims_status_idx on bl.directory_claims (status, created_at);
create unique index directory_claims_open_uidx on bl.directory_claims (card_id, user_id) where kind = 'claim' and status = 'new';

-- leads -------------------------------------------------------------------------------------

create table bl.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 100),
  club_name text not null check (length(btrim(club_name)) between 1 and 200),
  city text not null check (length(btrim(city)) between 1 and 100),
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  tables_count smallint check (tables_count between 1 and 200),
  comment text check (length(comment) <= 1000),
  consent_version text not null check (length(consent_version) between 1 and 40),
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'new' check (status in ('new', 'contacted', 'demo', 'won', 'lost', 'spam')),
  note text check (length(note) <= 2000),
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index leads_ip_idx on bl.leads (ip_hash, created_at desc);
create index leads_status_idx on bl.leads (status, created_at desc);

-- reviews -----------------------------------------------------------------------------------

create table bl.reviews (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references bl.club_public (id),
  club_id uuid not null references bl.clubs (id),
  user_id uuid not null references bl.users (id),
  rating smallint not null check (rating between 1 and 5),
  text text check (length(text) <= 1000),
  status text not null default 'published' check (status in ('published', 'hidden')),
  reply_text text check (length(reply_text) <= 1000),
  replied_by uuid references bl.users (id),
  replied_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (club_id, user_id)
);
create index reviews_card_idx on bl.reviews (card_id, created_at desc) where status = 'published';

-- Оценку и текст меняет только автор, ответ — только клуб (не автор), остальное — платформа.
create function bl.reviews_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if current_user <> 'app_api' or bl.ctx_platform_role() is not null or bl.ctx_is_platform() then
    return new;
  end if;
  if (new.rating is distinct from old.rating or new.text is distinct from old.text)
     and old.user_id is distinct from bl.ctx_user_id() then
    raise exception 'reviews: оценку и текст меняет только автор' using errcode = '42501';
  end if;
  if (new.reply_text is distinct from old.reply_text or new.replied_by is distinct from old.replied_by
      or new.replied_at is distinct from old.replied_at)
     and old.user_id is not distinct from bl.ctx_user_id() then
    raise exception 'reviews: ответ даёт клуб' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    raise exception 'reviews: скрывает отзыв платформа' using errcode = '42501';
  end if;
  return new;
end
$$;
alter function bl.reviews_guard() owner to bl_owner;
create trigger reviews_guard before update on bl.reviews for each row execute function bl.reviews_guard();

create table bl.review_reports (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references bl.reviews (id),
  club_id uuid not null references bl.clubs (id),
  reporter_id uuid references bl.users (id),
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  status text not null default 'new' check (status in ('new', 'hidden', 'kept')),
  operator_id uuid references bl.users (id),
  decision_reason text check (length(decision_reason) <= 2000),
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index review_reports_status_idx on bl.review_reports (status, created_at);
create unique index review_reports_open_uidx on bl.review_reports (review_id, reporter_id) where status = 'new';

-- Владелец, RLS, права -------------------------------------------------------------------------

alter table bl.cities owner to bl_owner;
alter table bl.club_public owner to bl_owner;
alter table bl.club_requests owner to bl_owner;
alter table bl.directory_claims owner to bl_owner;
alter table bl.leads owner to bl_owner;
alter table bl.reviews owner to bl_owner;
alter table bl.review_reports owner to bl_owner;

alter table bl.cities enable row level security;
alter table bl.cities force row level security;
alter table bl.club_public enable row level security;
alter table bl.club_public force row level security;
alter table bl.club_requests enable row level security;
alter table bl.club_requests force row level security;
alter table bl.directory_claims enable row level security;
alter table bl.directory_claims force row level security;
alter table bl.leads enable row level security;
alter table bl.leads force row level security;
alter table bl.reviews enable row level security;
alter table bl.reviews force row level security;
alter table bl.review_reports enable row level security;
alter table bl.review_reports force row level security;

-- Сотрудник платформы (роль подтверждена базой) или фоновая задача платформы.
create function bl.ctx_platform_staff() returns boolean
language sql stable parallel safe
set search_path = pg_catalog, pg_temp
as $$ select bl.ctx_platform_role() is not null or bl.ctx_is_platform() $$;
alter function bl.ctx_platform_staff() owner to bl_owner;
revoke all on function bl.ctx_platform_staff() from public;
grant execute on function bl.ctx_platform_staff() to app_api;

-- cities: читают все (справочник), меняет платформа.
create policy cities_read on bl.cities for select to app_api using (true);
create policy cities_platform on bl.cities for all to app_api using (bl.ctx_platform_staff()) with check (bl.ctx_platform_staff());

-- club_public: видимые карточки читают все; свою — клуб; меняет клуб (описание) и платформа.
create policy club_public_read on bl.club_public for select to app_api
  using (visible or club_id = bl.ctx_club_id() or bl.ctx_platform_staff());
create policy club_public_club on bl.club_public for update to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy club_public_platform on bl.club_public for all to app_api
  using (bl.ctx_platform_staff()) with check (bl.ctx_platform_staff());

-- club_requests: гость — свои (создаёт в личном контексте); клуб — свои; платформа — все.
create policy club_requests_self on bl.club_requests for select to app_api using (user_id = bl.ctx_user_id());
create policy club_requests_self_insert on bl.club_requests for insert to app_api
  with check (user_id = bl.ctx_user_id() and bl.ctx_club_id() is null and status = 'sent');
-- Гость закрывает свою открытую заявку (отмена) — и только так.
create policy club_requests_self_close on bl.club_requests for update to app_api
  using (user_id = bl.ctx_user_id() and status in ('sent', 'operator'))
  with check (user_id = bl.ctx_user_id() and status = 'closed');
create policy club_requests_club on bl.club_requests for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy club_requests_platform on bl.club_requests for all to app_api
  using (bl.ctx_platform_staff()) with check (bl.ctx_platform_staff());

-- directory_claims: гость — свои; платформа — все.
create policy directory_claims_self on bl.directory_claims for select to app_api using (user_id = bl.ctx_user_id());
create policy directory_claims_self_insert on bl.directory_claims for insert to app_api
  with check (user_id = bl.ctx_user_id() and status = 'new');
create policy directory_claims_platform on bl.directory_claims for all to app_api
  using (bl.ctx_platform_staff()) with check (bl.ctx_platform_staff());

-- leads: только платформа (форма без входа пишет в контексте платформы, маршрут actor: system).
create policy leads_platform on bl.leads for all to app_api
  using (bl.ctx_platform_staff()) with check (bl.ctx_platform_staff());

-- reviews: опубликованные читают все; автор — свой; клуб — свои (ответ); платформа — все.
create policy reviews_read on bl.reviews for select to app_api
  using (status = 'published' or user_id = bl.ctx_user_id() or club_id = bl.ctx_club_id() or bl.ctx_platform_staff());
create policy reviews_author on bl.reviews for insert to app_api
  with check (user_id = bl.ctx_user_id() and club_id = bl.ctx_club_id() and status = 'published');
create policy reviews_author_update on bl.reviews for update to app_api
  using (user_id = bl.ctx_user_id() and club_id = bl.ctx_club_id()) with check (user_id = bl.ctx_user_id() and club_id = bl.ctx_club_id());
create policy reviews_club on bl.reviews for update to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy reviews_platform on bl.reviews for all to app_api
  using (bl.ctx_platform_staff()) with check (bl.ctx_platform_staff());

-- review_reports: клуб — жалобы на свои отзывы (отметка «есть жалоба»); платформа — все.
create policy review_reports_club on bl.review_reports for select to app_api using (club_id = bl.ctx_club_id());
create policy review_reports_platform on bl.review_reports for all to app_api
  using (bl.ctx_platform_staff()) with check (bl.ctx_platform_staff());

revoke all on bl.cities, bl.club_public, bl.club_requests, bl.directory_claims, bl.leads, bl.reviews, bl.review_reports from public;
grant select, insert, update on bl.cities to app_api;
grant select, insert, update on bl.club_public to app_api;
grant select, insert, update on bl.club_requests to app_api;
grant select, insert, update on bl.directory_claims to app_api;
grant select, insert, update on bl.leads to app_api;
grant select, insert on bl.reviews to app_api;
grant update (rating, text, status, reply_text, replied_by, replied_at, updated_at) on bl.reviews to app_api;
grant select, insert, update on bl.review_reports to app_api;

comment on table bl.cities is 'Города платформы (сайт /{город}/), слаг — транслит (M4 №131).';
comment on table bl.club_public is 'Карточка клуба в агрегаторе (M4 №132): listed, claimed, platform.';
comment on table bl.club_requests is 'Заявка гостя в клуб без программы (T25, №133).';
comment on table bl.directory_claims is '«Подтвердить клуб» и «Добавить клуб» → оператору платформы.';
comment on table bl.leads is 'Заявки клубов на программу (№135); IP — только хеш.';
comment on table bl.reviews is 'Отзывы гостей с игрой или бронью за 90 дней (№139), один на гостя и клуб.';
comment on table bl.review_reports is 'Жалобы на отзывы → оператору платформы.';
