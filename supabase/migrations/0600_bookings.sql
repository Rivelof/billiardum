-- 0600 (backend-booking, M3): брони столов и лист ожидания.
--
-- Контракт M3 §1 п. 1–6, §3, §4; решения №104–109. Все таблицы с club_id: ENABLE + FORCE RLS,
-- политики app_api по bl.ctx_club_id(); гость дополнительно видит свои брони и свои записи
-- листа ожидания в личном контексте (bl.ctx_user_id()). Время — timestamptz (UTC) и задаётся
-- сервером (ctx.clock), деньги — bigint копеек.
--
-- Пересечения броней одного стола запрещает база: exclude using gist по (resource_id, period)
-- для броней, которые держат интервал (№105). Расширение btree_gist (оператор = для uuid
-- в индексе GiST) ставится в схему extensions: в образе supabase/postgres она есть в базе
-- postgres, во временных базах тестов (из template1) — создаётся здесь.
-- Платёж предоплаты (bl.payments, money) — мягкая ссылка без внешнего ключа: виды платежей
-- брони добавляет money в своих миграциях (0650–0699), как №92.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- bookings ---------------------------------------------------------------------------
-- Состояния: pending_payment (ждёт предоплаты, pay_until) → confirmed → reserved (за 15 минут
-- до начала стол получил state.reserved) → started (игра началась) → completed;
-- expired — не оплачена вовремя или гость не пришёл за время удержания; canceled — отменена.

create table bl.bookings (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  resource_id uuid not null,
  -- Гость приложения или сайта; у брони по телефону — имя и телефон без учётки.
  user_id uuid references bl.users (id),
  guest_name text check (length(btrim(guest_name)) between 1 and 100),
  guest_phone text check (guest_phone ~ '^\+[1-9][0-9]{7,14}$'),
  source text not null check (source in ('app', 'site', 'phone', 'staff')),
  created_by uuid references bl.users (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  period tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,
  status text not null check (status in ('pending_payment', 'confirmed', 'reserved', 'started', 'expired', 'canceled', 'completed')),
  prepayment_mode text not null check (prepayment_mode in ('none', 'deposit', 'full')),
  -- Цена интервала по тарифу на момент брони; сколько нужно и сколько внесено предоплатой.
  amount_kopecks bigint not null check (amount_kopecks >= 0),
  prepayment_kopecks bigint not null default 0 check (prepayment_kopecks >= 0),
  prepaid_kopecks bigint not null default 0 check (prepaid_kopecks >= 0),
  prepayment_id uuid,
  pay_until timestamptz,
  -- Котировка доплаты при старте (ранний приход, бронь без полной предоплаты).
  start_quote_id uuid,
  hold_minutes smallint not null check (hold_minutes between 0 and 120),
  session_id uuid,
  -- Что уже сделано планировщиком: {"h1": true, "m15": true, "reserved_hold": true}.
  notified jsonb not null default '{}'::jsonb check (jsonb_typeof(notified) = 'object'),
  reserved_at timestamptz,
  started_at timestamptz,
  expired_at timestamptz,
  expire_reason text check (expire_reason in ('unpaid', 'no_show')),
  canceled_at timestamptz,
  canceled_by uuid references bl.users (id),
  cancel_reason text check (length(cancel_reason) between 1 and 2000),
  forfeit_percent smallint check (forfeit_percent between 0 and 100),
  completed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  foreign key (club_id, session_id) references bl.sessions (club_id, id),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '24 hours'),
  check (user_id is not null or (guest_name is not null and guest_phone is not null)),
  check (prepaid_kopecks <= prepayment_kopecks),
  check (status <> 'pending_payment' or pay_until is not null),
  check (status not in ('expired') or (expired_at is not null and expire_reason is not null)),
  check (status not in ('canceled') or canceled_at is not null),
  -- Интервал держат только живые брони: сгоревшая, отменённая и завершённая его отпускают (№105).
  constraint bookings_no_overlap exclude using gist (resource_id with =, period with &&)
    where (status in ('pending_payment', 'confirmed', 'reserved', 'started'))
);
create index bookings_club_start_idx on bl.bookings (club_id, starts_at);
create index bookings_resource_start_idx on bl.bookings (resource_id, starts_at)
  where status in ('pending_payment', 'confirmed', 'reserved', 'started');
create index bookings_user_idx on bl.bookings (user_id, starts_at desc) where user_id is not null;
create unique index bookings_prepayment_uidx on bl.bookings (prepayment_id) where prepayment_id is not null;
create index bookings_start_quote_idx on bl.bookings (start_quote_id) where start_quote_id is not null;
create index bookings_session_idx on bl.bookings (session_id) where session_id is not null;

comment on table bl.bookings is 'Брони столов (контракт M3). Пересечения живых броней стола запрещены exclude using gist.';

-- waitlist ---------------------------------------------------------------------------
-- «Сообщить, когда освободится» (№109): первому в очереди — предложение на 5 минут
-- (offered, offer_until); принял — accepted (стол удержан pending, переход к оплате);
-- не ответил — expired, предложение следующему.

create table bl.waitlist (
  id uuid primary key default gen_random_uuid(),
  -- Порядок очереди: кто раньше встал (время сервера может совпасть, номер — нет).
  seq bigint generated always as identity,
  club_id uuid not null references bl.clubs (id),
  resource_id uuid not null,
  user_id uuid not null references bl.users (id),
  status text not null check (status in ('waiting', 'offered', 'accepted', 'expired', 'canceled')),
  offered_at timestamptz,
  offer_until timestamptz,
  accepted_at timestamptz,
  hold_until timestamptz,
  closed_at timestamptz,
  close_reason text check (close_reason ~ '^[a-z_]{1,32}$'),
  -- Сколько раз предложение не застало стол свободным при принятии (возврат в очередь).
  missed smallint not null default 0 check (missed between 0 and 100),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  check (status <> 'offered' or (offered_at is not null and offer_until is not null))
);
-- Одна живая запись гостя на стол.
create unique index waitlist_active_uidx on bl.waitlist (resource_id, user_id) where status in ('waiting', 'offered');
create index waitlist_queue_idx on bl.waitlist (resource_id, seq) where status in ('waiting', 'offered');
create index waitlist_user_idx on bl.waitlist (user_id, created_at desc);

comment on table bl.waitlist is 'Лист ожидания стола (контракт M3 §1 п. 6, решение №109).';

-- Владелец, RLS, права ---------------------------------------------------------------

alter table bl.bookings owner to bl_owner;
alter table bl.waitlist owner to bl_owner;

alter table bl.bookings enable row level security;
alter table bl.bookings force row level security;
alter table bl.waitlist enable row level security;
alter table bl.waitlist force row level security;

create policy bookings_app on bl.bookings for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());
create policy waitlist_app on bl.waitlist for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

-- Гость видит свои брони и записи очереди в любом клубе (GET /api/me/bookings, /api/me/waitlist).
-- Изменения — только в контексте клуба брони.
create policy bookings_self on bl.bookings for select to app_api
  using (user_id = bl.ctx_user_id());
create policy waitlist_self on bl.waitlist for select to app_api
  using (user_id = bl.ctx_user_id());

revoke all on bl.bookings, bl.waitlist from public;
grant select, insert on bl.bookings to app_api;
grant update (status, prepayment_kopecks, prepaid_kopecks, prepayment_id, pay_until, start_quote_id, session_id, notified, reserved_at,
              started_at, expired_at, expire_reason, canceled_at, canceled_by, cancel_reason, forfeit_percent,
              completed_at, updated_at) on bl.bookings to app_api;
grant select, insert on bl.waitlist to app_api;
grant update (status, offered_at, offer_until, accepted_at, hold_until, closed_at, close_reason, missed, updated_at)
  on bl.waitlist to app_api;

-- Узкая функция SECURITY DEFINER для планировщика ---------------------------------------
-- bl_definer видит у броней и очереди только поля, нужные для выбора дел.

grant select (id, club_id, status, starts_at, ends_at, pay_until) on bl.bookings to bl_definer;
grant select (id, club_id, status, offer_until, created_at) on bl.waitlist to bl_definer;
create policy bookings_definer on bl.bookings for select to bl_definer using (true);
create policy waitlist_definer on bl.waitlist for select to bl_definer using (true);

-- Дела планировщика броней всех клубов на момент p_now (время сервера, ctx.clock):
--   booking  — неоплаченная бронь после pay_until; подтверждённая или удержанная, до начала
--              которой меньше p_lead (напоминания, state.reserved, сгорание); идущая после конца;
--   waitlist — предложение после offer_until; запись в очереди старше p_stale.
create function bl.booking_due(p_now timestamptz, p_lead interval, p_stale interval, p_limit integer)
returns table (kind text, id uuid, club_id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  (select 'booking'::text, b.id, b.club_id from bl.bookings b
    where (b.status = 'pending_payment' and b.pay_until <= p_now)
       or (b.status in ('confirmed', 'reserved') and b.starts_at - p_lead <= p_now)
       or (b.status = 'started' and b.ends_at <= p_now)
    order by b.starts_at
    limit greatest(least(p_limit, 1000), 1))
  union all
  (select 'waitlist'::text, w.id, w.club_id from bl.waitlist w
    where (w.status = 'offered' and w.offer_until <= p_now)
       or (w.status = 'waiting' and w.created_at <= p_now - p_stale)
    order by w.created_at
    limit greatest(least(p_limit, 1000), 1))
$$;

alter function bl.booking_due(timestamptz, interval, interval, integer) owner to bl_definer;
revoke all on function bl.booking_due(timestamptz, interval, interval, integer) from public;
grant execute on function bl.booking_due(timestamptz, interval, interval, integer) to app_api;

comment on function bl.booking_due(timestamptz, interval, interval, integer) is
  'SECURITY DEFINER: (kind, id, club_id) броней и записей очереди, по которым планировщику пора действовать. Только планировщик.';
