-- 0480 (backend-pos, M3): продажа пакета часов на кассе (контракт docs/contracts/m3.md §1 п. 10;
-- decisions №112).
--
-- Пакет в корзине кассы — не товар бара: своя строка продажи bl.pos_sale_packages (пакет, гость,
-- номер пакета в продаже, сумма, позиция чека «предоплата 100 %» от money packageSaleLine). Платёж
-- продажи — тот же платёж бара (kind bar): бар после скидки + пакеты. Скидка кассы на пакет не
-- действует (цена пакета — тариф клуба). После оплаты money creditPackageForSale начисляет минуты
-- (bl.balance_lots, source_key <payment>:<package>:<idx>), lot_id — ссылка на начисление.
--
-- bl.pos_sales.package_kopecks — сумма пакетов продажи; платёж продажи = bar_total + package_kopecks.
-- Продажа гостя онлайн (channel guest) пакетов не содержит.
--
-- package_id и lot_id — мягкие ссылки (как shift_id кассы, decisions №92): таблицы пакетов и партий
-- создаёт money в 0650, а диапазон кассы — 0480–0499, раньше. Пакет проверяет money
-- (packageSaleLine: активный пакет клуба под RLS), партию — creditPackageForSale.

alter table bl.pos_sales add column package_kopecks bigint not null default 0 check (package_kopecks >= 0);
alter table bl.pos_sales drop constraint pos_sales_check1;
alter table bl.pos_sales add constraint pos_sales_payment_check check ((bar_total_kopecks + package_kopecks > 0) = (payment_id is not null));
alter table bl.pos_sales drop constraint pos_sales_check2;
alter table bl.pos_sales add constraint pos_sales_total_check check (bar_total_kopecks + package_kopecks + table_kopecks > 0);
alter table bl.pos_sales drop constraint pos_sales_check3;
alter table bl.pos_sales add constraint pos_sales_refunded_check check (refunded_kopecks <= bar_total_kopecks + package_kopecks);
alter table bl.pos_sales add constraint pos_sales_packages_channel_check check (package_kopecks = 0 or channel = 'pos');

create table bl.pos_sale_packages (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  sale_id uuid not null,
  idx smallint not null check (idx between 0 and 9),
  package_id uuid not null,
  user_id uuid not null references bl.users (id),
  amount_kopecks bigint not null check (amount_kopecks > 0),
  line jsonb not null check (jsonb_typeof(line) = 'object'),
  lot_id uuid,
  created_at timestamptz not null,
  unique (club_id, id),
  unique (sale_id, idx),
  foreign key (club_id, sale_id) references bl.pos_sales (club_id, id)
);
create index pos_sale_packages_sale_idx on bl.pos_sale_packages (sale_id);

comment on table bl.pos_sale_packages is 'Пакеты часов в продаже кассы: гость, сумма, позиция чека (предоплата 100 %), начисленная партия минут.';

-- Ссылка на начисление ставится один раз.
create function bl.pos_sale_packages_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.lot_id is not null and new.lot_id is distinct from old.lot_id then
    raise exception 'bl.pos_sale_packages: lot_id is set once' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function bl.pos_sale_packages_guard() owner to bl_owner;
revoke all on function bl.pos_sale_packages_guard() from public;
create trigger pos_sale_packages_guard before update on bl.pos_sale_packages for each row execute function bl.pos_sale_packages_guard();

alter table bl.pos_sale_packages owner to bl_owner;
alter table bl.pos_sale_packages enable row level security;
alter table bl.pos_sale_packages force row level security;
create policy pos_sale_packages_app on bl.pos_sale_packages for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());

revoke all on bl.pos_sale_packages from public;
grant select, insert on bl.pos_sale_packages to app_api;
grant update (lot_id) on bl.pos_sale_packages to app_api;
