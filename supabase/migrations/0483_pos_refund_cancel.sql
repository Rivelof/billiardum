-- 0483 (backend-pos, M3): отмена возврата продажи кассы ЮKassa (независимое ревью денег, п. 4).
--
-- Money при отмене возврата ЮKassa (refund canceled) пишет outbox payment.refund_canceled
-- {refund_id, payment_id, amount_kopecks, pos_refund_id?}. Касса откатывает учёт возврата продажи:
-- refunded_kopecks продажи и строк, склад — обратным движением (writeoff с причиной), возврат кассы
-- помечается отменённым (canceled_at, cancel_reason — один раз), тревога владельцу. Пакеты часов в таком
-- возврате остаются отмеченными (партию минут money уже отозвал — восстановить её может только
-- владелец вручную, о чём говорит тревога).
--
-- Защита «возвращённое только растёт» (pos_sales_guard) пропускает уменьшение только в транзакции,
-- где обработчик отмены поставил локальную настройку bl.pos_refund_cancel = 'on'
-- (set_config(..., true) — до конца транзакции).

alter table bl.pos_refunds
  add column canceled_at timestamptz,
  add column cancel_reason text check (length(cancel_reason) between 1 and 500),
  add constraint pos_refunds_cancel_check check ((canceled_at is null) = (cancel_reason is null));

create function bl.pos_refunds_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.canceled_at is not null and (new.canceled_at is distinct from old.canceled_at or new.cancel_reason is distinct from old.cancel_reason) then
    raise exception 'bl.pos_refunds: cancel is final' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function bl.pos_refunds_guard() owner to bl_owner;
revoke all on function bl.pos_refunds_guard() from public;
create trigger pos_refunds_guard before update on bl.pos_refunds for each row execute function bl.pos_refunds_guard();

grant update (canceled_at, cancel_reason) on bl.pos_refunds to app_api;

create or replace function bl.pos_sales_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status in ('completed', 'canceled') and new.status <> old.status then
    raise exception 'bl.pos_sales: final status % cannot change', old.status using errcode = 'check_violation';
  end if;
  if old.completed_at is not null and new.completed_at is distinct from old.completed_at then
    raise exception 'bl.pos_sales: completed_at is set once' using errcode = 'check_violation';
  end if;
  if new.refunded_kopecks < old.refunded_kopecks and coalesce(pg_catalog.current_setting('bl.pos_refund_cancel', true), '') <> 'on' then
    raise exception 'bl.pos_sales: refunded_kopecks only grows' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
