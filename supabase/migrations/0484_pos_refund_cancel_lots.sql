-- 0484 (backend-pos, M3): отмена возврата ЮKassa с восстановлением пакета (ревью денег п. 4, доработка).
--
-- payment.refund_canceled несёт lots_restored: [lot_id] — money сам восстановил отозванную партию
-- (с кассы — по pos_sale_packages.pos_refund_id). Касса снимает отметку возврата с этих строк пакетов
-- (refunded_at, pos_refund_id → NULL): пакет снова действует и его можно вернуть ещё раз. Снять
-- отметку можно только целиком и только в транзакции обработчика (bl.pos_refund_cancel = 'on').

create or replace function bl.pos_sale_packages_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.lot_id is not null and new.lot_id is distinct from old.lot_id then
    raise exception 'bl.pos_sale_packages: lot_id is set once' using errcode = 'check_violation';
  end if;
  if old.refunded_at is not null and (new.refunded_at is distinct from old.refunded_at or new.pos_refund_id is distinct from old.pos_refund_id)
     and not (new.refunded_at is null and new.pos_refund_id is null
              and coalesce(pg_catalog.current_setting('bl.pos_refund_cancel', true), '') = 'on') then
    raise exception 'bl.pos_sale_packages: refund is final' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
