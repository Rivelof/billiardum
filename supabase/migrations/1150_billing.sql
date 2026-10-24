-- 1150 (backend-billing, M5.3 №180–186): подписка клубов на программу «Бильярдум».
--
-- Деньги платформы — отдельный поток от денег гостей: свои таблицы (в bl.payments, отчёты и
-- сводки клуба не входят), свой магазин ЮKassa (ключи только в .env, в базе их нет), свой вебхук.
--
-- * billing_settings — одна строка: released_at — когда применена миграция (выкатка M5.3).
--   Клубы, перешедшие в live раньше, получают пробный период с этой даты (№181).
-- * billing_plans — тарифы платформы (№180): меняет только platform_admin; старт — «Клуб»,
--   790 ₽ за стол в работе в месяц, пробный период 60 дней.
-- * club_subscriptions — подписка клуба (одна на клуб): план, персональная цена с причиной,
--   пробный период, день счёта, оплачено до, автоплатёж и сохранённый способ оплаты
--   (id способа ЮKassa — зашифрован в приложении, №23; наружу — только маска карты).
--   Клуб читает только свою строку и не пишет её вовсе: цена, paid_until и пробный период
--   меняются только узкими функциями ниже; прочие поля пишет сервер в контексте платформы.
-- * billing_invoices — счёт за период (раз в месяц вперёд, №182): столы × цена на дату счёта.
--   Один счёт на период (club_id, period_start). Оплачен — только узкой функцией
--   bl.billing_settle_invoice (один раз; продлевает paid_until).
-- * billing_payments — платежи в магазин платформы: привязка карты (1 ₽ заморозкой с отменой)
--   и оплата счёта (владельцем на странице ЮKassa или автоплатежом). Обработка один раз по
--   provider_payment_id (уникальный индекс), ключ идемпотентности уникален.
--
-- Контексты (как у M4): клуб — app.club_id; платформа — bl.ctx_platform_role() (роутер ставит
-- app.platform_role), фоновые задачи и вебхук — bl.ctx_is_platform() (system без клуба).
-- Журнал платформы — bl.audit_log с club_id IS NULL (политика M0, журнал не меняется).

-- Настройки -----------------------------------------------------------------------------------

create table bl.billing_settings (
  id boolean primary key default true check (id),
  released_at timestamptz not null default now()
);
insert into bl.billing_settings (id) values (true);

alter table bl.billing_settings owner to bl_owner;
alter table bl.billing_settings enable row level security;
alter table bl.billing_settings force row level security;
create policy billing_settings_read on bl.billing_settings for select to app_api using (true);
revoke all on bl.billing_settings from public;
grant select on bl.billing_settings to app_api;
grant select on bl.billing_settings to bl_definer;
create policy billing_settings_definer on bl.billing_settings for select to bl_definer using (true);

comment on table bl.billing_settings is 'Подписка клубов (M5.3): released_at — выкатка M5.3, начало пробного периода клубов, перешедших в live раньше (№181).';

-- Тарифы платформы ------------------------------------------------------------------------------

create table bl.billing_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  title text not null check (length(btrim(title)) between 1 and 100),
  price_per_table_kopecks bigint not null check (price_per_table_kopecks between 0 and 100000000),
  trial_days integer not null default 60 check (trial_days between 0 and 365),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references bl.users (id)
);

insert into bl.billing_plans (id, code, title, price_per_table_kopecks, trial_days)
values ('bf000000-0000-4000-8000-000000000001', 'club', 'Клуб', 79000, 60);

alter table bl.billing_plans owner to bl_owner;
alter table bl.billing_plans enable row level security;
alter table bl.billing_plans force row level security;
-- Тарифы платформы не секрет: клуб видит свой план и цену.
create policy billing_plans_read on bl.billing_plans for select to app_api using (true);
create policy billing_plans_admin on bl.billing_plans for update to app_api
  using (bl.ctx_platform_role() = 'platform_admin')
  with check (bl.ctx_platform_role() = 'platform_admin');
revoke all on bl.billing_plans from public;
grant select on bl.billing_plans to app_api;
grant update (title, price_per_table_kopecks, active, updated_at, updated_by) on bl.billing_plans to app_api;
grant select on bl.billing_plans to bl_definer;
create policy billing_plans_definer on bl.billing_plans for select to bl_definer using (true);

comment on table bl.billing_plans is 'Тарифы платформы (№180): цена за стол в работе в месяц, пробный период; меняет только platform_admin.';

-- Подписки клубов -------------------------------------------------------------------------------

create table bl.club_subscriptions (
  club_id uuid primary key references bl.clubs (id),
  plan_id uuid not null references bl.billing_plans (id),
  personal_price_kopecks bigint check (personal_price_kopecks between 0 and 100000000),
  personal_price_reason text check (length(btrim(personal_price_reason)) between 1 and 2000),
  personal_price_by uuid references bl.users (id),
  personal_price_at timestamptz,
  trial_started_at timestamptz not null,
  trial_until timestamptz not null,
  anchor_day smallint not null check (anchor_day between 1 and 31),
  paid_until timestamptz,
  autopay boolean not null default false,
  payment_method_enc text check (length(payment_method_enc) between 1 and 1000),
  card jsonb check (card is null or jsonb_typeof(card) = 'object'),
  card_saved_at timestamptz,
  card_saved_by uuid references bl.users (id),
  receipt_email text check (length(receipt_email) between 3 and 254 and receipt_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  reminder_for timestamptz,
  suspended_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (trial_until >= trial_started_at),
  check ((personal_price_kopecks is null) = (personal_price_reason is null)),
  check (not autopay or payment_method_enc is not null),
  check ((payment_method_enc is null) = (card is null))
);
create index club_subscriptions_plan_idx on bl.club_subscriptions (plan_id);

alter table bl.club_subscriptions owner to bl_owner;
alter table bl.club_subscriptions enable row level security;
alter table bl.club_subscriptions force row level security;

-- Клуб — только свою строку и только чтение; платформа — все строки.
create policy club_subscriptions_read on bl.club_subscriptions for select to app_api
  using (club_id = bl.ctx_club_id() or bl.ctx_platform_role() is not null or bl.ctx_is_platform());
-- Служебные поля (карта, автоплатёж, напоминание) пишет только сервер в контексте платформы
-- (вебхук, планировщик). Цены, пробного периода и paid_until в правах app_api нет вовсе.
create policy club_subscriptions_system on bl.club_subscriptions for update to app_api
  using (bl.ctx_is_platform())
  with check (bl.ctx_is_platform());
revoke all on bl.club_subscriptions from public;
grant select on bl.club_subscriptions to app_api;
grant update (autopay, payment_method_enc, card, card_saved_at, card_saved_by, receipt_email, reminder_for, suspended_since, updated_at)
  on bl.club_subscriptions to app_api;

grant select, insert, update on bl.club_subscriptions to bl_definer;
create policy club_subscriptions_definer on bl.club_subscriptions for all to bl_definer using (true) with check (true);

comment on table bl.club_subscriptions is 'Подписка клуба (M5.3 №181–185): план, персональная цена, пробный период, оплачено до, автоплатёж.';
comment on column bl.club_subscriptions.anchor_day is 'День месяца счёта по поясу клуба (№182): день окончания пробного периода; 29–31 в коротком месяце — последний день.';
comment on column bl.club_subscriptions.payment_method_enc is 'Сохранённый способ оплаты ЮKassa (payment_method.id), AES-256-GCM в приложении (контекст billing_method/<club_id>).';
comment on column bl.club_subscriptions.reminder_for is 'Конец периода, о котором уже напомнили за 7 дней (№184).';
comment on column bl.club_subscriptions.suspended_since is 'Клуб приостановлен с этого момента (№188): после возобновления срок сдвигается, счёт — с даты возобновления.';

-- Счета -----------------------------------------------------------------------------------------

create table bl.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  period_start date not null,
  period_end date not null,
  period_start_at timestamptz not null,
  period_end_at timestamptz not null,
  tables integer not null check (tables between 0 and 10000),
  price_per_table_kopecks bigint not null check (price_per_table_kopecks between 0 and 100000000),
  amount_kopecks bigint not null check (amount_kopecks >= 0),
  status text not null default 'open' check (status in ('open', 'paid')),
  paid_at timestamptz,
  paid_via text check (paid_via in ('card', 'manual', 'free')),
  payment_id uuid,
  manual_reason text check (length(btrim(manual_reason)) between 1 and 2000),
  manual_document text check (length(btrim(manual_document)) between 1 and 200),
  manual_by uuid references bl.users (id),
  attempts integer not null default 0 check (attempts between 0 and 10),
  first_failed_at timestamptz,
  next_attempt_at timestamptz,
  last_error text check (last_error ~ '^[a-z][a-z0-9_]{0,63}$'),
  platform_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, id),
  unique (club_id, period_start),
  check (period_end > period_start),
  check (period_end_at > period_start_at),
  check (amount_kopecks = tables::bigint * price_per_table_kopecks),
  check ((status = 'paid') = (paid_at is not null and paid_via is not null)),
  check (paid_via is distinct from 'manual' or (manual_reason is not null and manual_document is not null and manual_by is not null)),
  check (paid_via is distinct from 'card' or payment_id is not null)
);
create index billing_invoices_open_idx on bl.billing_invoices (club_id, period_start) where status = 'open';
create index billing_invoices_paid_idx on bl.billing_invoices (paid_at) where status = 'paid';

alter table bl.billing_invoices owner to bl_owner;
alter table bl.billing_invoices enable row level security;
alter table bl.billing_invoices force row level security;
create policy billing_invoices_read on bl.billing_invoices for select to app_api
  using (club_id = bl.ctx_club_id() or bl.ctx_platform_role() is not null or bl.ctx_is_platform());
-- Счёт выставляет и повторы ведёт только планировщик (контекст платформы); оплачен — узкой функцией.
create policy billing_invoices_insert on bl.billing_invoices for insert to app_api
  with check (bl.ctx_is_platform() and status = 'open' and paid_at is null and paid_via is null);
create policy billing_invoices_update on bl.billing_invoices for update to app_api
  using (bl.ctx_is_platform())
  with check (bl.ctx_is_platform());
revoke all on bl.billing_invoices from public;
grant select on bl.billing_invoices to app_api;
grant insert (id, club_id, period_start, period_end, period_start_at, period_end_at, tables, price_per_table_kopecks, amount_kopecks,
              next_attempt_at, created_at, updated_at) on bl.billing_invoices to app_api;
grant update (attempts, first_failed_at, next_attempt_at, last_error, platform_notified_at, updated_at) on bl.billing_invoices to app_api;

grant select, update on bl.billing_invoices to bl_definer;
create policy billing_invoices_definer on bl.billing_invoices for all to bl_definer using (true) with check (true);

comment on table bl.billing_invoices is 'Счёт подписки за месяц вперёд (№182): столы в работе × цена на дату счёта; оплачен один раз.';

-- Платежи платформы -------------------------------------------------------------------------------

create table bl.billing_payments (
  id uuid primary key,
  club_id uuid not null references bl.clubs (id),
  invoice_id uuid,
  purpose text not null check (purpose in ('bind', 'invoice')),
  initiated_by text not null check (initiated_by in ('owner', 'autopay')),
  attempt smallint check (attempt between 1 and 10),
  created_by uuid references bl.users (id),
  shop_id text not null check (shop_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  provider_payment_id text unique check (provider_payment_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  idempotence_key text not null unique check (length(idempotence_key) between 1 and 64),
  amount_kopecks bigint not null check (amount_kopecks > 0),
  status text not null default 'pending' check (status in ('pending', 'waiting_for_capture', 'succeeded', 'canceled')),
  save_method boolean not null default false,
  confirmation_url text check (length(confirmation_url) <= 2000),
  receipt_email text check (length(receipt_email) between 3 and 254),
  receipt_status text check (receipt_status in ('pending', 'succeeded', 'canceled')),
  error text check (error ~ '^[a-z][a-z0-9_]{0,63}$'),
  confirmed_at timestamptz,
  confirmed_via text check (confirmed_via in ('create', 'webhook', 'sync')),
  webhook_at timestamptz,
  checked_at timestamptz,
  method_saved boolean not null default false,
  hold_canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (club_id, invoice_id) references bl.billing_invoices (club_id, id),
  check ((purpose = 'invoice') = (invoice_id is not null)),
  check ((initiated_by = 'autopay') = (attempt is not null)),
  check (purpose = 'invoice' or initiated_by = 'owner')
);
create index billing_payments_club_idx on bl.billing_payments (club_id, created_at desc);
create index billing_payments_invoice_idx on bl.billing_payments (invoice_id) where invoice_id is not null;
create index billing_payments_open_idx on bl.billing_payments (created_at) where status in ('pending', 'waiting_for_capture');

alter table bl.billing_payments owner to bl_owner;
alter table bl.billing_payments enable row level security;
alter table bl.billing_payments force row level security;
create policy billing_payments_read on bl.billing_payments for select to app_api
  using (club_id = bl.ctx_club_id() or bl.ctx_platform_role() is not null or bl.ctx_is_platform());
-- Владелец начинает привязку карты или оплату счёта в контексте своего клуба — только pending;
-- автоплатёж — планировщик (контекст платформы). Итог платежа пишет только контекст платформы.
create policy billing_payments_insert on bl.billing_payments for insert to app_api
  with check (
    (club_id = bl.ctx_club_id() and initiated_by = 'owner' and status = 'pending' and confirmed_at is null and not method_saved)
    or bl.ctx_is_platform()
  );
create policy billing_payments_update on bl.billing_payments for update to app_api
  using (bl.ctx_is_platform())
  with check (bl.ctx_is_platform());
revoke all on bl.billing_payments from public;
grant select, insert on bl.billing_payments to app_api;
grant update (provider_payment_id, status, confirmation_url, receipt_status, error, confirmed_at, confirmed_via, webhook_at, checked_at,
              method_saved, hold_canceled_at, updated_at) on bl.billing_payments to app_api;

grant select (id, club_id, invoice_id, purpose, status, amount_kopecks) on bl.billing_payments to bl_definer;
create policy billing_payments_definer on bl.billing_payments for select to bl_definer using (true);

comment on table bl.billing_payments is 'Платежи в магазин ЮKassa платформы (№183): привязка карты и оплата счёта подписки; отдельно от bl.payments гостей.';

-- Узкие функции ---------------------------------------------------------------------------------

-- Клуб в боевом режиме для подписки: live или приостановлен после live (как isLiveClub, №165).
create function bl.billing_is_live(p_mode text, p_before text) returns boolean
language sql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$ select p_mode = 'live' or (p_mode = 'suspended' and p_before = 'live') $$;
alter function bl.billing_is_live(text, text) owner to bl_owner;
revoke all on function bl.billing_is_live(text, text) from public;
grant execute on function bl.billing_is_live(text, text) to app_api, bl_definer;

-- Контекст запроса внутри узких функций (они работают от bl_definer, у которого нет права на
-- bl.ctx_*): те же правила, что у bl.ctx_club_id(), bl.ctx_user_id() и bl.ctx_is_platform().
create function bl.billing_ctx() returns table (club_id uuid, user_id uuid, actor text, is_platform boolean)
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  select x.c, x.u, x.a, coalesce(x.a = 'system', false) and x.c is null and x.u is null
    from (select nullif(pg_catalog.current_setting('app.club_id', true), '')::uuid as c,
                 nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid as u,
                 nullif(pg_catalog.current_setting('app.actor_type', true), '') as a) x
$$;
alter function bl.billing_ctx() owner to bl_definer;
revoke all on function bl.billing_ctx() from public;

-- Подписка клуба, если он в боевом режиме и подписки ещё нет (№181). Пробный период — с перехода
-- в live, но не раньше выкатки M5.3; длина — trial_days плана «Клуб»; конец — местная полночь
-- (пояс клуба) через trial_days суток после местной даты начала; день счёта — день этой даты.
-- Доступ: клуб из контекста (только свой), платформа, фоновые задачи. Возвращает true, если создана.
create function bl.billing_ensure_subscription(p_club uuid)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_club record;
  v_plan record;
  v_released timestamptz;
  v_start timestamptz;
  v_end_date date;
  v_n integer;
  v_ctx record;
begin
  if p_club is null then
    return false;
  end if;
  select * into v_ctx from bl.billing_ctx();
  if not (p_club = v_ctx.club_id or v_ctx.is_platform or bl.ctx_platform_role() is not null) then
    raise exception 'bl.billing_ensure_subscription: club context, platform or system only' using errcode = '42501';
  end if;
  select c.id, c.timezone, c.mode, c.mode_before_suspend, c.went_live_at into v_club from bl.clubs c where c.id = p_club;
  if v_club.id is null or not bl.billing_is_live(v_club.mode, v_club.mode_before_suspend) then
    return false;
  end if;
  if exists (select 1 from bl.club_subscriptions s where s.club_id = p_club) then
    return false;
  end if;
  select p.id, p.trial_days into v_plan from bl.billing_plans p where p.code = 'club';
  select s.released_at into v_released from bl.billing_settings s where s.id;
  v_start := greatest(coalesce(v_club.went_live_at, v_released), v_released);
  v_end_date := (pg_catalog.timezone(v_club.timezone, v_start))::date + v_plan.trial_days;
  insert into bl.club_subscriptions (club_id, plan_id, trial_started_at, trial_until, anchor_day)
  values (p_club, v_plan.id, v_start, (v_end_date::timestamp) at time zone v_club.timezone, extract(day from v_end_date)::smallint)
  on conflict (club_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n = 1;
end
$$;
alter function bl.billing_ensure_subscription(uuid) owner to bl_definer;
revoke all on function bl.billing_ensure_subscription(uuid) from public;
grant execute on function bl.billing_ensure_subscription(uuid) to app_api;
comment on function bl.billing_ensure_subscription(uuid) is
  'SECURITY DEFINER: подписка клуба в боевом режиме с пробным периодом (№181), если её нет; true — создана.';

-- Счёт оплачен (один раз): продлевает paid_until до конца периода счёта.
--   p_via 'card'   — платёж в магазин платформы прошёл (p_payment — succeeded, тот же счёт и сумма);
--                    только фоновые задачи и вебхук (bl.ctx_is_platform());
--   p_via 'free'   — сумма 0 (нет столов или персональная цена 0); только фоновые задачи;
--   p_via 'manual' — Андрей отметил оплату юрлица по счёту (№183): platform_admin, причина и номер платёжки.
-- Возвращает true — оплачен сейчас; false — уже был оплачен. Ошибки: 42501 — нет права, 22023 — данные,
-- BLB01 — платёж не подходит к счёту, P0002 — нет счёта.
create function bl.billing_settle_invoice(p_invoice uuid, p_via text, p_payment uuid, p_reason text, p_document text, p_now timestamptz)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_inv record;
  v_pay record;
  v_admin uuid := null;
  v_ctx record;
begin
  select * into v_ctx from bl.billing_ctx();
  if p_via in ('card', 'free') then
    if not v_ctx.is_platform then
      raise exception 'bl.billing_settle_invoice: system only' using errcode = '42501';
    end if;
  elsif p_via = 'manual' then
    if bl.ctx_platform_role() is distinct from 'platform_admin' then
      raise exception 'bl.billing_settle_invoice: platform_admin only' using errcode = '42501';
    end if;
    v_admin := v_ctx.user_id;
    if p_reason is null or length(btrim(p_reason)) < 1 or length(p_reason) > 2000
       or p_document is null or length(btrim(p_document)) < 1 or length(p_document) > 200 then
      raise exception 'bl.billing_settle_invoice: reason and document' using errcode = '22023';
    end if;
  else
    raise exception 'bl.billing_settle_invoice: via' using errcode = '22023';
  end if;
  if p_now is null then
    raise exception 'bl.billing_settle_invoice: now' using errcode = '22023';
  end if;

  select * into v_inv from bl.billing_invoices i where i.id = p_invoice for update;
  if v_inv.id is null then
    raise exception 'bl.billing_settle_invoice: no invoice' using errcode = 'P0002';
  end if;
  if v_inv.status = 'paid' then
    return false;
  end if;
  if p_via = 'card' then
    select p.id, p.club_id, p.invoice_id, p.purpose, p.status, p.amount_kopecks into v_pay from bl.billing_payments p where p.id = p_payment;
    if v_pay.id is null or v_pay.status <> 'succeeded' or v_pay.purpose <> 'invoice' or v_pay.invoice_id <> v_inv.id
       or v_pay.club_id <> v_inv.club_id or v_pay.amount_kopecks <> v_inv.amount_kopecks then
      raise exception 'bl.billing_settle_invoice: payment does not match invoice' using errcode = 'BLB01';
    end if;
  elsif p_via = 'free' and v_inv.amount_kopecks <> 0 then
    raise exception 'bl.billing_settle_invoice: free only for zero amount' using errcode = 'BLB01';
  end if;

  update bl.billing_invoices
     set status = 'paid', paid_at = p_now, paid_via = p_via,
         payment_id = case when p_via = 'card' then p_payment else null end,
         manual_reason = case when p_via = 'manual' then btrim(p_reason) end,
         manual_document = case when p_via = 'manual' then btrim(p_document) end,
         manual_by = v_admin,
         next_attempt_at = null, updated_at = p_now
   where id = v_inv.id;
  update bl.club_subscriptions
     set paid_until = greatest(coalesce(paid_until, v_inv.period_end_at), v_inv.period_end_at), updated_at = p_now
   where club_id = v_inv.club_id;
  return true;
end
$$;
alter function bl.billing_settle_invoice(uuid, text, uuid, text, text, timestamptz) owner to bl_definer;
revoke all on function bl.billing_settle_invoice(uuid, text, uuid, text, text, timestamptz) from public;
grant execute on function bl.billing_settle_invoice(uuid, text, uuid, text, text, timestamptz) to app_api;
comment on function bl.billing_settle_invoice(uuid, text, uuid, text, text, timestamptz) is
  'SECURITY DEFINER: счёт подписки оплачен (card, free — фоновые задачи; manual — platform_admin с причиной и платёжкой), один раз; продлевает paid_until.';

-- Персональная цена клуба (№180): только platform_admin, с причиной; NULL — цена плана.
-- Возвращает прежнюю персональную цену (NULL — была цена плана). Ошибки: 42501, 22023, P0002 — нет подписки.
create function bl.billing_set_price(p_club uuid, p_price bigint, p_reason text, p_now timestamptz)
returns bigint
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old bigint;
  v_found boolean;
begin
  if bl.ctx_platform_role() is distinct from 'platform_admin' then
    raise exception 'bl.billing_set_price: platform_admin only' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 1 or length(p_reason) > 2000 then
    raise exception 'bl.billing_set_price: reason' using errcode = '22023';
  end if;
  if p_price is not null and (p_price < 0 or p_price > 100000000) then
    raise exception 'bl.billing_set_price: price' using errcode = '22023';
  end if;
  select true, s.personal_price_kopecks into v_found, v_old from bl.club_subscriptions s where s.club_id = p_club for update;
  if v_found is null then
    raise exception 'bl.billing_set_price: no subscription' using errcode = 'P0002';
  end if;
  update bl.club_subscriptions
     set personal_price_kopecks = p_price,
         personal_price_reason = case when p_price is null then null else btrim(p_reason) end,
         personal_price_by = (select x.user_id from bl.billing_ctx() x), personal_price_at = p_now, updated_at = coalesce(p_now, now())
   where club_id = p_club;
  return v_old;
end
$$;
alter function bl.billing_set_price(uuid, bigint, text, timestamptz) owner to bl_definer;
revoke all on function bl.billing_set_price(uuid, bigint, text, timestamptz) from public;
grant execute on function bl.billing_set_price(uuid, bigint, text, timestamptz) to app_api;
comment on function bl.billing_set_price(uuid, bigint, text, timestamptz) is
  'SECURITY DEFINER: персональная цена подписки клуба — только platform_admin, с причиной (№180).';

-- Отключить автоплатёж (№185): владелец клуба из контекста; сохранённый способ оплаты забывается.
-- Возвращает true, если карта была. Ошибка 42501 — не владелец.
create function bl.billing_disable_autopay(p_club uuid, p_now timestamptz)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_had boolean;
  v_ctx record;
begin
  select * into v_ctx from bl.billing_ctx();
  if v_ctx.user_id is null or v_ctx.club_id is distinct from p_club or v_ctx.actor is distinct from 'user'
     or not exists (select 1 from bl.club_members m where m.club_id = p_club and m.user_id = v_ctx.user_id and m.role = 'owner' and m.active) then
    raise exception 'bl.billing_disable_autopay: owner of the club in context only' using errcode = '42501';
  end if;
  select s.payment_method_enc is not null into v_had from bl.club_subscriptions s where s.club_id = p_club for update;
  if v_had is null then
    return false;
  end if;
  update bl.club_subscriptions
     set autopay = false, payment_method_enc = null, card = null, card_saved_at = null, card_saved_by = null, updated_at = coalesce(p_now, now())
   where club_id = p_club;
  return v_had;
end
$$;
alter function bl.billing_disable_autopay(uuid, timestamptz) owner to bl_definer;
revoke all on function bl.billing_disable_autopay(uuid, timestamptz) from public;
grant execute on function bl.billing_disable_autopay(uuid, timestamptz) to app_api;
comment on function bl.billing_disable_autopay(uuid, timestamptz) is
  'SECURITY DEFINER: владелец клуба из контекста отключает автоплатёж подписки; способ оплаты забывается.';

-- Клубы для подписки: боевые (и приостановленные после live) и все, у кого есть подписка.
-- Только платформа (оператор и администратор) и фоновые задачи. tables — столы в работе.
grant select (suspended_at) on bl.clubs to bl_definer;

create function bl.billing_clubs()
returns table (club_id uuid, name text, city text, timezone text, mode text, mode_before_suspend text, went_live_at timestamptz, suspended_at timestamptz,
               tables integer)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if not ((select x.is_platform from bl.billing_ctx() x) or bl.ctx_platform_role() is not null) then
    raise exception 'bl.billing_clubs: platform only' using errcode = '42501';
  end if;
  return query
    select c.id, c.name, c.city, c.timezone, c.mode, c.mode_before_suspend, c.went_live_at, c.suspended_at,
           (select count(*)::integer from bl.resources r where r.club_id = c.id and r.active)
      from bl.clubs c
     where bl.billing_is_live(c.mode, c.mode_before_suspend)
        or exists (select 1 from bl.club_subscriptions s where s.club_id = c.id)
     order by c.city, c.name, c.id;
end
$$;
alter function bl.billing_clubs() owner to bl_definer;
revoke all on function bl.billing_clubs() from public;
grant execute on function bl.billing_clubs() to app_api;
comment on function bl.billing_clubs() is
  'SECURITY DEFINER: клубы для подписки (боевые и с подпиской): название, город, пояс, режим, столы в работе — только платформе.';

-- Возобновление после приостановки (№188): за время приостановки счета не выставляются и не
-- начисляются задним числом. Только фоновые задачи, клуб снова live, suspended_since задан.
--   * срок (пробный или оплаченный) кончался после начала приостановки — сдвигается на длительность
--     приостановки (целые сутки вверх, граница — местная полночь клуба);
--   * срок кончился до приостановки — неоплаченное остаётся долгом (открытые счета не трогаются),
--     следующий период начинается с даты возобновления: paid_until = местная полночь этой даты.
-- День счёта — день новой границы. Возвращает {from, to, kind: 'shift' | 'restart'} или NULL.
create function bl.billing_resume(p_club uuid, p_now timestamptz)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_sub record;
  v_tz text;
  v_mode text;
  v_end timestamptz;
  v_date date;
  v_kind text;
begin
  if not (select x.is_platform from bl.billing_ctx() x) then
    raise exception 'bl.billing_resume: system only' using errcode = '42501';
  end if;
  select c.timezone, c.mode into v_tz, v_mode from bl.clubs c where c.id = p_club;
  select * into v_sub from bl.club_subscriptions s where s.club_id = p_club for update;
  if v_sub.club_id is null or v_sub.suspended_since is null or v_mode is distinct from 'live' or p_now < v_sub.suspended_since then
    return null;
  end if;
  v_end := coalesce(v_sub.paid_until, v_sub.trial_until);
  if v_end > v_sub.suspended_since then
    v_kind := 'shift';
    v_date := (pg_catalog.timezone(v_tz, v_end))::date
              + ceil(extract(epoch from (p_now - v_sub.suspended_since)) / 86400.0)::integer;
  else
    v_kind := 'restart';
    v_date := (pg_catalog.timezone(v_tz, p_now))::date;
  end if;
  update bl.club_subscriptions
     set trial_until = case when v_kind = 'shift' and paid_until is null then (v_date::timestamp) at time zone v_tz else trial_until end,
         paid_until = case when v_kind = 'shift' and paid_until is null then null else (v_date::timestamp) at time zone v_tz end,
         anchor_day = extract(day from v_date)::smallint,
         suspended_since = null, reminder_for = null, updated_at = p_now
   where club_id = p_club;
  return jsonb_build_object('kind', v_kind, 'from', v_end, 'to', (v_date::timestamp) at time zone v_tz);
end
$$;
alter function bl.billing_resume(uuid, timestamptz) owner to bl_definer;
revoke all on function bl.billing_resume(uuid, timestamptz) from public;
grant execute on function bl.billing_resume(uuid, timestamptz) to app_api;
comment on function bl.billing_resume(uuid, timestamptz) is
  'SECURITY DEFINER: возобновление после приостановки (№188) — срок сдвигается, счёт с даты возобновления; только фоновые задачи.';

-- Клубы, которые уже работали в боевом режиме до M5.3: пробный период с даты выкатки (№181).
-- Пояс клуба — для местной полуночи конца пробного периода.
insert into bl.club_subscriptions (club_id, plan_id, trial_started_at, trial_until, anchor_day)
select c.id, p.id, s.released_at,
       (((pg_catalog.timezone(c.timezone, s.released_at))::date + p.trial_days)::timestamp) at time zone c.timezone,
       extract(day from (pg_catalog.timezone(c.timezone, s.released_at))::date + p.trial_days)::smallint
  from bl.clubs c
  cross join bl.billing_settings s
  join bl.billing_plans p on p.code = 'club'
 where bl.billing_is_live(c.mode, c.mode_before_suspend)
on conflict (club_id) do nothing;
