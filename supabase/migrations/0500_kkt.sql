-- 0500 (backend-kkt): чеки ККТ клуба через мост (контракт docs/contracts/m2.md §1.2, §1.3, §1.9, §3, §5;
-- decisions №77, №78, №84).
--
-- * bl.receipts (money, 0200) дополняются полями задания ККТ: kkt_job (задание АТОЛ и состояние
--   отправки), fd, fp, fn, printed_at, error, next_attempt_at, alarmed_at, sale_id (продажа кассы M2).
--   Новый статус printed — чек пробит на ККТ клуба (ФД, ФП). Очередь — строки channel = 'kkt'
--   со статусом receipt_pending: и от кассы M2 (enqueueReceipt), и от заявок стола M1 (№84).
-- * bl.kkt_bridges — мосты ККТ клуба (ПК ресепшена): в базе только sha256 токена.
-- * bl.kkt_ops — служебные задания ККТ (открыть и закрыть смену ККТ вместе со сменой клуба).
-- * bl.kkt_due — SECURITY DEFINER: чеки ККТ всех клубов, не пробитые дольше порога (тревога
--   «Чек не пробит больше 10 минут»), только идентификаторы.
--
-- Все таблицы с club_id: ENABLE + FORCE ROW LEVEL SECURITY, политики только для app_api
-- по bl.ctx_club_id(). Владелец — bl_owner. DELETE и TRUNCATE нет; UPDATE — только изменяемых столбцов.

-- Чеки: статус printed и поля ККТ ---------------------------------------------------------------

alter table bl.receipts drop constraint receipts_status_check;
alter table bl.receipts add constraint receipts_status_check
  check (status in ('receipt_pending', 'pending', 'succeeded', 'canceled', 'failed', 'printed'));

alter table bl.receipts
  -- Задание ККТ: { v, type: sell|sellReturn, operator_name, payments: [{method, amount_kopecks}],
  -- uuid (UUID задания АТОЛ; первая попытка = id чека), attempt, state: queued|sent|retry|lost,
  -- task_created, bridge_id, sent_at, task (JSON-задание АТОЛ), last_error {code, category} }.
  add column kkt_job jsonb check (kkt_job is null or jsonb_typeof(kkt_job) = 'object'),
  add column fd bigint check (fd > 0),
  add column fp text check (fp ~ '^[0-9]{1,10}$'),
  add column fn text check (fn ~ '^[0-9]{16}$'),
  add column printed_at timestamptz,
  add column error text check (error ~ '^[a-z][a-z0-9_]{0,63}$'),
  add column next_attempt_at timestamptz,
  add column alarmed_at timestamptz,
  -- Продажа кассы M2 (server/orders, backend-pos); без внешнего ключа: таблица продаж — у pos.
  add column sale_id uuid;

-- Чек продажи кассы M2 может не иметь платежа в bl.payments на момент постановки (sale_id).
alter table bl.receipts drop constraint receipts_check;
alter table bl.receipts drop constraint receipts_check1;
alter table bl.receipts add constraint receipts_object_check
  check (num_nonnulls(payment_id, refund_id, sale_id) >= 1);
alter table bl.receipts add constraint receipts_refund_object_check
  check (kind = 'sale' or refund_id is not null or sale_id is not null);
alter table bl.receipts add constraint receipts_printed_check
  check (status <> 'printed' or (channel = 'kkt' and fd is not null and printed_at is not null));
alter table bl.receipts add constraint receipts_kkt_fields_check
  check (channel = 'kkt' or (kkt_job is null and fd is null and fp is null and fn is null and printed_at is null));

create index receipts_kkt_queue_idx on bl.receipts (club_id, created_at)
  where channel = 'kkt' and status = 'receipt_pending';
create unique index receipts_kkt_fd_uidx on bl.receipts (club_id, coalesce(fn, ''), fd) where fd is not null;
create index receipts_sale_idx on bl.receipts (club_id, sale_id) where sale_id is not null;

grant update (kkt_job, fd, fp, fn, printed_at, error, next_attempt_at, alarmed_at) on bl.receipts to app_api;

-- Пробитый чек не меняется: статус printed конечный, ФД, ФП, ФН и время пробития ставятся один раз.
create function bl.receipts_kkt_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status = 'printed' and new.status <> 'printed' then
    raise exception 'bl.receipts: printed receipt cannot change status' using errcode = 'check_violation';
  end if;
  if old.fd is not null and new.fd is distinct from old.fd then
    raise exception 'bl.receipts: fd is set once' using errcode = 'check_violation';
  end if;
  if old.fp is not null and new.fp is distinct from old.fp then
    raise exception 'bl.receipts: fp is set once' using errcode = 'check_violation';
  end if;
  if old.fn is not null and new.fn is distinct from old.fn then
    raise exception 'bl.receipts: fn is set once' using errcode = 'check_violation';
  end if;
  if old.printed_at is not null and new.printed_at is distinct from old.printed_at then
    raise exception 'bl.receipts: printed_at is set once' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function bl.receipts_kkt_guard() owner to bl_owner;
revoke all on function bl.receipts_kkt_guard() from public;

create trigger receipts_kkt_guard before update on bl.receipts
  for each row execute function bl.receipts_kkt_guard();

-- Мосты ККТ ----------------------------------------------------------------------------------
-- Токен моста (base64url: 16 байт club_id и 32 случайных байта) выдаётся владельцу один раз;
-- в базе — только sha256 (hex). Клуб берётся из токена, строка ищется в контексте клуба (RLS).

create table bl.kkt_bridges (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  name text not null check (length(name) between 1 and 100),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  kkt_model text check (length(kkt_model) <= 100),
  bridge_version text check (length(bridge_version) <= 40),
  last_seen_at timestamptz,
  -- Последнее состояние ККТ от моста: { online, reason, blocked, paper, shift_state, shift_number }.
  last_status jsonb check (last_status is null or jsonb_typeof(last_status) = 'object'),
  created_by uuid references bl.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references bl.users (id),
  unique (club_id, id)
);
create index kkt_bridges_club_idx on bl.kkt_bridges (club_id) where revoked_at is null;

comment on table bl.kkt_bridges is 'Мосты ККТ клуба (tools/kkt-bridge на ПК ресепшена): в базе только sha256 токена.';

-- Служебные задания ККТ ----------------------------------------------------------------------
-- open_shift и close_shift (смена ККТ вместе со сменой клуба, №81, №83). Очередь общая с чеками:
-- по времени постановки, одно задание клуба в работе.

create table bl.kkt_ops (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  shift_id uuid,
  kind text not null check (kind in ('open_shift', 'close_shift')),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed', 'skipped')),
  operator_name text check (length(operator_name) between 1 and 64),
  kkt_job jsonb check (kkt_job is null or jsonb_typeof(kkt_job) = 'object'),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  error text check (error ~ '^[a-z][a-z0-9_]{0,63}$'),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz,
  unique (club_id, id)
);
create index kkt_ops_pending_idx on bl.kkt_ops (club_id, created_at) where status = 'pending';

-- Владелец, RLS, права -----------------------------------------------------------------------

alter table bl.kkt_bridges owner to bl_owner;
alter table bl.kkt_ops owner to bl_owner;

alter table bl.kkt_bridges enable row level security;
alter table bl.kkt_bridges force row level security;
alter table bl.kkt_ops enable row level security;
alter table bl.kkt_ops force row level security;

create policy kkt_bridges_app on bl.kkt_bridges for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy kkt_ops_app on bl.kkt_ops for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());

revoke all on bl.kkt_bridges, bl.kkt_ops from public;

grant select, insert on bl.kkt_bridges to app_api;
grant update (kkt_model, bridge_version, last_seen_at, last_status, updated_at, revoked_at, revoked_by) on bl.kkt_bridges to app_api;

grant select, insert on bl.kkt_ops to app_api;
grant update (status, kkt_job, attempts, next_attempt_at, error, result, updated_at, done_at) on bl.kkt_ops to app_api;

-- Отозванный мост не возвращается: revoked_at ставится один раз.
create function bl.kkt_bridges_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'bl.kkt_bridges: revoked_at is set once' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function bl.kkt_bridges_guard() owner to bl_owner;
revoke all on function bl.kkt_bridges_guard() from public;

create trigger kkt_bridges_guard before update on bl.kkt_bridges
  for each row execute function bl.kkt_bridges_guard();

-- Узкая функция SECURITY DEFINER ---------------------------------------------------------------
-- Планировщик server/kkt/ раз в 30 с ищет чеки ККТ всех клубов, не пробитые дольше порога и ещё
-- без тревоги (PRODUCT §8: «Чек не пробит больше 10 минут»). Только идентификаторы.

grant select (id, club_id, channel, status, created_at, alarmed_at) on bl.receipts to bl_definer;
create policy receipts_definer on bl.receipts for select to bl_definer using (true);

create function bl.kkt_due(p_cutoff timestamptz, p_limit integer)
returns table (club_id uuid, receipt_id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select r.club_id, r.id
    from bl.receipts r
   where r.channel = 'kkt' and r.status = 'receipt_pending'
     and r.created_at <= p_cutoff and r.alarmed_at is null
   order by r.created_at
   limit p_limit
$$;

alter function bl.kkt_due(timestamptz, integer) owner to bl_definer;
revoke all on function bl.kkt_due(timestamptz, integer) from public;
grant execute on function bl.kkt_due(timestamptz, integer) to app_api;

comment on function bl.kkt_due(timestamptz, integer) is 'SECURITY DEFINER: чеки ККТ (club_id, receipt_id) в receipt_pending с created_at <= p_cutoff без тревоги.';
