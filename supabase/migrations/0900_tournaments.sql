-- 0900 (backend-tournaments, M4): турниры клуба — запись со взносом, посев, сетка, матчи, счёт.
--
-- Контракт M4 §1 п. 11, §3, §4; решения №138, №143; PRODUCT §14. Все таблицы с club_id:
-- ENABLE + FORCE RLS, политики app_api по bl.ctx_club_id().
--
-- Публичная часть (сайт, ТВ): опубликованный турнир (не черновик) читается и без клуба
-- в контексте — анонимный запрос сайта, личный контекст гостя, планировщик платформы. В строке
-- турнира нет персональных данных и служебных полей (кто создал, причина отмены — только в журнале).
-- Участники и матчи — только в контексте клуба турнира; игрок дополнительно видит свои записи
-- и свои матчи в личном контексте. Наружу участник — только ник (снимок при записи), посев и рейтинг.
--
-- Деньги — bigint копеек; время — timestamptz (UTC), задаётся сервером (ctx.clock).
-- Платёж взноса (bl.payments, money) — мягкая ссылка без внешнего ключа (как №92): вид платежа
-- tournament добавляет money в своих миграциях.

-- tournaments ------------------------------------------------------------------------------
-- Статусы: draft (черновик, не виден) → registration (запись открыта) → closed (запись закрыта)
-- → running (сетка построена, матчи идут) → finished; canceled — отменён клубом (взносы — всем назад).

create table bl.tournaments (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  title text not null check (length(btrim(title)) between 1 and 120),
  description text check (length(description) <= 4000),
  discipline text not null check (discipline in ('pyramid', 'pool', 'snooker')),
  format text not null check (format in ('single_elim', 'groups_playoff')),
  -- Матч до N побед (в пирамиде партия до 8 шаров — правило дисциплины).
  race_to smallint not null check (race_to between 1 and 25),
  -- Ограничение по рейтингу дисциплины (T24): выше rating_max — отказ с объяснением.
  rating_min integer check (rating_min between 0 and 4000),
  rating_max integer check (rating_max between 0 and 4000),
  fee_kopecks bigint not null default 0 check (fee_kopecks between 0 and 100000000),
  prize_text text check (length(prize_text) <= 2000),
  -- Призовые по местам в копейках (1-е, 2-е, …), необязательно.
  prize_kopecks bigint[] check (prize_kopecks is null or (cardinality(prize_kopecks) between 1 and 16 and 0 <= all (prize_kopecks))),
  places smallint not null check (places between 2 and 128),
  group_count smallint check (group_count between 2 and 16),
  advance_per_group smallint check (advance_per_group between 1 and 4),
  -- Сколько минут держать стол на матч (удержание light).
  match_minutes smallint not null check (match_minutes between 10 and 600),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- До этого момента запись открыта и игрок может отменить её с возвратом взноса целиком.
  registration_closes_at timestamptz not null,
  status text not null check (status in ('draft', 'registration', 'closed', 'running', 'finished', 'canceled')),
  entries_count smallint not null default 0 check (entries_count >= 0),
  winner_entry_id uuid,
  published_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (club_id, id),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '14 days'),
  check (registration_closes_at <= starts_at),
  check (rating_min is null or rating_max is null or rating_min <= rating_max),
  check ((format = 'groups_playoff') = (group_count is not null and advance_per_group is not null)),
  check (format <> 'groups_playoff' or group_count * 2 <= places),
  check (status <> 'canceled' or canceled_at is not null),
  check (status not in ('running', 'finished') or started_at is not null)
);
create index tournaments_club_start_idx on bl.tournaments (club_id, starts_at desc);
create index tournaments_public_idx on bl.tournaments (starts_at) where status in ('registration', 'closed', 'running');
create index tournaments_running_idx on bl.tournaments (club_id) where status in ('registration', 'closed', 'running');

comment on table bl.tournaments is 'Турниры клуба (M4, №138). Не черновик — публичная информация без ПДн.';

-- Столы турнира -----------------------------------------------------------------------------

create table bl.tournament_resources (
  club_id uuid not null,
  tournament_id uuid not null,
  resource_id uuid not null,
  primary key (tournament_id, resource_id),
  foreign key (club_id, tournament_id) references bl.tournaments (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id)
);
create index tournament_resources_resource_idx on bl.tournament_resources (resource_id);

-- Записи игроков ------------------------------------------------------------------------------
-- pending_payment (ждёт взноса до pay_until) → confirmed; canceled — отменил игрок, не оплатил,
-- турнир отменён, не подтверждена к старту. refund_status — возврат взноса через money (outbox).

create table bl.tournament_entries (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null,
  tournament_id uuid not null,
  user_id uuid not null references bl.users (id),
  -- Снимок ника Бильярдум+ на момент записи: наружу (сайт, ТВ) участник виден только так.
  nick text check (length(nick) between 1 and 32),
  -- Рейтинг дисциплины при записи и при посеве (start).
  rating integer not null check (rating between 0 and 4000),
  seed smallint check (seed between 1 and 128),
  group_no smallint check (group_no between 0 and 15),
  status text not null check (status in ('pending_payment', 'confirmed', 'canceled')),
  fee_kopecks bigint not null check (fee_kopecks >= 0),
  payment_id uuid,
  paid_kopecks bigint not null default 0 check (paid_kopecks >= 0),
  pay_until timestamptz,
  refund_status text not null default 'none' check (refund_status in ('none', 'pending', 'done')),
  cancel_reason text check (cancel_reason in ('player', 'tournament_canceled', 'payment_timeout', 'not_confirmed', 'full')),
  created_at timestamptz not null,
  confirmed_at timestamptz,
  canceled_at timestamptz,
  updated_at timestamptz not null,
  unique (club_id, id),
  foreign key (club_id, tournament_id) references bl.tournaments (club_id, id),
  check (status <> 'confirmed' or confirmed_at is not null),
  check (status <> 'canceled' or (canceled_at is not null and cancel_reason is not null)),
  check (status <> 'pending_payment' or pay_until is not null)
);
-- Одна живая запись игрока на турнир; посев уникален.
create unique index tournament_entries_live_uidx on bl.tournament_entries (tournament_id, user_id) where status <> 'canceled';
create unique index tournament_entries_seed_uidx on bl.tournament_entries (tournament_id, seed) where seed is not null;
create index tournament_entries_tournament_idx on bl.tournament_entries (tournament_id, status);
create index tournament_entries_user_idx on bl.tournament_entries (user_id, created_at desc);

alter table bl.tournaments
  add constraint tournaments_winner_fk foreign key (club_id, winner_entry_id) references bl.tournament_entries (club_id, id);

-- Платежи взносов: payment.confirmed обрабатывается один раз по payment_id.
create table bl.tournament_payments (
  payment_id uuid primary key,
  club_id uuid not null,
  entry_id uuid not null,
  outcome text not null check (outcome in ('applied', 'refunded')),
  amount_kopecks bigint not null check (amount_kopecks >= 0),
  created_at timestamptz not null,
  foreign key (club_id, entry_id) references bl.tournament_entries (club_id, id)
);
create index tournament_payments_entry_idx on bl.tournament_payments (entry_id);

-- Матчи ---------------------------------------------------------------------------------------
-- waiting (соперники ещё не известны) → ready (оба известны, ждёт стола) → playing (стол удержан,
-- свет по команде турнира) → pending_confirm (один игрок внёс счёт) → done; disputed — счета
-- игроков расходятся, решает организатор. bye — проход без игры (status done, result_source bye).

create table bl.tournament_matches (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null,
  tournament_id uuid not null,
  stage text not null check (stage in ('group', 'playoff')),
  round smallint not null check (round between 1 and 64),
  position smallint not null check (position between 0 and 127),
  group_no smallint check (group_no between 0 and 15),
  entry_a uuid,
  entry_b uuid,
  -- Игроки денормализованы для личного контекста (свой матч — счёт и подтверждение).
  user_a uuid references bl.users (id),
  user_b uuid references bl.users (id),
  -- Источник слота плей-офф после групп: 'g{группа}p{место}'.
  src_a text check (src_a ~ '^g[0-9]{1,2}p[1-4]$'),
  src_b text check (src_b ~ '^g[0-9]{1,2}p[1-4]$'),
  bye boolean not null default false,
  next_match_id uuid,
  next_slot text check (next_slot in ('a', 'b')),
  status text not null check (status in ('waiting', 'ready', 'playing', 'pending_confirm', 'disputed', 'done')),
  resource_id uuid,
  scheduled_at timestamptz,
  hold_until timestamptz,
  session_id uuid,
  started_at timestamptz,
  -- Счёт игроков: {"score_a": n, "score_b": m, "at": "…"}.
  report_a jsonb check (report_a is null or jsonb_typeof(report_a) = 'object'),
  report_b jsonb check (report_b is null or jsonb_typeof(report_b) = 'object'),
  score_a smallint check (score_a between 0 and 25),
  score_b smallint check (score_b between 0 and 25),
  winner_entry_id uuid,
  result_source text check (result_source in ('players', 'organizer', 'bye')),
  -- Сколько раз результат менял организатор (событие match_finished с revision).
  revision smallint not null default 0 check (revision between 0 and 1000),
  finished_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (club_id, id),
  foreign key (club_id, tournament_id) references bl.tournaments (club_id, id),
  foreign key (club_id, entry_a) references bl.tournament_entries (club_id, id),
  foreign key (club_id, entry_b) references bl.tournament_entries (club_id, id),
  foreign key (club_id, winner_entry_id) references bl.tournament_entries (club_id, id),
  foreign key (club_id, next_match_id) references bl.tournament_matches (club_id, id),
  foreign key (club_id, resource_id) references bl.resources (club_id, id),
  check ((next_match_id is null) = (next_slot is null)),
  check ((stage = 'group') = (group_no is not null)),
  check (status <> 'done' or winner_entry_id is not null),
  check (status not in ('playing', 'pending_confirm', 'disputed') or (entry_a is not null and entry_b is not null and resource_id is not null)),
  check (entry_a is null or entry_b is null or entry_a <> entry_b)
);
create unique index tournament_matches_slot_uidx on bl.tournament_matches (tournament_id, stage, coalesce(group_no, -1), round, position);
create index tournament_matches_tournament_idx on bl.tournament_matches (tournament_id, status);
create index tournament_matches_resource_idx on bl.tournament_matches (resource_id) where status in ('playing', 'pending_confirm', 'disputed');
create index tournament_matches_user_a_idx on bl.tournament_matches (user_a) where user_a is not null;
create index tournament_matches_user_b_idx on bl.tournament_matches (user_b) where user_b is not null;

comment on table bl.tournament_matches is 'Матчи турнира: сетка, столы, счёт от игроков и исправления организатора (M4, №138).';

-- Владелец, RLS, права --------------------------------------------------------------------------

alter table bl.tournaments owner to bl_owner;
alter table bl.tournament_resources owner to bl_owner;
alter table bl.tournament_entries owner to bl_owner;
alter table bl.tournament_payments owner to bl_owner;
alter table bl.tournament_matches owner to bl_owner;

alter table bl.tournaments enable row level security;
alter table bl.tournaments force row level security;
alter table bl.tournament_resources enable row level security;
alter table bl.tournament_resources force row level security;
alter table bl.tournament_entries enable row level security;
alter table bl.tournament_entries force row level security;
alter table bl.tournament_payments enable row level security;
alter table bl.tournament_payments force row level security;
alter table bl.tournament_matches enable row level security;
alter table bl.tournament_matches force row level security;

create policy tournaments_app on bl.tournaments for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());
-- Опубликованный турнир — публичная афиша: виден без клуба в контексте (сайт, гость, планировщик).
-- В контексте клуба чужие турниры не видны (инвариант 5).
create policy tournaments_public on bl.tournaments for select to app_api
  using (bl.ctx_club_id() is null and status <> 'draft');

create policy tournament_resources_app on bl.tournament_resources for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

create policy tournament_entries_app on bl.tournament_entries for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());
create policy tournament_entries_self on bl.tournament_entries for select to app_api
  using (user_id = bl.ctx_user_id());

create policy tournament_payments_app on bl.tournament_payments for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());

create policy tournament_matches_app on bl.tournament_matches for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());
create policy tournament_matches_self on bl.tournament_matches for select to app_api
  using (user_a = bl.ctx_user_id() or user_b = bl.ctx_user_id());

revoke all on bl.tournaments, bl.tournament_resources, bl.tournament_entries, bl.tournament_payments, bl.tournament_matches from public;

grant select, insert on bl.tournaments to app_api;
grant update (title, description, discipline, format, race_to, rating_min, rating_max, fee_kopecks, prize_text, prize_kopecks,
              places, group_count, advance_per_group, match_minutes, starts_at, ends_at, registration_closes_at, status,
              entries_count, winner_entry_id, published_at, started_at, finished_at, canceled_at, updated_at)
  on bl.tournaments to app_api;
-- Столы турнира меняются до старта: строки удаляются и вставляются заново.
grant select, insert, delete on bl.tournament_resources to app_api;
grant select, insert on bl.tournament_entries to app_api;
grant update (nick, rating, seed, group_no, status, payment_id, paid_kopecks, pay_until, refund_status, cancel_reason,
              confirmed_at, canceled_at, updated_at)
  on bl.tournament_entries to app_api;
grant select, insert on bl.tournament_payments to app_api;
grant update (outcome) on bl.tournament_payments to app_api;
grant select, insert on bl.tournament_matches to app_api;
grant update (entry_a, entry_b, user_a, user_b, bye, status, resource_id, scheduled_at, hold_until, session_id, started_at,
              report_a, report_b, score_a, score_b, winner_entry_id, result_source, revision, finished_at, updated_at)
  on bl.tournament_matches to app_api;
