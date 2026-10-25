-- 1350 (backend, M5.5 «Сети», docs/contracts/m5-5-8.md №190–194).
--
-- * networks — сеть: группа клубов одного владельца (№190). Создаёт владелец (bl.network_create),
--   клубы добавляет только свои (bl.network_add_club проверяет владение в базе), клуб — не больше
--   чем в одной сети (уникальный индекс по активным строкам network_clubs).
-- * network_clubs — клубы сети (история: удалённый клуб — строка с removed_at); override и
--   применённые версии шаблонов — по клубу.
-- * network_members — управляющие сети (№192): приглашение по телефону, привязка при входе
--   (bl.network_accept_invites). Доступ к клубам сети даёт членство в сети: узкая функция
--   bl.network_sync_access держит строки club_members (role = 'manager', network_id = сеть) в
--   каждом клубе сети. RLS по club_id не меняется: управляющий сети работает в контексте клуба,
--   как управляющий клуба; app_api не может ни выдать, ни поменять такие строки (триггер).
-- * network_tariff_rules, network_products — шаблоны тарифов и меню сети (№191). Цена — копейки,
--   строго > 0 (№163). Правило тарифа хранится в виде мастера (jsonb), время — местное: в каждом
--   клубе правило считается по его поясу и рабочим суткам.
-- * products.network_product_id, products.network_override — товар клуба из шаблона меню и
--   «переопределён клубом» (мягкий шаблон).
-- * billing_plans: план «Сеть» (№194, PRODUCT §17 — гипотеза 1 190 ₽ за стол, цену задаёт
--   platform_admin через PUT /api/platform/plans/{id}); включается клубам сети из двух и более
--   клубов (bl.network_sync_billing и триггер вставки подписки). Логика счетов не меняется.

-- Сети ------------------------------------------------------------------------------------------

create table bl.networks (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references bl.users (id),
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  tariffs_mode text not null default 'soft' check (tariffs_mode in ('hard', 'soft')),
  menu_mode text not null default 'soft' check (menu_mode in ('hard', 'soft')),
  tariffs_template boolean not null default false,
  tariffs_version integer not null default 0 check (tariffs_version >= 0),
  menu_template boolean not null default false,
  menu_version integer not null default 0 check (menu_version >= 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index networks_owner_idx on bl.networks (owner_user_id) where archived_at is null;

comment on table bl.networks is 'Сеть клубов одного владельца (M5.5 №190): шаблоны тарифов и меню, режим hard|soft (№191).';
comment on column bl.networks.tariffs_mode is 'hard — клуб не переопределяет шаблон тарифов; soft — может (тогда шаблон его не меняет).';

create table bl.network_clubs (
  id uuid primary key default gen_random_uuid(),
  network_id uuid not null references bl.networks (id),
  club_id uuid not null references bl.clubs (id),
  active boolean not null default true,
  tariffs_override boolean not null default false,
  tariffs_version integer not null default 0 check (tariffs_version >= 0),
  menu_version integer not null default 0 check (menu_version >= 0),
  added_by uuid not null references bl.users (id),
  added_at timestamptz not null default now(),
  removed_by uuid references bl.users (id),
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (active = (removed_at is null))
);
-- Клуб — не больше чем в одной сети (№190).
create unique index network_clubs_one_network on bl.network_clubs (club_id) where active;
create index network_clubs_network_idx on bl.network_clubs (network_id) where active;

comment on table bl.network_clubs is 'Клубы сети (M5.5): активная строка — клуб в сети; удалённый — removed_at. Версии — применённые шаблоны.';

create table bl.network_members (
  id uuid primary key default gen_random_uuid(),
  network_id uuid not null references bl.networks (id),
  role text not null default 'manager' check (role = 'manager'),
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  user_id uuid references bl.users (id),
  invited_by uuid not null references bl.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references bl.users (id),
  check (expires_at > created_at),
  check ((accepted_at is null) = (user_id is null))
);
create unique index network_members_open_invite on bl.network_members (network_id, phone) where accepted_at is null and revoked_at is null;
create unique index network_members_active on bl.network_members (network_id, user_id) where accepted_at is not null and revoked_at is null;
create index network_members_phone_idx on bl.network_members (phone) where accepted_at is null and revoked_at is null;

comment on table bl.network_members is 'Управляющие сети (M5.5 №192): приглашение по телефону на 7 дней, привязка при входе.';

-- Шаблон тарифов: правило мастера (server/setup/tariffs.mjs normalizeRules) целиком в rule;
-- цена — отдельным столбцом для проверки базы (№163: строго > 0).
create table bl.network_tariff_rules (
  id uuid primary key default gen_random_uuid(),
  network_id uuid not null references bl.networks (id),
  version integer not null check (version >= 1),
  ord smallint not null check (ord between 0 and 999),
  rule jsonb not null check (jsonb_typeof(rule) = 'object' and octet_length(rule::text) <= 4000),
  price_per_hour bigint not null check (price_per_hour > 0 and price_per_hour <= 100000000),
  active boolean not null default true,
  created_by uuid not null references bl.users (id),
  created_at timestamptz not null default now(),
  check ((rule ->> 'price_per_hour_kopecks') = price_per_hour::text)
);
create index network_tariff_rules_active_idx on bl.network_tariff_rules (network_id, ord) where active;

comment on table bl.network_tariff_rules is 'Шаблон тарифов сети (M5.5 №191): правило мастера в местном времени клуба; цена > 0 (№163).';

create table bl.network_products (
  id uuid primary key default gen_random_uuid(),
  network_id uuid not null references bl.networks (id),
  category text check (length(category) between 1 and 100 and category = btrim(category)),
  name text not null check (length(name) between 1 and 128 and name = btrim(name)),
  description text check (length(description) <= 500),
  sku text check (sku ~ '^[0-9A-Za-z._/-]{1,64}$'),
  price_kopecks bigint not null check (price_kopecks between 1 and 100000000),
  unit text not null default 'шт' check (unit in ('шт', 'порц', 'л', 'мл', 'кг', 'г')),
  is_alcohol boolean not null default false,
  vat_code smallint check (vat_code between 1 and 12),
  payment_subject text not null default 'commodity'
    check (payment_subject in ('commodity', 'excise', 'service', 'job', 'composite', 'another')),
  sort integer not null default 0 check (sort between -1000000 and 1000000),
  active boolean not null default true,
  updated_by uuid not null references bl.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index network_products_sku_uidx on bl.network_products (network_id, sku) where sku is not null and active;
create unique index network_products_name_uidx on bl.network_products (network_id, lower(coalesce(category, '')), lower(name)) where active;

comment on table bl.network_products is 'Шаблон меню сети (M5.5 №191): товар, цена в копейках; алкоголь гостю в QR-меню не показывается (№76).';

-- Связь клуба с сетью в существующих таблицах --------------------------------------------------

alter table bl.club_members add column network_id uuid references bl.networks (id);
comment on column bl.club_members.network_id is
  'M5.5 №192: доступ управляющего сети (role manager), выдан и снимается только bl.network_sync_access; NULL — член клуба напрямую.';

alter table bl.products
  add column network_product_id uuid references bl.network_products (id),
  add column network_override boolean not null default false;
create unique index products_network_product_uidx on bl.products (club_id, network_product_id) where network_product_id is not null;
grant update (network_product_id, network_override) on bl.products to app_api;
comment on column bl.products.network_product_id is 'M5.5: товар из шаблона меню сети; NULL — свой товар клуба.';
comment on column bl.products.network_override is 'M5.5: клуб переопределил товар шаблона (мягкий шаблон) — шаблон его больше не меняет.';

-- Строки управляющего сети в club_members: app_api не выдаёт и не меняет (роль, активность, сеть).
-- Функция триггера — SECURITY INVOKER: current_user — та роль, что выполняет запрос
-- (внутри узких функций — bl_definer).
create function bl.club_members_network_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if current_user = 'app_api' then
    if tg_op = 'INSERT' and new.network_id is not null then
      raise exception 'club_members.network_id: only bl.network_sync_access' using errcode = 'BLN10';
    end if;
    if tg_op = 'UPDATE' and (new.network_id is distinct from old.network_id
         or (old.network_id is not null and (new.role is distinct from old.role or new.active is distinct from old.active))) then
      raise exception 'club_members: network manager is managed by the network' using errcode = 'BLN10';
    end if;
  end if;
  return new;
end
$$;
create trigger club_members_network_guard before insert or update on bl.club_members
  for each row execute function bl.club_members_network_guard();

-- Владельцы и RLS -------------------------------------------------------------------------------

alter table bl.networks owner to bl_owner;
alter table bl.network_clubs owner to bl_owner;
alter table bl.network_members owner to bl_owner;
alter table bl.network_tariff_rules owner to bl_owner;
alter table bl.network_products owner to bl_owner;

alter table bl.networks enable row level security;
alter table bl.networks force row level security;
alter table bl.network_clubs enable row level security;
alter table bl.network_clubs force row level security;
alter table bl.network_members enable row level security;
alter table bl.network_members force row level security;
alter table bl.network_tariff_rules enable row level security;
alter table bl.network_tariff_rules force row level security;
alter table bl.network_products enable row level security;
alter table bl.network_products force row level security;

revoke all on bl.networks, bl.network_clubs, bl.network_members, bl.network_tariff_rules, bl.network_products from public;

-- Узкие функции видят таблицы сети целиком.
grant select, insert, update on bl.networks, bl.network_clubs, bl.network_members to bl_definer;
grant select on bl.network_tariff_rules, bl.network_products to bl_definer;
create policy networks_definer on bl.networks for all to bl_definer using (true) with check (true);
create policy network_clubs_definer on bl.network_clubs for all to bl_definer using (true) with check (true);
create policy network_members_definer on bl.network_members for all to bl_definer using (true) with check (true);
create policy network_tariff_rules_definer on bl.network_tariff_rules for select to bl_definer using (true);
create policy network_products_definer on bl.network_products for select to bl_definer using (true);
grant select (network_id, pin_hash, pin_failed_count, pin_locked_until) on bl.club_members to bl_definer;
grant insert (network_id, active) on bl.club_members to bl_definer;
grant update (network_id) on bl.club_members to bl_definer;
grant select (id, name, phone, merged_into) on bl.users to bl_definer;
grant select (id, user_id, kind, club_id, revoked_at) on bl.auth_tokens to bl_definer;

-- Кто видит сеть из контекста запроса: 'owner' | 'manager' (личный контекст, app.club_id пуст)
-- или 'club' (контекст клуба этой сети); иначе NULL. Политики таблиц сети — через неё.
create function bl.network_access(p_network uuid) returns text
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select case
    when nullif(pg_catalog.current_setting('app.club_id', true), '') is null then
      case
        when exists (select 1 from bl.networks n
                      where n.id = p_network and n.archived_at is null
                        and n.owner_user_id = nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid) then 'owner'
        when exists (select 1 from bl.network_members m join bl.networks n on n.id = m.network_id
                      where m.network_id = p_network and n.archived_at is null
                        and m.user_id = nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
                        and m.accepted_at is not null and m.revoked_at is null) then 'manager'
      end
    when exists (select 1 from bl.network_clubs c join bl.networks n on n.id = c.network_id
                  where c.network_id = p_network and c.active and n.archived_at is null
                    and c.club_id = nullif(pg_catalog.current_setting('app.club_id', true), '')::uuid) then 'club'
  end
$$;
alter function bl.network_access(uuid) owner to bl_definer;
revoke all on function bl.network_access(uuid) from public;
grant execute on function bl.network_access(uuid) to app_api;
comment on function bl.network_access(uuid) is
  'SECURITY DEFINER: доступ к сети из контекста — owner | manager (личный контекст) | club (контекст клуба сети) | NULL.';

-- networks: видят владелец, управляющие сети и клуб сети; меняет только владелец в личном контексте
-- (название, режимы, версии шаблонов). Создание и архив — узкие функции.
create policy networks_read on bl.networks for select to app_api using (bl.network_access(id) is not null);
create policy networks_owner_update on bl.networks for update to app_api
  using (bl.network_access(id) = 'owner')
  with check (bl.network_access(id) = 'owner' and owner_user_id = bl.ctx_user_id());
grant select on bl.networks to app_api;
grant update (name, tariffs_mode, menu_mode, tariffs_template, tariffs_version, menu_template, menu_version, updated_at) on bl.networks to app_api;

-- network_clubs: клуб видит свою строку (контекст клуба); владелец и управляющие — клубы сети.
-- Клуб (сервер в его контексте) отмечает переопределение и применённые версии; состав — только
-- узкими функциями.
create policy network_clubs_read on bl.network_clubs for select to app_api
  using (club_id = bl.ctx_club_id() or (bl.ctx_club_id() is null and bl.network_access(network_id) in ('owner', 'manager')));
create policy network_clubs_club_update on bl.network_clubs for update to app_api
  using (club_id = bl.ctx_club_id() and active)
  with check (club_id = bl.ctx_club_id() and active);
grant select on bl.network_clubs to app_api;
grant update (tariffs_override, tariffs_version, menu_version, updated_at) on bl.network_clubs to app_api;

-- network_members: владелец видит приглашения и управляющих своей сети; пользователь — свои строки.
-- Писать app_api не может (узкие функции).
create policy network_members_read on bl.network_members for select to app_api
  using (bl.ctx_club_id() is null and (bl.network_access(network_id) = 'owner' or user_id = bl.ctx_user_id()));
grant select on bl.network_members to app_api;

-- Шаблоны: читают владелец, управляющие и клубы сети; пишет только владелец в личном контексте.
create policy network_tariff_rules_read on bl.network_tariff_rules for select to app_api using (bl.network_access(network_id) is not null);
create policy network_tariff_rules_owner_insert on bl.network_tariff_rules for insert to app_api
  with check (bl.network_access(network_id) = 'owner' and created_by = bl.ctx_user_id());
create policy network_tariff_rules_owner_update on bl.network_tariff_rules for update to app_api
  using (bl.network_access(network_id) = 'owner')
  with check (bl.network_access(network_id) = 'owner');
grant select, insert on bl.network_tariff_rules to app_api;
grant update (active) on bl.network_tariff_rules to app_api;

create policy network_products_read on bl.network_products for select to app_api using (bl.network_access(network_id) is not null);
create policy network_products_owner_insert on bl.network_products for insert to app_api
  with check (bl.network_access(network_id) = 'owner' and updated_by = bl.ctx_user_id());
create policy network_products_owner_update on bl.network_products for update to app_api
  using (bl.network_access(network_id) = 'owner')
  with check (bl.network_access(network_id) = 'owner' and updated_by = bl.ctx_user_id());
grant select, insert on bl.network_products to app_api;
grant update (category, name, description, sku, price_kopecks, unit, is_alcohol, vat_code, payment_subject, sort, active, updated_by, updated_at)
  on bl.network_products to app_api;

-- План подписки «Сеть» (№194) --------------------------------------------------------------------

insert into bl.billing_plans (id, code, title, price_per_table_kopecks, trial_days)
values ('bf000000-0000-4000-8000-000000000002', 'network', 'Сеть', 119000, 60)
on conflict (code) do nothing;

grant select (club_id, plan_id) on bl.club_subscriptions to bl_definer;
grant update (plan_id, updated_at) on bl.club_subscriptions to bl_definer;

-- План клуба по сети: «Сеть», если клуб в активной сети из 2+ клубов и план включён; иначе NULL.
create function bl.network_plan_for(p_club uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select p.id
    from bl.network_clubs c
    join bl.networks n on n.id = c.network_id and n.archived_at is null
    join bl.billing_plans p on p.code = 'network' and p.active
   where c.club_id = p_club and c.active
     and (select count(*) from bl.network_clubs x where x.network_id = c.network_id and x.active) >= 2
   limit 1
$$;
alter function bl.network_plan_for(uuid) owner to bl_definer;
revoke all on function bl.network_plan_for(uuid) from public;

-- План подписок клубов сети (и бывших клубов сети): «Сеть» ↔ «Клуб». Другие планы и персональная
-- цена не трогаются; новая цена действует со следующего счёта (логика счетов M5.3 не меняется).
create function bl.network_sync_billing(p_network uuid) returns integer
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_club_plan uuid;
  v_n integer := 0;
  r record;
  v_want uuid;
begin
  select p.id into v_club_plan from bl.billing_plans p where p.code = 'club';
  for r in
    select s.club_id, s.plan_id
      from bl.club_subscriptions s join bl.billing_plans p on p.id = s.plan_id and p.code in ('club', 'network')
     where s.club_id in (select c.club_id from bl.network_clubs c where c.network_id = p_network)
     for update of s
  loop
    v_want := coalesce(bl.network_plan_for(r.club_id), v_club_plan);
    if v_want is distinct from r.plan_id then
      update bl.club_subscriptions set plan_id = v_want, updated_at = now() where club_id = r.club_id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end
$$;
alter function bl.network_sync_billing(uuid) owner to bl_definer;
revoke all on function bl.network_sync_billing(uuid) from public;

-- Подписка, созданная клубу сети (переход в live), сразу получает план «Сеть».
create function bl.club_subscriptions_network_plan() returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_plan uuid;
begin
  if exists (select 1 from bl.billing_plans p where p.id = new.plan_id and p.code = 'club') then
    v_plan := bl.network_plan_for(new.club_id);
    if v_plan is not null then
      new.plan_id := v_plan;
    end if;
  end if;
  return new;
end
$$;
alter function bl.club_subscriptions_network_plan() owner to bl_definer;
revoke all on function bl.club_subscriptions_network_plan() from public;
create trigger club_subscriptions_network_plan before insert on bl.club_subscriptions
  for each row execute function bl.club_subscriptions_network_plan();

-- Доступ управляющих сети --------------------------------------------------------------------------

-- Строки club_members управляющих сети: в каждом активном клубе сети у каждого принятого и не
-- отозванного управляющего — role manager, network_id = сеть. Прямое активное членство в клубе
-- (любая роль) не трогается. Лишние строки сети гаснут (PIN стирается, PIN-токены клуба
-- отзываются, network_id — NULL). Возвращает число изменённых строк.
create function bl.network_sync_access(p_network uuid) returns integer
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_n integer := 0;
  v_k integer;
  v_live boolean;
  r record;
begin
  select n.archived_at is null into v_live from bl.networks n where n.id = p_network;
  -- Выдать.
  if coalesce(v_live, false) then
    for r in
      select c.club_id, m.user_id
        from bl.network_clubs c
        join bl.network_members m on m.network_id = c.network_id and m.accepted_at is not null and m.revoked_at is null
       where c.network_id = p_network and c.active
    loop
      insert into bl.club_members (club_id, user_id, role, network_id, active)
      values (r.club_id, r.user_id, 'manager', p_network, true)
      on conflict (club_id, user_id) do update
        set role = 'manager', active = true, network_id = excluded.network_id, pin_hash = null
        where not bl.club_members.active;
      get diagnostics v_k = row_count;
      v_n := v_n + v_k;
    end loop;
  end if;
  -- Снять лишнее.
  for r in
    select cm.club_id, cm.user_id
      from bl.club_members cm
     where cm.network_id = p_network and cm.active
       and not (coalesce(v_live, false)
                and exists (select 1 from bl.network_clubs c where c.network_id = p_network and c.club_id = cm.club_id and c.active)
                and exists (select 1 from bl.network_members m where m.network_id = p_network and m.user_id = cm.user_id
                              and m.accepted_at is not null and m.revoked_at is null))
  loop
    update bl.club_members
       set active = false, network_id = null, pin_hash = null, pin_failed_count = 0, pin_locked_until = null
     where club_id = r.club_id and user_id = r.user_id;
    update bl.auth_tokens set revoked_at = now()
     where user_id = r.user_id and club_id = r.club_id and kind = 'pin' and revoked_at is null;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;
alter function bl.network_sync_access(uuid) owner to bl_definer;
revoke all on function bl.network_sync_access(uuid) from public;

-- Узкие функции API сети (личный контекст пользователя) --------------------------------------------

-- Проверка: пользователь из контекста, личный контекст, actor user. Возвращает пользователя.
create function bl.network_me() returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_me uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
begin
  if v_me is null or nullif(pg_catalog.current_setting('app.club_id', true), '') is not null
     or nullif(pg_catalog.current_setting('app.actor_type', true), '') is distinct from 'user' then
    raise exception 'network: signed-in user in personal context only' using errcode = '42501';
  end if;
  return v_me;
end
$$;
alter function bl.network_me() owner to bl_definer;
revoke all on function bl.network_me() from public;

-- Сеть владельца из контекста (не в архиве) под блокировкой; иначе BLN03 (нет сети или не его).
create function bl.network_owned(p_network uuid) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_me uuid := bl.network_me();
  v_id uuid;
begin
  select n.id into v_id from bl.networks n
   where n.id = p_network and n.owner_user_id = v_me and n.archived_at is null
   for update;
  if v_id is null then
    raise exception 'network: not found or not owner' using errcode = 'BLN03';
  end if;
  return v_me;
end
$$;
alter function bl.network_owned(uuid) owner to bl_definer;
revoke all on function bl.network_owned(uuid) from public;

-- Создать сеть: владелец — пользователь из контекста; не больше 5 сетей. BLN05 — лимит.
create function bl.network_create(p_name text) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_me uuid := bl.network_me();
  v_name text := btrim(p_name);
  v_id uuid;
begin
  if v_name is null or length(v_name) < 1 or length(v_name) > 100 then
    raise exception 'network: name' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bl.network_create:' || v_me::text, 0));
  if (select count(*) from bl.networks n where n.owner_user_id = v_me and n.archived_at is null) >= 5 then
    raise exception 'network: limit' using errcode = 'BLN05';
  end if;
  insert into bl.networks (owner_user_id, name) values (v_me, v_name) returning id into v_id;
  return v_id;
end
$$;

-- Добавить клуб в сеть (№190): только свою сеть и только клуб, где пользователь — активный
-- владелец напрямую. BLN01 — не владелец клуба; BLN02 — клуб уже в другой сети; BLN04 — 100 клубов.
-- Повтор — та же строка. Затем доступ управляющих и план подписки.
create function bl.network_add_club(p_network uuid, p_club uuid) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_me uuid := bl.network_owned(p_network);
  v_row record;
  v_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bl.network_club:' || coalesce(p_club::text, ''), 0));
  if p_club is null or not exists (
       select 1 from bl.club_members m
        where m.club_id = p_club and m.user_id = v_me and m.role = 'owner' and m.active and m.network_id is null) then
    raise exception 'network: not owner of the club' using errcode = 'BLN01';
  end if;
  select c.id, c.network_id into v_row from bl.network_clubs c where c.club_id = p_club and c.active;
  if v_row.id is not null then
    if v_row.network_id = p_network then
      return v_row.id;
    end if;
    raise exception 'network: club is in another network' using errcode = 'BLN02';
  end if;
  if (select count(*) from bl.network_clubs c where c.network_id = p_network and c.active) >= 100 then
    raise exception 'network: clubs limit' using errcode = 'BLN04';
  end if;
  insert into bl.network_clubs (network_id, club_id, added_by) values (p_network, p_club, v_me) returning id into v_id;
  update bl.networks set updated_at = now() where id = p_network;
  perform bl.network_sync_access(p_network);
  perform bl.network_sync_billing(p_network);
  return v_id;
end
$$;

-- Убрать клуб из сети: строка гаснет, доступ управляющих сети к клубу снимается, план — «Клуб».
-- Нет клуба в этой сети — false.
create function bl.network_remove_club(p_network uuid, p_club uuid) returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_me uuid := bl.network_owned(p_network);
  v_n integer;
begin
  update bl.network_clubs set active = false, removed_at = now(), removed_by = v_me, updated_at = now()
   where network_id = p_network and club_id = p_club and active;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return false;
  end if;
  update bl.networks set updated_at = now() where id = p_network;
  perform bl.network_sync_access(p_network);
  perform bl.network_sync_billing(p_network);
  return true;
end
$$;

-- Пригласить управляющего сети по телефону (до p_expires). Открытое приглашение на номер —
-- продлевается. BLN06 — номер уже управляющий этой сети.
create function bl.network_invite(p_network uuid, p_phone text, p_expires timestamptz) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_me uuid := bl.network_owned(p_network);
  v_id uuid;
begin
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' or p_expires is null or p_expires <= now() then
    raise exception 'network: invite' using errcode = '22023';
  end if;
  if exists (select 1 from bl.network_members m join bl.users u on u.id = m.user_id
              where m.network_id = p_network and m.accepted_at is not null and m.revoked_at is null and u.phone = p_phone) then
    raise exception 'network: already manager' using errcode = 'BLN06';
  end if;
  update bl.network_members set expires_at = p_expires
   where network_id = p_network and phone = p_phone and accepted_at is null and revoked_at is null
   returning id into v_id;
  if v_id is null then
    insert into bl.network_members (network_id, phone, invited_by, expires_at)
    values (p_network, p_phone, v_me, p_expires) returning id into v_id;
  end if;
  return v_id;
end
$$;

-- Отозвать приглашение или управляющего сети: доступ ко всем клубам сети снимается сразу.
create function bl.network_revoke_member(p_network uuid, p_member uuid) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_me uuid := bl.network_owned(p_network);
  v_user uuid;
  v_n integer;
begin
  update bl.network_members set revoked_at = now(), revoked_by = v_me
   where id = p_member and network_id = p_network and revoked_at is null
   returning user_id into v_user;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'network: member not found' using errcode = 'BLN07';
  end if;
  perform bl.network_sync_access(p_network);
  return v_user;
end
$$;

-- Приглашения в сети на номер пользователя из контекста (при входе): привязать и выдать доступ.
create function bl.network_accept_invites()
returns table (member_id uuid, network_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  v_me uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  v_phone text;
  r record;
begin
  if v_me is null then
    return;
  end if;
  select u.phone into v_phone from bl.users u where u.id = v_me and u.merged_into is null;
  if v_phone is null then
    return;
  end if;
  for r in
    select m.id, m.network_id from bl.network_members m join bl.networks n on n.id = m.network_id and n.archived_at is null
     where m.phone = v_phone and m.accepted_at is null and m.revoked_at is null and m.expires_at > now()
       and n.owner_user_id <> v_me
       and not exists (select 1 from bl.network_members x where x.network_id = m.network_id and x.user_id = v_me
                         and x.accepted_at is not null and x.revoked_at is null)
     for update of m
  loop
    update bl.network_members set user_id = v_me, accepted_at = now() where id = r.id;
    perform bl.network_sync_access(r.network_id);
    member_id := r.id;
    network_id := r.network_id;
    return next;
  end loop;
end
$$;

-- Управляющие и приглашения сети — владельцу: телефон (сервер маскирует), имя принявшего.
create function bl.network_members_list(p_network uuid)
returns table (id uuid, phone text, user_id uuid, name text, created_at timestamptz, expires_at timestamptz, accepted_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
begin
  if bl.network_access(p_network) is distinct from 'owner' then
    raise exception 'network: owner only' using errcode = 'BLN03';
  end if;
  return query
    select m.id, coalesce(u.phone, m.phone), m.user_id, u.name, m.created_at, m.expires_at, m.accepted_at
      from bl.network_members m left join bl.users u on u.id = m.user_id
     where m.network_id = p_network and m.revoked_at is null
       and (m.accepted_at is not null or m.expires_at > now())
     order by m.accepted_at nulls last, m.created_at;
end
$$;

-- Архив сети: клубы выходят, управляющие отзываются, доступ снимается, планы — «Клуб».
create function bl.network_archive(p_network uuid) returns integer
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_me uuid := bl.network_owned(p_network);
  v_n integer;
begin
  update bl.network_clubs set active = false, removed_at = now(), removed_by = v_me, updated_at = now()
   where network_id = p_network and active;
  get diagnostics v_n = row_count;
  update bl.network_members set revoked_at = now(), revoked_by = v_me where network_id = p_network and revoked_at is null;
  update bl.networks set archived_at = now(), updated_at = now() where id = p_network;
  perform bl.network_sync_access(p_network);
  perform bl.network_sync_billing(p_network);
  return v_n;
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'bl.network_create(text)', 'bl.network_add_club(uuid, uuid)', 'bl.network_remove_club(uuid, uuid)',
    'bl.network_invite(uuid, text, timestamptz)', 'bl.network_revoke_member(uuid, uuid)', 'bl.network_accept_invites()',
    'bl.network_members_list(uuid)', 'bl.network_archive(uuid)'
  ] loop
    execute format('alter function %s owner to bl_definer', f);
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to app_api', f);
  end loop;
end
$$;

comment on function bl.network_create(text) is 'SECURITY DEFINER (M5.5 №190): сеть пользователя из личного контекста, не больше 5.';
comment on function bl.network_add_club(uuid, uuid) is
  'SECURITY DEFINER (M5.5 №190): добавить свой клуб (владелец напрямую) в свою сеть; клуб — не больше чем в одной сети.';
comment on function bl.network_remove_club(uuid, uuid) is 'SECURITY DEFINER (M5.5): убрать клуб из своей сети.';
comment on function bl.network_invite(uuid, text, timestamptz) is 'SECURITY DEFINER (M5.5 №192): пригласить управляющего сети по телефону.';
comment on function bl.network_revoke_member(uuid, uuid) is 'SECURITY DEFINER (M5.5 №192): отозвать управляющего сети, доступ к клубам снимается.';
comment on function bl.network_accept_invites() is 'SECURITY DEFINER (M5.5 №192): при входе — привязать приглашения в сети на номер пользователя.';
comment on function bl.network_members_list(uuid) is 'SECURITY DEFINER (M5.5): управляющие и приглашения сети — только владельцу.';
comment on function bl.network_archive(uuid) is 'SECURITY DEFINER (M5.5): архив сети — клубы выходят, управляющие отзываются.';
