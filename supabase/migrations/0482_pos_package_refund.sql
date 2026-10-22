-- 0482 (backend-pos, M3): возврат пакета часов, проданного на кассе (decisions №118).
--
-- Пакет возвращается целиком и только пока партия минут не тронута: партию отзывает money
-- (revokeLotOnly), деньги и чек возврата — возврат продажи кассы (как у бара). Строка пакета
-- помечается один раз: refunded_at и pos_refund_id (возврат кассы bl.pos_refunds, мягкая ссылка).

alter table bl.pos_sale_packages
  add column refunded_at timestamptz,
  add column pos_refund_id uuid,
  add constraint pos_sale_packages_refund_check check ((refunded_at is null) = (pos_refund_id is null));

create or replace function bl.pos_sale_packages_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.lot_id is not null and new.lot_id is distinct from old.lot_id then
    raise exception 'bl.pos_sale_packages: lot_id is set once' using errcode = 'check_violation';
  end if;
  if old.refunded_at is not null and (new.refunded_at is distinct from old.refunded_at or new.pos_refund_id is distinct from old.pos_refund_id) then
    raise exception 'bl.pos_sale_packages: refund is final' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

grant update (refunded_at, pos_refund_id) on bl.pos_sale_packages to app_api;
