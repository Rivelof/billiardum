-- 0657 (backend-money): независимое ревью денег, пп. 2, 3, 4, 6, 7, 8.
--
-- * refunds.kind: refund — деньги гостю; release — несписанная часть заморозки (деньги не
--   списывались, в лимит возвратов и в выручку смены не входит); late — автовозврат платежа,
--   оплаченного после отмены у нас (в выручку не входил); balance — минуты вернулись на баланс
--   (деньги не двигались). Отчёты смены (backend-kkt) считают только kind = 'refund'.
-- * refunds.checked_at — сверка зависших возвратов ЮKassa (money_due refund_stale).
-- * balance_debits: частичный возврат минут делит строку списания (minutes, value_kopecks).
-- * balance_lots.expires_at: минуты, вернувшиеся в уже истёкшую партию, живут ещё сутки.
-- * cash_refunds_pending — возврат наличных без открытой смены ждёт её открытия (п. 7).
-- * money_due: + зависшие возвраты, зависшие чеки зачёта ЮKassa, наличные возвраты к выдаче.

alter table bl.refunds
  add column kind text not null default 'refund' check (kind in ('refund', 'release', 'late', 'balance')),
  add column checked_at timestamptz;
grant update (checked_at) on bl.refunds to app_api;

grant update (minutes, value_kopecks) on bl.balance_debits to app_api;
grant update (expires_at) on bl.balance_lots to app_api;

create table bl.cash_refunds_pending (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  payment_id uuid not null,
  idempotence_key text not null check (length(idempotence_key) between 1 and 64),
  amount_kopecks bigint not null check (amount_kopecks > 0),
  reason text not null check (length(reason) between 1 and 2000),
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  requested_by uuid references bl.users (id),
  created_at timestamptz not null,
  checked_at timestamptz,
  done_at timestamptz,
  refund_id uuid,
  unique (club_id, id),
  unique (club_id, idempotence_key),
  foreign key (club_id, payment_id) references bl.payments (club_id, id),
  foreign key (club_id, refund_id) references bl.refunds (club_id, id),
  check ((done_at is null) = (refund_id is null))
);
create index cash_refunds_pending_due_idx on bl.cash_refunds_pending (created_at) where done_at is null;

comment on table bl.cash_refunds_pending is 'Возврат наличных, отложенный до открытия смены: выдаётся и попадает в отчёт следующей смены.';

alter table bl.cash_refunds_pending owner to bl_owner;
alter table bl.cash_refunds_pending enable row level security;
alter table bl.cash_refunds_pending force row level security;
create policy cash_refunds_pending_app on bl.cash_refunds_pending for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
revoke all on bl.cash_refunds_pending from public;
grant select, insert on bl.cash_refunds_pending to app_api;
grant update (checked_at, done_at, refund_id) on bl.cash_refunds_pending to app_api;

-- Узкая функция видит только то, что нужно планировщику.
grant select (id, club_id, status, provider_refund_id, created_at, checked_at) on bl.refunds to bl_definer;
create policy refunds_definer on bl.refunds for select to bl_definer using (true);
grant select (settles_payment_id, provider_receipt_id, updated_at) on bl.receipts to bl_definer;
grant select (id, club_id, created_at, checked_at, done_at) on bl.cash_refunds_pending to bl_definer;
create policy cash_refunds_pending_definer on bl.cash_refunds_pending for select to bl_definer using (true);

create or replace function bl.money_due(p_now timestamptz, p_limit integer)
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
  union all
  (select f.club_id, 'refund_stale'::text, f.id
     from bl.refunds f
    where f.status = 'pending' and f.provider_refund_id is not null
      and f.created_at <= p_now - interval '1 minute'
      and f.created_at > p_now - interval '7 days'
      and (f.checked_at is null or f.checked_at <= p_now - interval '1 minute')
    order by f.created_at
    limit p_limit)
  union all
  (select r.club_id, 'receipt_stale'::text, r.id
     from bl.receipts r
    where r.channel = 'yookassa' and r.status = 'pending'
      and r.settles_payment_id is not null and r.provider_receipt_id is not null
      and r.updated_at <= p_now - interval '1 minute'
      and r.created_at > p_now - interval '7 days'
    order by r.created_at
    limit p_limit)
  union all
  (select c.club_id, 'cash_refund_queued'::text, c.id
     from bl.cash_refunds_pending c
    where c.done_at is null
      and (c.checked_at is null or c.checked_at <= p_now - interval '1 minute')
    order by c.created_at
    limit p_limit)
$$;

comment on function bl.money_due(timestamptz, integer) is
  'SECURITY DEFINER: заявки ресепшена к сгоранию, платежи и возвраты ЮKassa к сверке, чеки зачёта к опросу, наличные возвраты к выдаче (club_id, kind, id).';
