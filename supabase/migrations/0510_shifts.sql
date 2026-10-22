-- 0510 (backend-kkt): смены клуба (контракт docs/contracts/m2.md §1.6, §1.8, §1.10, §3, §5;
-- decisions №71, №81, №83).
--
-- * bl.shifts — смена: размен при открытии; при закрытии факт наличных, ожидаемые наличные
--   (размен + наличные платежи клуба за время смены − наличные возвраты) и расхождение.
--   Одна открытая смена на клуб (частичный уникальный индекс). Закрытая смена не меняется,
--   кроме снимка отчёта (report, report_sent_at).
-- * Выручку столов и бара отчёт делит по bl.payments.kind (start, extend — стол; bar — бар,
--   миграция 0410 backend-pos).

create table bl.shifts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  number integer not null check (number >= 1),
  opened_by uuid not null references bl.users (id),
  opened_at timestamptz not null,
  float_kopecks bigint not null check (float_kopecks between 0 and 100000000),
  closed_by uuid references bl.users (id),
  closed_at timestamptz,
  cash_sales_kopecks bigint check (cash_sales_kopecks >= 0),
  cash_refunds_kopecks bigint check (cash_refunds_kopecks >= 0),
  expected_cash_kopecks bigint,
  actual_cash_kopecks bigint check (actual_cash_kopecks between 0 and 1000000000),
  discrepancy_kopecks bigint,
  close_comment text check (length(close_comment) between 1 and 500),
  -- Снимок отчёта смены (server/reports/) и момент отправки владельцу.
  report jsonb check (report is null or jsonb_typeof(report) = 'object'),
  report_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (club_id, id),
  unique (club_id, number),
  check (closed_at is null or closed_at >= opened_at),
  check (
    (closed_at is null and closed_by is null and actual_cash_kopecks is null and expected_cash_kopecks is null
      and discrepancy_kopecks is null)
    or (closed_at is not null and closed_by is not null and actual_cash_kopecks is not null
      and expected_cash_kopecks is not null and discrepancy_kopecks = actual_cash_kopecks - expected_cash_kopecks)
  )
);
-- Одна открытая смена на клуб (№83).
create unique index shifts_one_open_uidx on bl.shifts (club_id) where closed_at is null;
create index shifts_club_opened_idx on bl.shifts (club_id, opened_at desc);

comment on table bl.shifts is 'Смены клуба: размен, ожидаемые и фактические наличные, расхождение (decisions №81, №83).';

-- Владелец, RLS, права -----------------------------------------------------------------------

alter table bl.shifts owner to bl_owner;

alter table bl.shifts enable row level security;
alter table bl.shifts force row level security;

create policy shifts_app on bl.shifts for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());

revoke all on bl.shifts from public;

grant select, insert on bl.shifts to app_api;
grant update (closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks, expected_cash_kopecks,
  actual_cash_kopecks, discrepancy_kopecks, close_comment, report, report_sent_at, updated_at) on bl.shifts to app_api;

-- Закрытая смена не открывается и не пересчитывается; размен и открытие не меняются никогда.
create function bl.shifts_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.opened_at is distinct from old.opened_at or new.opened_by is distinct from old.opened_by
     or new.float_kopecks is distinct from old.float_kopecks or new.number is distinct from old.number then
    raise exception 'bl.shifts: opening fields are immutable' using errcode = 'check_violation';
  end if;
  if old.closed_at is not null and (
       new.closed_at is distinct from old.closed_at or new.closed_by is distinct from old.closed_by
       or new.actual_cash_kopecks is distinct from old.actual_cash_kopecks
       or new.expected_cash_kopecks is distinct from old.expected_cash_kopecks
       or new.discrepancy_kopecks is distinct from old.discrepancy_kopecks
       or new.cash_sales_kopecks is distinct from old.cash_sales_kopecks
       or new.cash_refunds_kopecks is distinct from old.cash_refunds_kopecks
       or new.close_comment is distinct from old.close_comment) then
    raise exception 'bl.shifts: closed shift is immutable' using errcode = 'check_violation';
  end if;
  if old.report_sent_at is not null and new.report_sent_at is distinct from old.report_sent_at then
    raise exception 'bl.shifts: report_sent_at is set once' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function bl.shifts_guard() owner to bl_owner;
revoke all on function bl.shifts_guard() from public;

create trigger shifts_guard before update on bl.shifts
  for each row execute function bl.shifts_guard();
