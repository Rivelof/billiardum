-- 0200: деньги M1 (контракт docs/contracts/m1.md §5, §13; decisions №23, №26, №44–48, №52).
--
-- Таблицы: club_payment_settings (магазин ЮKassa клуба и чеки), quotes (котировка на 3 минуты),
-- payments (provider_payment_id уникален), refunds, reception_requests (заявки «Оплачу на
-- ресепшене»), receipts (чеки 54-ФЗ: ЮKassa и задания на ККТ).
-- Idempotency-Key денежных запросов (контракт §3) хранится в самих строках: payments.request_key
-- (оплата, приём на ресепшене), reception_requests.request_key (заявка): повтор с тем же ключом
-- получает тот же платёж или заявку, тот же ключ с другим запросом — idempotency_conflict.
--
-- Все таблицы с club_id: ENABLE + FORCE ROW LEVEL SECURITY, политики только для app_api
-- по bl.ctx_club_id(). Владелец — bl_owner. DELETE и TRUNCATE нет ни у кого из рабочих ролей;
-- UPDATE — только перечисленных столбцов (сумма, клуб, плательщик и способ оплаты после
-- вставки не меняются).
--
-- Внешние ключи на таблицы backend-light (sessions) добавляет 0390_money_fks.sql (light):
-- quotes.session_id, payments.session_id, reception_requests.session_id.

-- Магазин ЮKassa клуба и настройки чеков ---------------------------------------------------
-- secret_key_enc — AES-256-GCM в приложении (server/lib/secrets.mjs, контекст
-- yookassa_secret/<club_id>), ключ шифрования только в .env (decisions №23).
-- vat_code и tax_system_code — коды ЮKassa; ставку НДС и СНО клуб сверяет с бухгалтером (№52).

create table bl.club_payment_settings (
  club_id uuid primary key references bl.clubs (id),
  provider text not null default 'yookassa' check (provider = 'yookassa'),
  shop_id text check (shop_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  secret_key_enc text check (length(secret_key_enc) between 1 and 1000),
  sbp_enabled boolean not null default true,
  card_enabled boolean not null default true,
  reception_enabled boolean not null default true,
  vat_code smallint not null default 1 check (vat_code between 1 and 12),
  tax_system_code smallint check (tax_system_code between 1 and 6),
  -- Карта «Без лимита»: заморозка суммы за столько минут (PRODUCT §3).
  unlimited_hold_minutes integer not null default 120 check (unlimited_hold_minutes between 30 and 480),
  -- СБП «Без лимита»: блоки по столько минут (decisions №26).
  sbp_block_minutes integer not null default 30 check (sbp_block_minutes between 10 and 120),
  -- Заявка «Оплачу на ресепшене» живёт столько минут (§5).
  reception_request_minutes integer not null default 15 check (reception_request_minutes between 5 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((shop_id is null) = (secret_key_enc is null))
);

comment on table bl.club_payment_settings is 'Магазин ЮKassa клуба (секрет зашифрован в приложении) и настройки чеков 54-ФЗ.';

-- Котировки --------------------------------------------------------------------------------
-- Держится 3 минуты (valid_until) и используется один раз (used_at).
-- minutes NULL — «Без лимита»: amount_kopecks — заморозка за hold_minutes (карта),
-- block_amount_kopecks — первый блок block_minutes (СБП).

create table bl.quotes (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  resource_id uuid not null,
  user_id uuid not null references bl.users (id),
  kind text not null check (kind in ('start', 'extend')),
  session_id uuid,
  unlimited boolean not null default false,
  minutes integer check (minutes between 1 and 10080),
  from_at timestamptz not null,
  amount_kopecks bigint not null check (amount_kopecks >= 0),
  breakdown jsonb not null default '[]'::jsonb check (jsonb_typeof(breakdown) = 'array'),
  hold_minutes integer check (hold_minutes between 1 and 10080),
  block_minutes integer check (block_minutes between 1 and 10080),
  block_amount_kopecks bigint check (block_amount_kopecks >= 0),
  created_at timestamptz not null default now(),
  valid_until timestamptz not null,
  used_at timestamptz,
  unique (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  check (kind = 'start' or session_id is not null),
  check (unlimited = (minutes is null)),
  check (not unlimited or (hold_minutes is not null and block_minutes is not null and block_amount_kopecks is not null)),
  check (valid_until > created_at)
);
create index quotes_club_resource_idx on bl.quotes (club_id, resource_id, created_at desc);
create index quotes_user_idx on bl.quotes (user_id, created_at desc);

-- Платежи ----------------------------------------------------------------------------------
-- provider_payment_id — id платежа ЮKassa, уникален: вебхук обрабатывается один раз.
-- confirmed_at — момент события outbox payment.confirmed (ставится ровно один раз).
-- capture = false — двухстадийный платёж (карта «Без лимита»): сумма заморожена,
-- списывается фактическая при закрытии сессии (captured_kopecks).

create table bl.payments (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  resource_id uuid not null,
  user_id uuid not null references bl.users (id),
  quote_id uuid,
  session_id uuid,
  kind text not null check (kind in ('start', 'extend')),
  provider text not null check (provider in ('yookassa', 'reception')),
  method text not null check (method in ('sbp', 'card', 'cash', 'card_terminal')),
  provider_payment_id text check (length(provider_payment_id) between 1 and 100),
  idempotence_key text not null check (length(idempotence_key) between 1 and 64),
  request_key uuid,
  status text not null check (status in ('pending', 'waiting_for_capture', 'succeeded', 'canceled')),
  amount_kopecks bigint not null check (amount_kopecks > 0),
  capture boolean not null default true,
  captured_kopecks bigint check (captured_kopecks >= 0 and captured_kopecks <= amount_kopecks),
  minutes integer check (minutes between 1 and 10080),
  unlimited boolean not null default false,
  confirmation_url text check (length(confirmation_url) <= 2000),
  received_kopecks bigint check (received_kopecks >= 0),
  change_kopecks bigint check (change_kopecks >= 0),
  accepted_by uuid references bl.users (id),
  cancellation_reason text check (length(cancellation_reason) <= 200),
  confirmed_at timestamptz,
  captured_at timestamptz,
  canceled_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, id),
  unique (club_id, idempotence_key),
  unique (club_id, request_key),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  foreign key (club_id, quote_id) references bl.quotes (club_id, id),
  check (
    (provider = 'yookassa' and method in ('sbp', 'card') and provider_payment_id is not null)
    or (provider = 'reception' and method in ('cash', 'card_terminal') and capture)
  ),
  check (capture or method = 'card')
);
create unique index payments_provider_payment_uidx on bl.payments (provider_payment_id) where provider_payment_id is not null;
create unique index payments_quote_uidx on bl.payments (quote_id) where quote_id is not null;
create index payments_club_resource_idx on bl.payments (club_id, resource_id, status);
create index payments_club_user_idx on bl.payments (club_id, user_id, created_at desc);

comment on table bl.payments is 'Платежи гостей: ЮKassa (СБП, карта) и ресепшн (наличные, терминал). provider_payment_id уникален.';

-- Возвраты ---------------------------------------------------------------------------------

create table bl.refunds (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  payment_id uuid not null,
  provider_refund_id text check (length(provider_refund_id) between 1 and 100),
  idempotence_key text not null check (length(idempotence_key) between 1 and 64),
  amount_kopecks bigint not null check (amount_kopecks > 0),
  status text not null check (status in ('pending', 'succeeded', 'canceled', 'manual')),
  reason text not null check (length(reason) between 1 and 2000),
  requested_by uuid references bl.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, id),
  unique (club_id, idempotence_key),
  foreign key (club_id, payment_id) references bl.payments (club_id, id)
);
create unique index refunds_provider_refund_uidx on bl.refunds (provider_refund_id) where provider_refund_id is not null;
create index refunds_payment_idx on bl.refunds (club_id, payment_id);

-- Заявки «Оплачу на ресепшене» ---------------------------------------------------------------

create table bl.reception_requests (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  quote_id uuid not null,
  resource_id uuid not null,
  user_id uuid not null references bl.users (id),
  kind text not null check (kind in ('start', 'extend')),
  session_id uuid,
  minutes integer not null check (minutes between 1 and 10080),
  amount_kopecks bigint not null check (amount_kopecks > 0),
  status text not null default 'waiting' check (status in ('waiting', 'accepted', 'declined', 'expired')),
  request_key uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references bl.users (id),
  decline_reason_code text check (decline_reason_code ~ '^[a-z][a-z0-9_]{0,49}$'),
  payment_id uuid,
  unique (club_id, id),
  unique (quote_id),
  unique (club_id, request_key),
  foreign key (club_id, quote_id) references bl.quotes (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  foreign key (club_id, payment_id) references bl.payments (club_id, id),
  check (status <> 'accepted' or payment_id is not null)
);
create index reception_requests_waiting_idx on bl.reception_requests (club_id, expires_at) where status = 'waiting';

-- Чеки 54-ФЗ -------------------------------------------------------------------------------
-- channel yookassa — чек формирует ЮKassa (status из receipt_registration);
-- channel kkt — задание на ККТ клуба (tools/kkt-bridge/, M2): receipt_pending до пробития.
-- customer_phone — контакт покупателя в чеке (54-ФЗ): чек списания заморозки и возврата
-- формирует система без контекста гостя, поэтому телефон берётся из чека продажи.

create table bl.receipts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  payment_id uuid,
  refund_id uuid,
  kind text not null check (kind in ('sale', 'refund')),
  channel text not null check (channel in ('yookassa', 'kkt')),
  status text not null check (status in ('receipt_pending', 'pending', 'succeeded', 'canceled', 'failed')),
  amount_kopecks bigint not null check (amount_kopecks > 0),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  tax_system_code smallint check (tax_system_code between 1 and 6),
  customer_user_id uuid references bl.users (id),
  customer_phone text check (customer_phone ~ '^\+[1-9][0-9]{7,14}$'),
  attempts integer not null default 0 check (attempts >= 0),
  fiscal jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, id),
  foreign key (club_id, payment_id) references bl.payments (club_id, id),
  foreign key (club_id, refund_id) references bl.refunds (club_id, id),
  check (num_nonnulls(payment_id, refund_id) >= 1),
  check (kind = 'sale' or refund_id is not null)
);
create index receipts_club_status_idx on bl.receipts (club_id, status, created_at);
create index receipts_payment_idx on bl.receipts (club_id, payment_id);

-- Владелец ---------------------------------------------------------------------------------

alter table bl.club_payment_settings owner to bl_owner;
alter table bl.quotes owner to bl_owner;
alter table bl.payments owner to bl_owner;
alter table bl.refunds owner to bl_owner;
alter table bl.reception_requests owner to bl_owner;
alter table bl.receipts owner to bl_owner;

-- RLS --------------------------------------------------------------------------------------

alter table bl.club_payment_settings enable row level security;
alter table bl.club_payment_settings force row level security;
alter table bl.quotes enable row level security;
alter table bl.quotes force row level security;
alter table bl.payments enable row level security;
alter table bl.payments force row level security;
alter table bl.refunds enable row level security;
alter table bl.refunds force row level security;
alter table bl.reception_requests enable row level security;
alter table bl.reception_requests force row level security;
alter table bl.receipts enable row level security;
alter table bl.receipts force row level security;

create policy club_payment_settings_app on bl.club_payment_settings for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy quotes_app on bl.quotes for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy payments_app on bl.payments for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy refunds_app on bl.refunds for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy reception_requests_app on bl.reception_requests for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy receipts_app on bl.receipts for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());

-- Права app_api: без DELETE и TRUNCATE; UPDATE — только изменяемых столбцов --------------------

revoke all on bl.club_payment_settings, bl.quotes, bl.payments, bl.refunds, bl.reception_requests,
  bl.receipts from public;

grant select, insert on bl.club_payment_settings to app_api;
grant update (shop_id, secret_key_enc, sbp_enabled, card_enabled, reception_enabled, vat_code, tax_system_code,
  unlimited_hold_minutes, sbp_block_minutes, reception_request_minutes, updated_at) on bl.club_payment_settings to app_api;

grant select, insert on bl.quotes to app_api;
grant update (used_at) on bl.quotes to app_api;

grant select, insert on bl.payments to app_api;
grant update (session_id, status, captured_kopecks, confirmation_url, cancellation_reason,
  confirmed_at, captured_at, canceled_at, checked_at, updated_at) on bl.payments to app_api;

grant select, insert on bl.refunds to app_api;
grant update (provider_refund_id, status, updated_at) on bl.refunds to app_api;

grant select, insert on bl.reception_requests to app_api;
grant update (status, decided_at, decided_by, decline_reason_code, payment_id) on bl.reception_requests to app_api;

grant select, insert on bl.receipts to app_api;
grant update (status, attempts, fiscal, updated_at) on bl.receipts to app_api;


-- Подтверждение платежа один раз: confirmed_at, captured_at, canceled_at не стираются и
-- не переписываются; статус не возвращается из конечного в pending.

create function bl.payments_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.confirmed_at is not null and new.confirmed_at is distinct from old.confirmed_at then
    raise exception 'bl.payments: confirmed_at is set once' using errcode = 'check_violation';
  end if;
  if old.captured_at is not null and new.captured_at is distinct from old.captured_at then
    raise exception 'bl.payments: captured_at is set once' using errcode = 'check_violation';
  end if;
  if old.canceled_at is not null and new.canceled_at is distinct from old.canceled_at then
    raise exception 'bl.payments: canceled_at is set once' using errcode = 'check_violation';
  end if;
  if old.session_id is not null and new.session_id is distinct from old.session_id then
    raise exception 'bl.payments: session_id is set once' using errcode = 'check_violation';
  end if;
  if old.status in ('succeeded', 'canceled') and new.status <> old.status then
    raise exception 'bl.payments: final status % cannot change', old.status using errcode = 'check_violation';
  end if;
  if old.status = 'waiting_for_capture' and new.status = 'pending' then
    raise exception 'bl.payments: status cannot go back to pending' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function bl.payments_guard() owner to bl_owner;
revoke all on function bl.payments_guard() from public;

create trigger payments_guard before update on bl.payments
  for each row execute function bl.payments_guard();

-- Узкие функции SECURITY DEFINER (supabase/README.md) --------------------------------------
-- Гость приходит без клуба в контексте: клуб котировки, платежа или заявки находится по UUID,
-- затем запрос идёт с контекстом этого клуба и RLS. Видны только id и club_id.
-- Клуб стола — bl.resource_club (0300, light).

grant select (id, club_id) on bl.quotes to bl_definer;
grant select (id, club_id, status, provider, created_at, checked_at) on bl.payments to bl_definer;
grant select (id, club_id, status, expires_at) on bl.reception_requests to bl_definer;

create policy quotes_definer on bl.quotes for select to bl_definer using (true);
create policy payments_definer on bl.payments for select to bl_definer using (true);
create policy reception_requests_definer on bl.reception_requests for select to bl_definer using (true);

create function bl.money_object_club(p_kind text, p_id uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select case p_kind
    when 'quote' then (select q.club_id from bl.quotes q where q.id = p_id)
    when 'payment' then (select p.club_id from bl.payments p where p.id = p_id)
    when 'reception_request' then (select rr.club_id from bl.reception_requests rr where rr.id = p_id)
  end
$$;

-- Работа по времени для планировщика денег (server/payments/index.mjs): заявки ресепшена,
-- которые пора сжечь, и платежи ЮKassa в pending, которые пора сверить по API
-- (вебхук потерялся). Только идентификаторы.
create function bl.money_due(p_now timestamptz, p_limit integer)
returns table (club_id uuid, kind text, id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  (select rr.club_id, 'reception_expired'::text, rr.id
     from bl.reception_requests rr
    where rr.status = 'waiting' and rr.expires_at <= p_now
    order by rr.expires_at
    limit p_limit)
  union all
  (select p.club_id, 'payment_stale'::text, p.id
     from bl.payments p
    where p.provider = 'yookassa' and p.status = 'pending'
      and p.created_at <= p_now - interval '1 minute'
      and p.created_at > p_now - interval '2 days'
      and (p.checked_at is null or p.checked_at <= p_now - interval '1 minute')
    order by p.created_at
    limit p_limit)
$$;

alter function bl.money_object_club(text, uuid) owner to bl_definer;
alter function bl.money_due(timestamptz, integer) owner to bl_definer;
revoke all on function bl.money_object_club(text, uuid), bl.money_due(timestamptz, integer) from public;
grant execute on function bl.money_object_club(text, uuid), bl.money_due(timestamptz, integer) to app_api;

comment on function bl.money_object_club(text, uuid) is 'SECURITY DEFINER: club_id котировки, платежа или заявки ресепшена по UUID (или NULL).';
comment on function bl.money_due(timestamptz, integer) is 'SECURITY DEFINER: заявки ресепшена к сгоранию и платежи ЮKassa к сверке (club_id, kind, id).';
