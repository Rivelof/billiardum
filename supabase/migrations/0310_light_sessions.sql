-- 0310 (backend-light): сессии, участники, платежи сессии, удержания стола.
--
-- Контракт M1 §6, §13. Все таблицы с club_id: ENABLE + FORCE RLS, политики app_api
-- по bl.ctx_club_id(); гость дополнительно видит свои сессии и своё участие в любом
-- клубе (bl.ctx_user_id()). Время — timestamptz (UTC), деньги — bigint копеек.
-- Время событий задаёт сервер (ctx.clock), а не now() базы: так работают ускоренные часы
-- в тестах и сценариях T3–T6.
-- Внешние ключи на bl.payments — в 0390_money_fks.sql (после миграций money 0200).

-- sessions -------------------------------------------------------------------------
-- Состояния: active → ending (≤ warn_ms[0] до конца) → grace (льгота) → closed;
-- interrupted — контроллер доиграл без связи, а оплачено больше, чем горел свет
-- (гость выбирает «Продолжить» или «Вернуть»); cancelled — отменена до игры или возвратом.

create table bl.sessions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  resource_id uuid not null,
  status text not null check (status in ('active', 'ending', 'grace', 'closed', 'interrupted', 'cancelled')),
  source text not null default 'qr' check (source in ('qr', 'booking', 'reception', 'staff')),
  payer_user_id uuid not null references bl.users (id),
  unlimited boolean not null default false,
  started_at timestamptz not null,
  paid_until timestamptz not null,
  warn_ms integer[] not null default '{300000,60000}' check (
    cardinality(warn_ms) = 2
    and array_position(warn_ms, null) is null
    and warn_ms[1] > warn_ms[2]
    and warn_ms[2] >= 1
    and warn_ms[1] <= 3600000
  ),
  grace_ms integer not null default 120000 check (grace_ms between 0 and 600000),
  -- До какого момента контроллер подтвердил свет (ack session.start/extend/resume):
  -- время ack + remaining_ms. Нужен, чтобы понять, что гость недоиграл без связи.
  device_paid_until timestamptz,
  interrupted_at timestamptz,
  unplayed_ms bigint check (unplayed_ms >= 0),
  ended_at timestamptz,
  close_reason text check (close_reason in ('expired', 'stopped', 'refunded', 'cancelled')),
  -- Отправленные гостю сигналы: {"t10": "<paid_until>", ...} — сигнал повторяется после продления.
  notified jsonb not null default '{}'::jsonb check (jsonb_typeof(notified) = 'object'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  check (status not in ('closed', 'cancelled') or ended_at is not null),
  check (status <> 'interrupted' or (interrupted_at is not null and unplayed_ms is not null))
);

-- Одна идущая сессия на стол. interrupted стол не держит: свет погас, гость выбирает.
create unique index sessions_open_resource_key on bl.sessions (resource_id)
  where status in ('active', 'ending', 'grace');
create index sessions_club_status_idx on bl.sessions (club_id, status);
create index sessions_payer_idx on bl.sessions (payer_user_id);

comment on table bl.sessions is 'Игровые сессии стола (контракт M1 §6). paid_until — единственный источник оплаченного времени.';

-- session_participants -----------------------------------------------------------

create table bl.session_participants (
  session_id uuid not null,
  club_id uuid not null,
  user_id uuid not null references bl.users (id),
  role text not null check (role in ('payer', 'player')),
  ordinal smallint not null check (ordinal between 1 and 100),
  joined_at timestamptz not null,
  primary key (session_id, user_id),
  unique (session_id, ordinal),
  foreign key (club_id, session_id) references bl.sessions (club_id, id)
);
create index session_participants_user_idx on bl.session_participants (user_id);

-- session_payments ---------------------------------------------------------------
-- Связь платежа (bl.payments, money) и сессии; обработка payment.confirmed один раз
-- по payment_id. outcome = refunded: стол был занят к моменту оплаты, платёж возвращён.

create table bl.session_payments (
  payment_id uuid primary key,
  club_id uuid not null references bl.clubs (id),
  session_id uuid,
  quote_id uuid,
  kind text not null check (kind in ('start', 'extend')),
  outcome text not null check (outcome in ('applied', 'refunded')),
  minutes integer check (minutes between 0 and 1440),
  unlimited boolean not null default false,
  amount_kopecks bigint not null check (amount_kopecks >= 0),
  method text check (method ~ '^[a-z_]{1,32}$'),
  refunded_kopecks bigint not null default 0,
  confirmed_at timestamptz,
  created_at timestamptz not null,
  foreign key (club_id, session_id) references bl.sessions (club_id, id),
  check (refunded_kopecks between 0 and amount_kopecks),
  check (outcome <> 'applied' or session_id is not null)
);
create index session_payments_session_idx on bl.session_payments (session_id);

-- resource_holds -----------------------------------------------------------------
-- Удержание стола: pending (гость перешёл к оплате, 3 минуты), reserved (бронь ждёт),
-- service (сервисный свет с причиной). Действует, пока released_at IS NULL и until > сейчас.
-- Гонку двух гостей решает блокировка строки ресурса (SELECT … FOR UPDATE).

create table bl.resource_holds (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null,
  resource_id uuid not null,
  kind text not null check (kind in ('pending', 'reserved', 'service')),
  user_id uuid references bl.users (id),
  until timestamptz not null,
  reason_code text check (reason_code ~ '^[a-z0-9_]{1,32}$'),
  reason_text text check (length(reason_text) between 1 and 2000),
  created_at timestamptz not null,
  released_at timestamptz,
  release_reason text check (release_reason ~ '^[a-z_]{1,32}$'),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  check (until > created_at),
  check (kind <> 'service' or (reason_code is not null and reason_text is not null and user_id is not null)),
  check (kind <> 'pending' or user_id is not null)
);
create index resource_holds_open_idx on bl.resource_holds (resource_id, until) where released_at is null;

-- Владелец, RLS, права ------------------------------------------------------------

alter table bl.sessions owner to bl_owner;
alter table bl.session_participants owner to bl_owner;
alter table bl.session_payments owner to bl_owner;
alter table bl.resource_holds owner to bl_owner;

alter table bl.sessions enable row level security;
alter table bl.sessions force row level security;
alter table bl.session_participants enable row level security;
alter table bl.session_participants force row level security;
alter table bl.session_payments enable row level security;
alter table bl.session_payments force row level security;
alter table bl.resource_holds enable row level security;
alter table bl.resource_holds force row level security;

create policy sessions_app on bl.sessions for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());
create policy session_participants_app on bl.session_participants for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());
create policy session_payments_app on bl.session_payments for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());
create policy resource_holds_app on bl.resource_holds for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

-- Гость видит своё участие и свои сессии в любом клубе (GET /api/sessions/current).
create policy session_participants_self on bl.session_participants for select to app_api
  using (user_id = bl.ctx_user_id());
create policy sessions_participant on bl.sessions for select to app_api
  using (exists (
    select 1 from bl.session_participants p
     where p.session_id = sessions.id and p.user_id = bl.ctx_user_id()
  ));

revoke all on bl.sessions, bl.session_participants, bl.session_payments, bl.resource_holds from public;
grant select, insert, update on bl.sessions to app_api;
grant select, insert on bl.session_participants to app_api;
grant select, insert on bl.session_payments to app_api;
grant update (refunded_kopecks) on bl.session_payments to app_api;
grant select, insert on bl.resource_holds to app_api;
grant update (until, released_at, release_reason) on bl.resource_holds to app_api;

-- Узкие функции SECURITY DEFINER -------------------------------------------------
-- bl_definer видит у sessions только id, club_id, status.

grant select (id, club_id, status) on bl.sessions to bl_definer;
create policy sessions_definer on bl.sessions for select to bl_definer using (true);

-- Клуб сессии по id: маршруты /api/sessions/{id}/… узнают клуб до проверки прав.
create function bl.session_club(p_session_id uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$ select s.club_id from bl.sessions s where s.id = p_session_id $$;

-- Идущие сессии всех клубов: планировщик восстанавливает таймеры после перезапуска.
create function bl.light_open_sessions()
returns table (session_id uuid, club_id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select s.id, s.club_id from bl.sessions s
   where s.status in ('active', 'ending', 'grace')
$$;

alter function bl.session_club(uuid) owner to bl_definer;
alter function bl.light_open_sessions() owner to bl_definer;
revoke all on function bl.session_club(uuid), bl.light_open_sessions() from public;
grant execute on function bl.session_club(uuid), bl.light_open_sessions() to app_api;

comment on function bl.session_club(uuid) is 'SECURITY DEFINER: club_id сессии или NULL. Маршруты сессий до проверки прав.';
comment on function bl.light_open_sessions() is 'SECURITY DEFINER: (session_id, club_id) идущих сессий всех клубов. Только планировщик.';
