-- 0430 (backend-pos): склад бара (контракт m2.md §3, decisions №80, PRODUCT §5).
--
-- Остаток товара — сумма движений stock_movements.qty (единицы товара, до тысячных:
-- модификатор «большой объём» списывает 1,5 порции). Движения только дополняются:
-- у app_api нет UPDATE, DELETE и TRUNCATE.
--   sale     — продажа (qty < 0), один раз на строку заказа;
--   arrival  — приход (qty > 0) с себестоимостью закупки cost_kopecks;
--   writeoff — списание (qty < 0) с причиной;
--   audit    — поправка ревизии (факт − расчёт, любой знак);
--   return   — возврат на склад (qty > 0): отмена заказа или возврат продажи.
-- cost_kopecks — себестоимость движения со знаком qty: у прихода — сумма закупки, у остальных —
-- |qty| × средняя себестоимость по приходам (Σ cost приходов / Σ qty приходов), до копейки.

create table bl.stock_audits (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  created_by uuid not null references bl.users (id),
  note text check (length(note) between 1 and 2000),
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  total_diff_kopecks bigint not null,
  created_at timestamptz not null,
  unique (club_id, id)
);
create index stock_audits_club_idx on bl.stock_audits (club_id, created_at desc);

create table bl.stock_movements (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  product_id uuid not null,
  kind text not null check (kind in ('sale', 'arrival', 'writeoff', 'audit', 'return')),
  qty numeric(14, 3) not null check (qty <> 0 and abs(qty) <= 100000000),
  cost_kopecks bigint not null,
  order_item_id uuid,
  sale_id uuid,
  refund_id uuid,
  audit_id uuid,
  reason text check (length(reason) between 1 and 2000),
  created_by uuid references bl.users (id),
  created_at timestamptz not null,
  unique (club_id, id),
  foreign key (club_id, product_id) references bl.products (club_id, id),
  foreign key (club_id, order_item_id) references bl.order_items (club_id, id),
  foreign key (club_id, sale_id) references bl.pos_sales (club_id, id),
  foreign key (club_id, refund_id) references bl.pos_refunds (club_id, id),
  foreign key (club_id, audit_id) references bl.stock_audits (club_id, id),
  check (kind <> 'arrival' or (qty > 0 and cost_kopecks >= 0)),
  check (kind not in ('sale', 'writeoff') or (qty < 0 and cost_kopecks <= 0)),
  check (kind <> 'return' or (qty > 0 and cost_kopecks >= 0 and order_item_id is not null)),
  check (kind <> 'sale' or order_item_id is not null),
  check (kind <> 'writeoff' or reason is not null),
  check (kind <> 'audit' or audit_id is not null)
);
create index stock_movements_product_idx on bl.stock_movements (club_id, product_id, created_at);
create index stock_movements_club_created_idx on bl.stock_movements (club_id, created_at desc);
-- Продажа строки заказа списывается один раз; отмена заказа возвращает её один раз;
-- возврат продажи — один раз на возврат и строку.
create unique index stock_movements_sale_uidx on bl.stock_movements (order_item_id) where kind = 'sale';
create unique index stock_movements_cancel_uidx on bl.stock_movements (order_item_id) where kind = 'return' and refund_id is null;
create unique index stock_movements_refund_uidx on bl.stock_movements (refund_id, order_item_id) where kind = 'return' and refund_id is not null;

comment on table bl.stock_movements is 'Движения склада бара (№80): остаток — сумма qty; только INSERT.';

alter table bl.stock_audits owner to bl_owner;
alter table bl.stock_movements owner to bl_owner;

alter table bl.stock_audits enable row level security;
alter table bl.stock_audits force row level security;
alter table bl.stock_movements enable row level security;
alter table bl.stock_movements force row level security;

create policy stock_audits_app on bl.stock_audits for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy stock_movements_app on bl.stock_movements for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());

revoke all on bl.stock_audits, bl.stock_movements from public;
grant select, insert on bl.stock_audits to app_api;
grant select, insert on bl.stock_movements to app_api;
