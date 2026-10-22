-- 0400 (backend-pos): каталог бара и настройки платформы (контракт docs/contracts/m2.md §3,
-- decisions №76, PRODUCT §5).
--
-- Таблицы: platform_settings (настройки платформы, без клуба; qr_alcohol_allowed),
-- product_categories, products, modifier_groups, modifiers, product_modifier_groups.
-- Деньги — bigint копеек. Товары и модификаторы не удаляются (на них ссылаются строки
-- заказов): снятие с продажи — active = false. У app_api нет DELETE и TRUNCATE.
--
-- Все таблицы с club_id: ENABLE + FORCE ROW LEVEL SECURITY, политики app_api по
-- bl.ctx_club_id(). Связи по (club_id, id): строка не сошлётся на объект другого клуба.

-- Настройки платформы --------------------------------------------------------------------
-- qr_alcohol_allowed — показывать ли алкоголь в QR-меню и принимать ли его в заказе со стола
-- (decisions №76). Включает только Андрей после заключения юриста — суперпользователем:
--   update bl.platform_settings set value = 'true', updated_at = now() where key = 'qr_alcohol_allowed';
-- У app_api — только чтение.

create table bl.platform_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into bl.platform_settings (key, value) values ('qr_alcohol_allowed', 'false'::jsonb)
on conflict (key) do nothing;

comment on table bl.platform_settings is 'Настройки платформы (не клуба). Меняет только суперпользователь; app_api читает.';

-- Категории ------------------------------------------------------------------------------

create table bl.product_categories (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  sort integer not null default 0 check (sort between -1000000 and 1000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, id)
);
create unique index product_categories_name_uidx on bl.product_categories (club_id, lower(name)) where active;

-- Товары ---------------------------------------------------------------------------------
-- price_kopecks — цена за единицу; vat_code — код ставки НДС ЮKassa (NULL — ставка клуба из
-- club_payment_settings); payment_subject — предмет расчёта 54-ФЗ (как в ЮKassa и АТОЛ);
-- stop_list — снят с продажи вручную; track_stock — списывать со склада при продаже;
-- photo — путь или https-адрес картинки (загрузки файлов в M2 нет).

create table bl.products (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  category_id uuid,
  name text not null check (length(name) between 1 and 128 and name = btrim(name)),
  description text check (length(description) <= 500),
  sku text check (sku ~ '^[0-9A-Za-z._/-]{1,64}$'),
  price_kopecks bigint not null check (price_kopecks between 1 and 100000000),
  unit text not null default 'шт' check (unit in ('шт', 'порц', 'л', 'мл', 'кг', 'г')),
  is_alcohol boolean not null default false,
  vat_code smallint check (vat_code between 1 and 12),
  payment_subject text not null default 'commodity'
    check (payment_subject in ('commodity', 'excise', 'service', 'job', 'composite', 'another')),
  stop_list boolean not null default false,
  track_stock boolean not null default true,
  photo text check (length(photo) between 1 and 500),
  sort integer not null default 0 check (sort between -1000000 and 1000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, id),
  foreign key (club_id, category_id) references bl.product_categories (club_id, id)
);
create unique index products_sku_uidx on bl.products (club_id, sku) where sku is not null;
create index products_club_category_idx on bl.products (club_id, category_id, sort);

comment on table bl.products is 'Товары бара. Цена — копейки за единицу; is_alcohol скрывается из QR-меню сервером (№76).';

-- Модификаторы -----------------------------------------------------------------------------
-- Группа (объём, сахар) общая для клуба и привязывается к товарам. min_select ≥ 1 —
-- выбор обязателен (без выбора берутся модификаторы по умолчанию). price_delta_kopecks
-- прибавляется к цене единицы; stock_factor умножает списание товара со склада
-- (большой объём — 1,5 порции).

create table bl.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  min_select smallint not null default 0 check (min_select between 0 and 10),
  max_select smallint not null default 1 check (max_select between 1 and 10),
  sort integer not null default 0 check (sort between -1000000 and 1000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, id),
  check (min_select <= max_select)
);

create table bl.modifiers (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  group_id uuid not null,
  name text not null check (length(name) between 1 and 64 and name = btrim(name)),
  price_delta_kopecks bigint not null default 0 check (price_delta_kopecks between -10000000 and 10000000),
  stock_factor numeric(8, 3) not null default 1 check (stock_factor > 0 and stock_factor <= 100),
  is_default boolean not null default false,
  sort integer not null default 0 check (sort between -1000000 and 1000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, id),
  foreign key (club_id, group_id) references bl.modifier_groups (club_id, id)
);
create index modifiers_group_idx on bl.modifiers (group_id, sort);

-- Привязка групп к товару. Отвязка — active = false (без DELETE).
create table bl.product_modifier_groups (
  club_id uuid not null references bl.clubs (id),
  product_id uuid not null,
  group_id uuid not null,
  sort integer not null default 0 check (sort between -1000000 and 1000000),
  active boolean not null default true,
  primary key (product_id, group_id),
  foreign key (club_id, product_id) references bl.products (club_id, id),
  foreign key (club_id, group_id) references bl.modifier_groups (club_id, id)
);
create index product_modifier_groups_club_idx on bl.product_modifier_groups (club_id, product_id);

-- Владелец, RLS, права ---------------------------------------------------------------------

alter table bl.platform_settings owner to bl_owner;
alter table bl.product_categories owner to bl_owner;
alter table bl.products owner to bl_owner;
alter table bl.modifier_groups owner to bl_owner;
alter table bl.modifiers owner to bl_owner;
alter table bl.product_modifier_groups owner to bl_owner;

alter table bl.platform_settings enable row level security;
alter table bl.platform_settings force row level security;
alter table bl.product_categories enable row level security;
alter table bl.product_categories force row level security;
alter table bl.products enable row level security;
alter table bl.products force row level security;
alter table bl.modifier_groups enable row level security;
alter table bl.modifier_groups force row level security;
alter table bl.modifiers enable row level security;
alter table bl.modifiers force row level security;
alter table bl.product_modifier_groups enable row level security;
alter table bl.product_modifier_groups force row level security;

-- Настройки платформы читает любой запрос (в них нет данных клубов).
create policy platform_settings_read on bl.platform_settings for select to app_api using (true);

create policy product_categories_app on bl.product_categories for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy products_app on bl.products for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy modifier_groups_app on bl.modifier_groups for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy modifiers_app on bl.modifiers for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy product_modifier_groups_app on bl.product_modifier_groups for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());

revoke all on bl.platform_settings, bl.product_categories, bl.products, bl.modifier_groups, bl.modifiers,
  bl.product_modifier_groups from public;

grant select on bl.platform_settings to app_api;

grant select, insert on bl.product_categories to app_api;
grant update (name, sort, active, updated_at) on bl.product_categories to app_api;

grant select, insert on bl.products to app_api;
grant update (category_id, name, description, sku, price_kopecks, unit, is_alcohol, vat_code, payment_subject,
  stop_list, track_stock, photo, sort, active, updated_at) on bl.products to app_api;

grant select, insert on bl.modifier_groups to app_api;
grant update (name, min_select, max_select, sort, active, updated_at) on bl.modifier_groups to app_api;

grant select, insert on bl.modifiers to app_api;
grant update (name, price_delta_kopecks, stock_factor, is_default, sort, active, updated_at) on bl.modifiers to app_api;

grant select, insert on bl.product_modifier_groups to app_api;
grant update (sort, active) on bl.product_modifier_groups to app_api;
