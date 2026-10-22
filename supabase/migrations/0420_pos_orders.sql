-- 0420 (backend-pos): заказы бара, продажи кассы и возвраты (контракт m2.md §3–§5,
-- decisions №79, №81–83).
--
-- orders       — заказ: со стола (source qr: онлайн или в счёт стола) или с кассы (source pos).
--                Статусы бара: new → preparing → ready → served, canceled.
--                committed_at — заказ «настоящий»: в счёте стола, оплачен онлайн или пробит
--                на кассе; только такие видит бар. paid_at и sale_id — чем оплачен.
-- order_items  — строки заказа со снимком цены, модификаторов, НДС и предмета расчёта.
-- pos_sales    — одна оплата бара: касса ресепшена (channel pos: наличные, терминал, СБП по QR)
--                или гость онлайн (channel guest: заказ со стола, счёт стола). Платёж —
--                строка bl.payments (kind bar); заявки стола в той же продаже — платежи money.
-- pos_sale_items    — строки заказов, оплаченные продажей (сумма после скидки), возвраты.
-- pos_sale_requests — заявки стола M1, принятые в продаже (через money, их платежи и чеки).
-- pos_refunds  — возвраты продаж: с причиной (персонал) или автоматические (двойная оплата).
--
-- Все таблицы с club_id: ENABLE + FORCE RLS по bl.ctx_club_id(); у app_api нет DELETE и
-- TRUNCATE; UPDATE — только столбцов состояния (суммы и состав после вставки не меняются).
-- Конечные состояния защищены триггерами (orders_guard, pos_sales_guard).

-- Заказы ----------------------------------------------------------------------------------

create table bl.orders (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  number integer not null check (number between 1 and 1000000),
  source text not null check (source in ('qr', 'pos')),
  pay_mode text not null check (pay_mode in ('online', 'tab', 'pos')),
  status text not null default 'new' check (status in ('new', 'preparing', 'ready', 'served', 'canceled')),
  session_id uuid,
  resource_id uuid,
  user_id uuid references bl.users (id),
  created_by uuid references bl.users (id),
  subtotal_kopecks bigint not null check (subtotal_kopecks > 0),
  comment text check (length(comment) between 1 and 200),
  request_key uuid,
  committed_at timestamptz,
  paid_at timestamptz,
  sale_id uuid,
  payment_id uuid,
  status_at timestamptz not null,
  preparing_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid references bl.users (id),
  cancel_reason text check (length(cancel_reason) between 1 and 2000),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (club_id, id),
  unique (club_id, request_key),
  foreign key (club_id, session_id) references bl.sessions (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  foreign key (club_id, payment_id) references bl.payments (club_id, id),
  check ((source = 'pos') = (pay_mode = 'pos')),
  check (source = 'pos' or (session_id is not null and user_id is not null)),
  check (source = 'qr' or created_by is not null),
  check (status <> 'canceled' or canceled_at is not null),
  check (paid_at is null or (sale_id is not null and committed_at is not null))
);
create index orders_queue_idx on bl.orders (club_id, created_at) where status in ('new', 'preparing', 'ready');
create index orders_tab_idx on bl.orders (session_id) where pay_mode = 'tab' and paid_at is null and status <> 'canceled';
create index orders_session_idx on bl.orders (session_id, created_at) where session_id is not null;
create index orders_club_created_idx on bl.orders (club_id, created_at desc);

comment on table bl.orders is 'Заказы бара (контракт M2 §3): со стола (qr) и с кассы (pos); счёт стола — pay_mode tab (№79).';

create table bl.order_items (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  order_id uuid not null,
  position smallint not null check (position between 0 and 99),
  product_id uuid not null,
  name text not null check (length(name) between 1 and 128),
  qty integer not null check (qty between 1 and 100),
  unit_price_kopecks bigint not null check (unit_price_kopecks > 0),
  amount_kopecks bigint not null check (amount_kopecks = unit_price_kopecks * qty),
  modifiers jsonb not null default '[]'::jsonb check (jsonb_typeof(modifiers) = 'array'),
  stock_factor numeric(12, 3) not null default 1 check (stock_factor > 0),
  track_stock boolean not null,
  is_alcohol boolean not null,
  vat_code smallint not null check (vat_code between 1 and 12),
  payment_subject text not null check (payment_subject in ('commodity', 'excise', 'service', 'job', 'composite', 'another')),
  created_at timestamptz not null,
  unique (club_id, id),
  foreign key (club_id, order_id) references bl.orders (club_id, id),
  foreign key (club_id, product_id) references bl.products (club_id, id)
);
create unique index order_items_order_position_uidx on bl.order_items (order_id, position);

-- Продажи ---------------------------------------------------------------------------------
-- bar_total_kopecks — сумма платежа бара (payment_id); table_kopecks — заявки стола,
-- оплаченные в этой же продаже (платежи money в pos_sale_requests). shift_id — смена
-- server/shifts (backend-kkt, 0500+), внешний ключ добавляет kkt. receipt_id — чек продажи
-- бара (bl.receipts: ККТ или ЮKassa).

create table bl.pos_sales (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  channel text not null check (channel in ('pos', 'guest')),
  method text not null check (method in ('cash', 'card_terminal', 'sbp', 'card')),
  status text not null check (status in ('pending', 'completed', 'canceled')),
  payment_id uuid,
  session_id uuid,
  user_id uuid references bl.users (id),
  created_by uuid references bl.users (id),
  shift_id uuid,
  bar_subtotal_kopecks bigint not null default 0 check (bar_subtotal_kopecks >= 0),
  discount_kopecks bigint not null default 0 check (discount_kopecks >= 0),
  bar_total_kopecks bigint not null default 0 check (bar_total_kopecks >= 0),
  table_kopecks bigint not null default 0 check (table_kopecks >= 0),
  received_kopecks bigint check (received_kopecks >= 0),
  change_kopecks bigint check (change_kopecks >= 0),
  discount_reason text check (length(discount_reason) between 1 and 2000),
  discount_over_limit boolean not null default false,
  refunded_kopecks bigint not null default 0 check (refunded_kopecks >= 0),
  receipt_id uuid,
  request_key uuid,
  created_at timestamptz not null,
  completed_at timestamptz,
  canceled_at timestamptz,
  updated_at timestamptz not null,
  unique (club_id, id),
  unique (club_id, request_key),
  foreign key (club_id, payment_id) references bl.payments (club_id, id),
  foreign key (club_id, session_id) references bl.sessions (club_id, id),
  check (bar_total_kopecks = bar_subtotal_kopecks - discount_kopecks),
  check ((bar_total_kopecks > 0) = (payment_id is not null)),
  check (bar_total_kopecks + table_kopecks > 0),
  check (refunded_kopecks <= bar_total_kopecks),
  check (channel = 'pos' or (user_id is not null and method in ('sbp', 'card') and table_kopecks = 0 and discount_kopecks = 0)),
  check (channel = 'guest' or (created_by is not null and method in ('cash', 'card_terminal', 'sbp'))),
  check (method = 'cash' or (received_kopecks is null and change_kopecks is null)),
  check (method <> 'cash' or (received_kopecks is not null and change_kopecks is not null)),
  check (status <> 'completed' or completed_at is not null),
  check (status <> 'canceled' or canceled_at is not null),
  check (discount_kopecks = 0 or channel = 'pos')
);
create unique index pos_sales_payment_uidx on bl.pos_sales (payment_id) where payment_id is not null;
create index pos_sales_club_created_idx on bl.pos_sales (club_id, created_at desc);
create index pos_sales_pending_idx on bl.pos_sales (club_id, created_at) where status = 'pending';
create index pos_sales_session_idx on bl.pos_sales (session_id) where session_id is not null;

comment on table bl.pos_sales is 'Оплаты бара: касса ресепшена (pos) и гость онлайн (guest). Платёж — bl.payments kind bar.';

alter table bl.orders add constraint orders_sale_fk foreign key (club_id, sale_id) references bl.pos_sales (club_id, id);

-- outcome: pending — ждёт оплаты; paid — заказ оплачен этой продажей; duplicate — заказ уже
-- был оплачен или отменён к моменту оплаты, сумма возвращена (двойная оплата счёта).
create table bl.pos_sale_items (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  sale_id uuid not null,
  order_id uuid not null,
  order_item_id uuid not null,
  qty integer not null check (qty >= 1),
  amount_kopecks bigint not null check (amount_kopecks >= qty),
  discount_kopecks bigint not null default 0 check (discount_kopecks >= 0),
  outcome text not null default 'pending' check (outcome in ('pending', 'paid', 'duplicate')),
  refunded_qty integer not null default 0,
  refunded_kopecks bigint not null default 0,
  unique (club_id, id),
  unique (sale_id, order_item_id),
  foreign key (club_id, sale_id) references bl.pos_sales (club_id, id),
  foreign key (club_id, order_id) references bl.orders (club_id, id),
  foreign key (club_id, order_item_id) references bl.order_items (club_id, id),
  check (refunded_qty between 0 and qty),
  check (refunded_kopecks between 0 and amount_kopecks)
);
create index pos_sale_items_sale_idx on bl.pos_sale_items (sale_id);
create index pos_sale_items_order_item_idx on bl.pos_sale_items (order_item_id);

create table bl.pos_sale_requests (
  sale_id uuid not null,
  club_id uuid not null references bl.clubs (id),
  request_id uuid not null,
  payment_id uuid not null,
  amount_kopecks bigint not null check (amount_kopecks > 0),
  primary key (sale_id, request_id),
  unique (request_id),
  foreign key (club_id, sale_id) references bl.pos_sales (club_id, id),
  foreign key (club_id, request_id) references bl.reception_requests (club_id, id),
  foreign key (club_id, payment_id) references bl.payments (club_id, id)
);

-- Возвраты продаж: bl.refunds (money) — деньги; здесь — что и почему вернули.
create table bl.pos_refunds (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  sale_id uuid not null,
  refund_id uuid not null,
  kind text not null check (kind in ('staff', 'duplicate')),
  amount_kopecks bigint not null check (amount_kopecks > 0),
  reason text not null check (length(reason) between 1 and 2000),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  receipt_id uuid,
  shift_id uuid,
  created_by uuid references bl.users (id),
  request_key uuid,
  created_at timestamptz not null,
  unique (club_id, id),
  unique (club_id, request_key),
  unique (refund_id),
  foreign key (club_id, sale_id) references bl.pos_sales (club_id, id),
  foreign key (club_id, refund_id) references bl.refunds (club_id, id),
  check (kind = 'duplicate' or created_by is not null)
);
create index pos_refunds_sale_idx on bl.pos_refunds (sale_id);

-- Защита конечных состояний -----------------------------------------------------------------

create function bl.orders_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status = 'canceled' and new.status <> 'canceled' then
    raise exception 'bl.orders: canceled is final' using errcode = 'check_violation';
  end if;
  -- Выданный заказ только отменяется (неоплаченный счёт стола, с причиной); оплаченный — возвратом.
  if old.status = 'served' and new.status not in ('served', 'canceled') then
    raise exception 'bl.orders: served is final' using errcode = 'check_violation';
  end if;
  if old.paid_at is not null and (new.paid_at is distinct from old.paid_at or new.sale_id is distinct from old.sale_id) then
    raise exception 'bl.orders: paid once' using errcode = 'check_violation';
  end if;
  if old.committed_at is not null and new.committed_at is distinct from old.committed_at then
    raise exception 'bl.orders: committed_at is set once' using errcode = 'check_violation';
  end if;
  if old.paid_at is not null and new.status = 'canceled' then
    raise exception 'bl.orders: paid order is canceled only by refund' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function bl.orders_guard() owner to bl_owner;
revoke all on function bl.orders_guard() from public;
create trigger orders_guard before update on bl.orders for each row execute function bl.orders_guard();

create function bl.pos_sales_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status in ('completed', 'canceled') and new.status <> old.status then
    raise exception 'bl.pos_sales: final status % cannot change', old.status using errcode = 'check_violation';
  end if;
  if old.completed_at is not null and new.completed_at is distinct from old.completed_at then
    raise exception 'bl.pos_sales: completed_at is set once' using errcode = 'check_violation';
  end if;
  if new.refunded_kopecks < old.refunded_kopecks then
    raise exception 'bl.pos_sales: refunded_kopecks only grows' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function bl.pos_sales_guard() owner to bl_owner;
revoke all on function bl.pos_sales_guard() from public;
create trigger pos_sales_guard before update on bl.pos_sales for each row execute function bl.pos_sales_guard();

-- Владелец, RLS, права ---------------------------------------------------------------------

alter table bl.orders owner to bl_owner;
alter table bl.order_items owner to bl_owner;
alter table bl.pos_sales owner to bl_owner;
alter table bl.pos_sale_items owner to bl_owner;
alter table bl.pos_sale_requests owner to bl_owner;
alter table bl.pos_refunds owner to bl_owner;

alter table bl.orders enable row level security;
alter table bl.orders force row level security;
alter table bl.order_items enable row level security;
alter table bl.order_items force row level security;
alter table bl.pos_sales enable row level security;
alter table bl.pos_sales force row level security;
alter table bl.pos_sale_items enable row level security;
alter table bl.pos_sale_items force row level security;
alter table bl.pos_sale_requests enable row level security;
alter table bl.pos_sale_requests force row level security;
alter table bl.pos_refunds enable row level security;
alter table bl.pos_refunds force row level security;

create policy orders_app on bl.orders for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy order_items_app on bl.order_items for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy pos_sales_app on bl.pos_sales for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy pos_sale_items_app on bl.pos_sale_items for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy pos_sale_requests_app on bl.pos_sale_requests for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy pos_refunds_app on bl.pos_refunds for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());

revoke all on bl.orders, bl.order_items, bl.pos_sales, bl.pos_sale_items, bl.pos_sale_requests, bl.pos_refunds from public;

grant select, insert on bl.orders to app_api;
grant update (status, committed_at, paid_at, sale_id, status_at, preparing_at, ready_at, served_at, canceled_at,
  canceled_by, cancel_reason, updated_at) on bl.orders to app_api;

grant select, insert on bl.order_items to app_api;

grant select, insert on bl.pos_sales to app_api;
grant update (status, completed_at, canceled_at, refunded_kopecks, receipt_id, updated_at) on bl.pos_sales to app_api;

grant select, insert on bl.pos_sale_items to app_api;
grant update (outcome, refunded_qty, refunded_kopecks) on bl.pos_sale_items to app_api;

grant select, insert on bl.pos_sale_requests to app_api;
grant select, insert on bl.pos_refunds to app_api;

-- Узкие функции SECURITY DEFINER (supabase/README.md) ----------------------------------------
-- Гость открывает заказ по id без клуба в контексте; планировщик находит продажи,
-- у которых платёж ЮKassa уже в конечном статусе (подтверждение или отмена), во всех клубах.

grant select (id, club_id) on bl.orders to bl_definer;
grant select (id, club_id, status, payment_id, created_at) on bl.pos_sales to bl_definer;
create policy orders_definer on bl.orders for select to bl_definer using (true);
create policy pos_sales_definer on bl.pos_sales for select to bl_definer using (true);

create function bl.pos_object_club(p_kind text, p_id uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select case p_kind
    when 'order' then (select o.club_id from bl.orders o where o.id = p_id)
    when 'sale' then (select s.club_id from bl.pos_sales s where s.id = p_id)
  end
$$;

create function bl.pos_due(p_limit integer)
returns table (club_id uuid, sale_id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select s.club_id, s.id
    from bl.pos_sales s join bl.payments p on p.id = s.payment_id
   where s.status = 'pending' and p.status in ('succeeded', 'canceled')
   order by s.created_at
   limit p_limit
$$;

alter function bl.pos_object_club(text, uuid) owner to bl_definer;
alter function bl.pos_due(integer) owner to bl_definer;
revoke all on function bl.pos_object_club(text, uuid), bl.pos_due(integer) from public;
grant execute on function bl.pos_object_club(text, uuid), bl.pos_due(integer) to app_api;

comment on function bl.pos_object_club(text, uuid) is 'SECURITY DEFINER: club_id заказа (order) или продажи (sale) по UUID (или NULL).';
comment on function bl.pos_due(integer) is 'SECURITY DEFINER: продажи в pending, у которых платёж уже succeeded или canceled (club_id, sale_id).';
