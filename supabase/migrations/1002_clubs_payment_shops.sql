-- 1002 (backend-A, M5.1 №154): два магазина ЮKassa клуба — тестовый и боевой; проверочный
-- платёж 1 ₽; тревога «вебхук ЮKassa не настроен».
--
-- * Боевая пара — прежние club_payment_settings.shop_id и secret_key_enc (контекст шифрования
--   yookassa_secret/<club_id>, как до M5.1): клубы, которые уже работали, продолжают принимать
--   деньги без перенастройки. Тестовая пара — test_shop_id и test_secret_key_enc (контекст
--   yookassa_secret/<club_id>/test). Сид разработки: npm run provision:dev кладёт магазин эмулятора
--   в обе пары (server/payments/provision-dev.mjs).
-- * Какая пара работает: новый платёж — по режиму клуба (test → тестовая, live → боевая);
--   всё, что относится к существующему платежу (вебхук, сверка, возврат, списание, чеки), — по
--   payments.is_test этого платежа.
-- * {test,live}_verified_at и {test,live}_me — когда и с каким ответом GET /v3/me пара проверена
--   при сохранении (account_id, test, fiscalization_enabled). Секрет наружу — только маской.
-- * shop_checks — проверочный платёж 1 ₽ (не платёж гостя: в bl.payments и отчёты не входит):
--   ЮKassa формирует чеки продажи и возврата сама (receipt в запросе).
-- * payments.webhook_at — когда пришёл вебхук по платежу; webhook_alarm_at — когда поднята тревога
--   «вебхук не настроен» (платёж подтверждён сверкой, а вебхука нет 10 минут).

alter table bl.club_payment_settings
  add column test_shop_id text check (test_shop_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  add column test_secret_key_enc text check (length(test_secret_key_enc) between 1 and 1000),
  add column test_verified_at timestamptz,
  add column test_me jsonb check (test_me is null or jsonb_typeof(test_me) = 'object'),
  add column live_verified_at timestamptz,
  add column live_me jsonb check (live_me is null or jsonb_typeof(live_me) = 'object'),
  add constraint club_payment_settings_test_pair_check check ((test_shop_id is null) = (test_secret_key_enc is null));

comment on column bl.club_payment_settings.shop_id is 'Боевой магазин ЮKassa клуба (M5.1 №154: пара live).';
comment on column bl.club_payment_settings.test_shop_id is 'Тестовый магазин ЮKassa клуба (M5.1 №154: пара test).';

grant update (test_shop_id, test_secret_key_enc, test_verified_at, test_me, live_verified_at, live_me)
  on bl.club_payment_settings to app_api;

-- Вебхуки по платежам гостей ------------------------------------------------------------------

alter table bl.payments
  add column webhook_at timestamptz,
  add column webhook_alarm_at timestamptz;
grant update (webhook_at, webhook_alarm_at) on bl.payments to app_api;
grant select (confirmed_at, webhook_at, webhook_alarm_at) on bl.payments to bl_definer;

-- Проверочный платёж 1 ₽ ----------------------------------------------------------------------

create table bl.shop_checks (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  mode text not null check (mode in ('test', 'live')),
  shop_id text not null check (shop_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  provider_payment_id text unique check (length(provider_payment_id) between 1 and 100),
  idempotence_key text not null check (length(idempotence_key) between 1 and 64),
  amount_kopecks bigint not null default 100 check (amount_kopecks = 100),
  status text not null check (status in ('pending', 'succeeded', 'canceled')),
  confirmation_url text check (length(confirmation_url) <= 2000),
  confirmed_at timestamptz,
  confirmed_via text check (confirmed_via in ('webhook', 'sync')),
  webhook_at timestamptz,
  refund_provider_id text check (length(refund_provider_id) between 1 and 100),
  refund_status text check (refund_status in ('pending', 'succeeded', 'canceled')),
  refunded_at timestamptz,
  error text check (error ~ '^[a-z][a-z0-9_]{0,63}$'),
  checked_at timestamptz,
  alarmed_at timestamptz,
  created_by uuid references bl.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, id),
  unique (club_id, idempotence_key)
);
create index shop_checks_club_idx on bl.shop_checks (club_id, mode, created_at desc);
create index shop_checks_open_idx on bl.shop_checks (created_at) where status = 'pending' or refund_status is distinct from 'succeeded';

alter table bl.shop_checks owner to bl_owner;
alter table bl.shop_checks enable row level security;
alter table bl.shop_checks force row level security;
create policy shop_checks_app on bl.shop_checks for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
revoke all on bl.shop_checks from public;
grant select, insert on bl.shop_checks to app_api;
grant update (provider_payment_id, status, confirmation_url, confirmed_at, confirmed_via, webhook_at, refund_provider_id,
              refund_status, refunded_at, error, checked_at, alarmed_at, updated_at) on bl.shop_checks to app_api;
grant select (id, club_id, status, confirmed_at, webhook_at, refund_status, checked_at, alarmed_at, created_at) on bl.shop_checks to bl_definer;
create policy shop_checks_definer on bl.shop_checks for select to bl_definer using (true);

comment on table bl.shop_checks is 'Проверочный платёж 1 ₽ магазина ЮKassa клуба с автоматическим возвратом (M5.1 №154).';

-- Дела планировщика подключения ------------------------------------------------------------------
-- (club_id, kind, id): check_sync — проверочный платёж ждёт ответа ЮKassa (сверка по API);
-- check_refund — проверочный платёж прошёл, возврат ещё не оформлен или не подтверждён;
-- check_webhook — проверочный платёж подтверждён сверкой, вебхука нет 10 минут;
-- payment_webhook — платёж гостя ЮKassa подтверждён сверкой, вебхука нет 10 минут (окно — час).

create function bl.onboarding_due(p_now timestamptz, p_limit integer)
returns table (club_id uuid, kind text, id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  (select c.club_id, 'check_sync'::text, c.id
     from bl.shop_checks c
    where c.status = 'pending'
      and c.created_at <= p_now - interval '15 seconds' and c.created_at > p_now - interval '1 day'
      and (c.checked_at is null or c.checked_at <= p_now - interval '15 seconds')
    order by c.created_at limit p_limit)
  union all
  (select c.club_id, 'check_refund'::text, c.id
     from bl.shop_checks c
    where c.status = 'succeeded' and c.refund_status is distinct from 'succeeded' and c.refund_status is distinct from 'canceled'
      and c.created_at > p_now - interval '7 days'
      and (c.checked_at is null or c.checked_at <= p_now - interval '15 seconds')
    order by c.created_at limit p_limit)
  union all
  (select c.club_id, 'check_webhook'::text, c.id
     from bl.shop_checks c
    where c.status = 'succeeded' and c.webhook_at is null and c.alarmed_at is null
      and c.confirmed_at <= p_now - interval '10 minutes' and c.confirmed_at > p_now - interval '1 day'
    order by c.confirmed_at limit p_limit)
  union all
  (select p.club_id, 'payment_webhook'::text, p.id
     from bl.payments p
    where p.provider = 'yookassa' and p.status in ('succeeded', 'waiting_for_capture')
      and p.webhook_at is null and p.webhook_alarm_at is null
      and p.confirmed_at <= p_now - interval '10 minutes' and p.confirmed_at > p_now - interval '1 hour'
    order by p.confirmed_at limit p_limit)
$$;
alter function bl.onboarding_due(timestamptz, integer) owner to bl_definer;
revoke all on function bl.onboarding_due(timestamptz, integer) from public;
grant execute on function bl.onboarding_due(timestamptz, integer) to app_api;
comment on function bl.onboarding_due(timestamptz, integer) is
  'SECURITY DEFINER: дела планировщика подключения (проверочные платежи, тревога «вебхук не настроен»): club_id, kind, id.';
