-- 0651: оплата старта по брони (decisions №113, №116).
--
-- * Котировка и платёж kind 'booking_start': доплата при приходе (ранний приход, остаток при
--   частичной предоплате, бронь без предоплаты — №113: с прихода до конца брони). Подтверждение —
--   outbox payment.confirmed {kind: 'booking_start', quote_id, booking_id}: старт делает бронь.
-- * Попытки предоплаты брони: брошенная (не оплаченная) не мешает новой с другой суммой —
--   у брони может быть несколько платежей kind 'booking' (уникальность по брони снимается);
--   лишний оплаченный бронь возвращает (forfeitPrepayment с percent 0).

alter table bl.quotes drop constraint quotes_kind_check;
alter table bl.quotes add constraint quotes_kind_check check (kind in ('start', 'extend', 'booking_start'));
alter table bl.quotes add column booking_id uuid;
alter table bl.quotes add constraint quotes_booking_check check ((kind = 'booking_start') = (booking_id is not null));
alter table bl.quotes add constraint quotes_booking_start_shape_check check (
  kind <> 'booking_start' or (session_id is null and not unlimited and balance_minutes = 0)
);
alter table bl.quotes drop constraint quotes_check;
alter table bl.quotes add constraint quotes_session_check check (kind in ('start', 'booking_start') or session_id is not null);

alter table bl.payments drop constraint payments_kind_check;
alter table bl.payments add constraint payments_kind_check check (kind in ('start', 'extend', 'bar', 'booking', 'package', 'booking_start'));
alter table bl.payments drop constraint payments_booking_check;
alter table bl.payments add constraint payments_booking_check check ((kind in ('booking', 'booking_start')) = (booking_id is not null));

drop index bl.payments_booking_uidx;
create index payments_booking_idx on bl.payments (club_id, booking_id, created_at) where booking_id is not null;
