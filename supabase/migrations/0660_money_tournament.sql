-- 0660 (backend-money, M4, контракт m4.md, решение №138): взнос за участие в турнире.
--
-- Платёж ЮKassa kind tournament: чек «полный расчёт», предмет — услуга (участие в турнире).
-- tournament_id и entry_id — запись игрока (bl.tournament_entries, backend-tournaments): ссылки
-- без внешнего ключа (таблицы турниров в 09xx, применяются позже). На запись — несколько попыток
-- оплаты (брошенная, повторная), оплаченная — одна; возврат — по каждой оплаченной попытке.
-- receipts.customer_email — контакт для чека, когда гость указал почту, а не телефон (чек возврата).

alter table bl.payments drop constraint payments_kind_check;
alter table bl.payments add constraint payments_kind_check
  check (kind in ('start', 'extend', 'bar', 'booking', 'package', 'booking_start', 'tournament'));
alter table bl.payments
  add column tournament_id uuid,
  add column entry_id uuid,
  add constraint payments_tournament_check
    check ((kind = 'tournament') = (tournament_id is not null and entry_id is not null)),
  add constraint payments_tournament_shape_check
    check (kind <> 'tournament' or (resource_id is null and provider = 'yookassa' and capture));
-- Взнос — без стола; гость не обязателен (запись могла прийти без учётки — контакт в чеке).
alter table bl.payments drop constraint payments_table_refs_check;
alter table bl.payments add constraint payments_table_refs_check check (
  kind in ('bar', 'tournament')
  or (kind = 'package' and user_id is not null)
  or (resource_id is not null and user_id is not null)
);
create index payments_entry_idx on bl.payments (club_id, entry_id) where entry_id is not null;
create index payments_tournament_idx on bl.payments (club_id, tournament_id) where tournament_id is not null;

alter table bl.receipts add column customer_email text check (length(customer_email) between 3 and 254);
grant update (customer_email) on bl.receipts to app_api;
