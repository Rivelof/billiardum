-- 0440 (backend-pos, M2 волна B): подтверждение скидки PIN управляющего (decisions №95) и отмена
-- неоплаченной СБП-продажи с возвратом поздней оплаты (№98).
--
-- * pos_discount_approvals — одноразовое подтверждение скидки выше лимита: управляющий или
--   владелец ввёл PIN на терминале кассы; действует 5 минут, применяется к одной продаже с той же
--   скидкой (процент или сумма). Причина обязательна (инвариант 8).
-- * pos_refunds.kind += 'late' — автоматический возврат оплаты, пришедшей после отмены продажи.
-- * bl.pos_due — дополнительно продажи, отменённые на кассе, чей платёж всё же прошёл и ещё не
--   возвращён (refunded_kopecks = 0): планировщик возвращает деньги.

create table bl.pos_discount_approvals (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  approver_id uuid not null references bl.users (id),
  requested_by uuid not null references bl.users (id),
  reason_code text not null check (reason_code ~ '^[a-z][a-z0-9_]{0,31}$'),
  reason_text text not null check (length(reason_text) between 1 and 2000),
  percent smallint check (percent between 1 and 100),
  amount_kopecks bigint check (amount_kopecks between 1 and 100000000),
  expires_at timestamptz not null,
  used_at timestamptz,
  sale_id uuid,
  created_at timestamptz not null,
  unique (club_id, id),
  unique (sale_id),
  foreign key (club_id, sale_id) references bl.pos_sales (club_id, id),
  check (num_nonnulls(percent, amount_kopecks) = 1),
  check (expires_at > created_at),
  check ((used_at is null) = (sale_id is null))
);
create index pos_discount_approvals_club_idx on bl.pos_discount_approvals (club_id, created_at desc);

comment on table bl.pos_discount_approvals is 'Подтверждение скидки выше лимита PIN управляющего (№95): одноразовое, 5 минут.';

-- Использовано один раз: used_at и sale_id ставятся один раз.
create function bl.pos_discount_approvals_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.used_at is not null and (new.used_at is distinct from old.used_at or new.sale_id is distinct from old.sale_id) then
    raise exception 'bl.pos_discount_approvals: used once' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function bl.pos_discount_approvals_guard() owner to bl_owner;
revoke all on function bl.pos_discount_approvals_guard() from public;
create trigger pos_discount_approvals_guard before update on bl.pos_discount_approvals
  for each row execute function bl.pos_discount_approvals_guard();

alter table bl.pos_discount_approvals owner to bl_owner;
alter table bl.pos_discount_approvals enable row level security;
alter table bl.pos_discount_approvals force row level security;
create policy pos_discount_approvals_app on bl.pos_discount_approvals for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
revoke all on bl.pos_discount_approvals from public;
grant select, insert on bl.pos_discount_approvals to app_api;
grant update (used_at, sale_id) on bl.pos_discount_approvals to app_api;

-- Возврат поздней оплаты отменённой продажи.
alter table bl.pos_refunds drop constraint pos_refunds_kind_check;
alter table bl.pos_refunds add constraint pos_refunds_kind_check check (kind in ('staff', 'duplicate', 'late'));
-- Автоматические возвраты (двойная оплата, поздняя оплата) — без сотрудника.
alter table bl.pos_refunds drop constraint pos_refunds_check;
alter table bl.pos_refunds add constraint pos_refunds_staff_check check (kind <> 'staff' or created_by is not null);

grant select (refunded_kopecks, channel) on bl.pos_sales to bl_definer;

create or replace function bl.pos_due(p_limit integer)
returns table (club_id uuid, sale_id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select s.club_id, s.id
    from bl.pos_sales s join bl.payments p on p.id = s.payment_id
   where (s.status = 'pending' and p.status in ('succeeded', 'canceled'))
      or (s.status = 'canceled' and s.channel = 'pos' and p.status = 'succeeded' and s.refunded_kopecks = 0)
   order by s.created_at
   limit p_limit
$$;

comment on function bl.pos_due(integer) is
  'SECURITY DEFINER: продажи в pending с платежом в конечном статусе и отменённые продажи кассы с прошедшим невозвращённым платежом (club_id, sale_id).';
