-- 0650: деньги M3 — предоплата брони и зачёт, пакеты часов и баланс, депозит наличными
-- (контракт docs/contracts/m3.md §1 п. 5, 10, 11; decisions №52, №108, №112).
--
-- bl.payments:
--   * kind += 'booking' (предоплата брони, чек full_prepayment) и 'package' (покупка пакета часов
--     в приложении, чек full_prepayment); у пакета нет стола, гость обязателен;
--   * provider/method += 'balance': игра оплачена балансом минут гостя (без денег и без чека в момент
--     списания; сумма — зачтённая стоимость минут пакета, может быть 0);
--   * deposit — депозит наличными на ресепшене для «Без лимита» (чек ККТ предоплаты, при закрытии
--     сессии — зачёт по факту и возврат остатка);
--   * balance_minutes — сколько минут игры покрыто балансом (платёж остатка картой или СБП);
--     то же поле у bl.quotes;
--   * settlement_status — состояние предоплаты (бронь, депозит): open → settled (зачтена при игре) |
--     forfeited (бронь сгорела: удержано по правилам клуба, остаток возвращён); settled_kopecks — сколько зачтено.
-- bl.receipts: settles_payment_id — чек зачёта предоплаты (позиции full_payment, оплата «зачёт
--   предоплаты»): для ЮKassa — POST /v3/receipts по платежу предоплаты (provider_receipt_id),
--   для ККТ — задание server/kkt с оплатой «предоплата».
-- bl.club_payment_settings.booking_forfeit_percent — сколько процентов предоплаты удержать при
--   сгорании брони (по умолчанию 100; остаток — возврат). Проверить с бухгалтером клуба (№108).
-- Новые таблицы: tariff_packages (пакеты часов клуба), balance_lots (минуты гостя по покупкам,
--   со сроком), balance_debits (списания минут и их стоимость для чека зачёта).

-- payments ------------------------------------------------------------------------------------

alter table bl.payments drop constraint payments_kind_check;
alter table bl.payments add constraint payments_kind_check check (kind in ('start', 'extend', 'bar', 'booking', 'package'));
alter table bl.payments drop constraint payments_provider_check;
alter table bl.payments add constraint payments_provider_check check (provider in ('yookassa', 'reception', 'balance'));
alter table bl.payments drop constraint payments_method_check;
alter table bl.payments add constraint payments_method_check check (method in ('sbp', 'card', 'cash', 'card_terminal', 'balance'));
alter table bl.payments drop constraint payments_check1;
alter table bl.payments add constraint payments_provider_method_check check (
  (provider = 'yookassa' and method in ('sbp', 'card') and provider_payment_id is not null)
  or (provider = 'reception' and method in ('cash', 'card_terminal') and capture)
  or (provider = 'balance' and method = 'balance' and capture and provider_payment_id is null)
);
alter table bl.payments drop constraint payments_amount_kopecks_check;
alter table bl.payments add constraint payments_amount_kopecks_check check (amount_kopecks > 0 or (provider = 'balance' and amount_kopecks = 0));
alter table bl.payments drop constraint payments_table_refs_check;
alter table bl.payments add constraint payments_table_refs_check check (
  kind = 'bar'
  or (kind = 'package' and user_id is not null)
  or (resource_id is not null and user_id is not null)
);

alter table bl.payments
  add column booking_id uuid,
  add column package_id uuid,
  add column balance_minutes integer not null default 0 check (balance_minutes between 0 and 10080),
  add column deposit boolean not null default false,
  add column settlement_status text check (settlement_status in ('open', 'settled', 'forfeited')),
  add column settled_kopecks bigint not null default 0 check (settled_kopecks >= 0),
  add column settled_at timestamptz;

alter table bl.payments add constraint payments_prepaid_shape_check check (
  kind not in ('booking', 'package') or (quote_id is null and not unlimited and capture and provider = 'yookassa')
);
alter table bl.payments add constraint payments_booking_check check ((kind = 'booking') = (booking_id is not null));
alter table bl.payments add constraint payments_package_check check ((kind = 'package') = (package_id is not null));
alter table bl.payments add constraint payments_deposit_check check (
  not deposit or (provider = 'reception' and method = 'cash' and kind in ('start', 'extend') and unlimited)
);
alter table bl.payments add constraint payments_settlement_check check (
  (settlement_status is not null) = (kind = 'booking' or deposit) and settled_kopecks <= amount_kopecks
);
create unique index payments_booking_uidx on bl.payments (booking_id) where booking_id is not null and status <> 'canceled';

grant update (settlement_status, settled_kopecks, settled_at) on bl.payments to app_api;

-- quotes: часть минут котировки покрыта балансом гостя (amount_kopecks — доплата за остальное).

alter table bl.quotes add column balance_minutes integer not null default 0 check (balance_minutes between 0 and 10080);
alter table bl.quotes add constraint quotes_balance_check check (balance_minutes = 0 or (not unlimited and balance_minutes <= minutes));

-- receipts ------------------------------------------------------------------------------------

alter table bl.receipts
  add column settles_payment_id uuid,
  add column provider_receipt_id text check (length(provider_receipt_id) between 1 and 100),
  add column settlement_kopecks bigint check (settlement_kopecks > 0),
  add constraint receipts_settles_fk foreign key (club_id, settles_payment_id) references bl.payments (club_id, id),
  add constraint receipts_settlement_check check ((settles_payment_id is null) = (settlement_kopecks is null));
create unique index receipts_provider_receipt_uidx on bl.receipts (provider_receipt_id) where provider_receipt_id is not null;
create index receipts_settles_idx on bl.receipts (club_id, settles_payment_id) where settles_payment_id is not null;

grant update (provider_receipt_id, settles_payment_id, settlement_kopecks) on bl.receipts to app_api;

-- Настройки клуба -----------------------------------------------------------------------------

alter table bl.club_payment_settings
  add column booking_forfeit_percent smallint not null default 100 check (booking_forfeit_percent between 0 and 100);
grant update (booking_forfeit_percent) on bl.club_payment_settings to app_api;

-- Пакеты часов ------------------------------------------------------------------------------
-- «N часов за X ₽ на M дней» (№112). Цена и минуты пакета не меняются: новый пакет — новая строка
-- (изменение тарифа — ручное действие, журнал и уведомление владельцу).

create table bl.tariff_packages (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  title text not null check (length(title) between 1 and 100),
  minutes integer not null check (minutes between 30 and 100000),
  price_kopecks bigint not null check (price_kopecks > 0),
  valid_days integer not null check (valid_days between 1 and 730),
  active boolean not null default true,
  created_by uuid references bl.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, id)
);
create index tariff_packages_club_idx on bl.tariff_packages (club_id) where active;

-- Минуты гостя по покупкам: списание — сначала те, у которых раньше кончается срок.
create table bl.balance_lots (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  user_id uuid not null references bl.users (id),
  package_id uuid not null,
  payment_id uuid not null,
  minutes_total integer not null check (minutes_total > 0),
  minutes_left integer not null,
  price_kopecks bigint not null check (price_kopecks > 0),
  expires_at timestamptz not null,
  -- Покупка один раз: <payment_id>:<package_id>:<номер пакета в продаже> (в одной продаже кассы
  -- может быть несколько пакетов).
  source_key text not null unique check (length(source_key) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (club_id, id),
  foreign key (club_id, package_id) references bl.tariff_packages (club_id, id),
  foreign key (club_id, payment_id) references bl.payments (club_id, id),
  check (minutes_left between 0 and minutes_total)
);
create index balance_lots_user_idx on bl.balance_lots (club_id, user_id, expires_at) where minutes_left > 0;

-- Списания минут: стоимость — доля цены пакета (нарастающим итогом, без потери копеек);
-- payment_id — платёж игры (balance или остаток картой); restored_at — возврат минут при отмене.
create table bl.balance_debits (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  user_id uuid not null references bl.users (id),
  lot_id uuid not null,
  payment_id uuid not null,
  minutes integer not null check (minutes > 0),
  value_kopecks bigint not null check (value_kopecks >= 0),
  created_at timestamptz not null default now(),
  restored_at timestamptz,
  unique (club_id, id),
  foreign key (club_id, lot_id) references bl.balance_lots (club_id, id),
  foreign key (club_id, payment_id) references bl.payments (club_id, id)
);
create index balance_debits_payment_idx on bl.balance_debits (club_id, payment_id);

alter table bl.tariff_packages owner to bl_owner;
alter table bl.balance_lots owner to bl_owner;
alter table bl.balance_debits owner to bl_owner;

alter table bl.tariff_packages enable row level security;
alter table bl.tariff_packages force row level security;
alter table bl.balance_lots enable row level security;
alter table bl.balance_lots force row level security;
alter table bl.balance_debits enable row level security;
alter table bl.balance_debits force row level security;

create policy tariff_packages_app on bl.tariff_packages for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy balance_lots_app on bl.balance_lots for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy balance_debits_app on bl.balance_debits for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());

revoke all on bl.tariff_packages, bl.balance_lots, bl.balance_debits from public;
grant select, insert on bl.tariff_packages to app_api;
grant update (title, active, updated_at) on bl.tariff_packages to app_api;
grant select, insert on bl.balance_lots to app_api;
grant update (minutes_left) on bl.balance_lots to app_api;
grant select, insert on bl.balance_debits to app_api;
grant update (restored_at) on bl.balance_debits to app_api;

-- Клуб пакета по id (покупка гостем без клуба в контексте) ----------------------------------

grant select (id, club_id, active) on bl.tariff_packages to bl_definer;
create policy tariff_packages_definer on bl.tariff_packages for select to bl_definer using (true);

create or replace function bl.money_object_club(p_kind text, p_id uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select case p_kind
    when 'quote' then (select q.club_id from bl.quotes q where q.id = p_id)
    when 'payment' then (select p.club_id from bl.payments p where p.id = p_id)
    when 'reception_request' then (select rr.club_id from bl.reception_requests rr where rr.id = p_id)
    when 'package' then (select tp.club_id from bl.tariff_packages tp where tp.id = p_id and tp.active)
  end
$$;
comment on function bl.money_object_club(text, uuid) is 'SECURITY DEFINER: club_id котировки, платежа, заявки ресепшена или активного пакета часов по UUID (или NULL).';
