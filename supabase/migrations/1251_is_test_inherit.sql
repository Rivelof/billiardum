-- 1251 (backend, M5.6, находки pentester Н-1 и Н-2): is_test обратных и связанных записей — от
-- родителя, а не от режима клуба в момент вставки; лимит уведомлений о пороге обслуживания.
--
-- Н-1. Клуб в test → расход кассы управляющего (is_test = true) → клуб в live → сторно писалось
-- по режиму клуба (is_test = false, сумма −X): боевая прибыль росла без денег. Теперь триггер
-- bl.set_is_test берёт признак родителя (дополняет 1001 и 1003):
--   * cashbook_entries: сторно (reverses_id) — признак исходной записи; инкассация (shift_id) —
--     признак смены;
--   * pos_sales, orders: продажа и заказ с платежом (payment_id) — признак платежа.
-- Уже было: refunds ← payments; receipts ← payments или refunds (чек возврата, чек зачёта);
-- tournament_entries ← tournaments; matches ← tournaments или sessions; kkt_ops ← shifts.
-- Без родителя — как раньше, по режиму клуба. Платежи (payments) — всегда по режиму клуба: каждый
-- платёж — свои деньги (магазин клуба в момент оплаты), обратных платежей нет (возврат — refunds).
-- Отмены заказов и продаж, отмена возврата кассы (pos_refunds.canceled_at) — правка той же строки,
-- признак не меняется (is_test_guard). Склад, партии и списания минут признака is_test не имеют.
--
-- Н-2. bl.maintenance_alerts.notified — отправлено ли уведомление (лимит на клуб в сутки,
-- server/maintenance): отметка без уведомления (лимит исчерпан) — false.

grant select (id, club_id, is_test) on bl.cashbook_entries to bl_definer;
create policy cashbook_entries_definer on bl.cashbook_entries for select to bl_definer using (true);
grant select (id, is_test) on bl.payments to bl_definer;

create or replace function bl.set_is_test() returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_mode text;
  v_before text;
  v_parent boolean := null;
begin
  if tg_table_name = 'refunds' then
    select p.is_test into v_parent from bl.payments p where p.id = new.payment_id;
  elsif tg_table_name = 'receipts' then
    if new.payment_id is not null then
      select p.is_test into v_parent from bl.payments p where p.id = new.payment_id;
    elsif new.refund_id is not null then
      select f.is_test into v_parent from bl.refunds f where f.id = new.refund_id;
    end if;
  elsif tg_table_name = 'tournament_entries' then
    select t.is_test into v_parent from bl.tournaments t where t.id = new.tournament_id;
  elsif tg_table_name = 'matches' then
    if new.tournament_id is not null then
      select t.is_test into v_parent from bl.tournaments t where t.id = new.tournament_id;
    elsif new.session_id is not null then
      select s.is_test into v_parent from bl.sessions s where s.id = new.session_id;
    end if;
  elsif tg_table_name = 'kkt_ops' then
    if new.shift_id is not null then
      select s.is_test into v_parent from bl.shifts s where s.id = new.shift_id;
    end if;
  elsif tg_table_name = 'cashbook_entries' then
    if new.reverses_id is not null then
      select e.is_test into v_parent from bl.cashbook_entries e where e.id = new.reverses_id and e.club_id = new.club_id;
    elsif new.shift_id is not null then
      select s.is_test into v_parent from bl.shifts s where s.id = new.shift_id;
    end if;
  elsif tg_table_name = 'pos_sales' or tg_table_name = 'orders' then
    if new.payment_id is not null then
      select p.is_test into v_parent from bl.payments p where p.id = new.payment_id;
    end if;
  end if;
  if v_parent is not null then
    new.is_test := v_parent;
    return new;
  end if;
  select c.mode, c.mode_before_suspend into v_mode, v_before from bl.clubs c where c.id = new.club_id;
  new.is_test := coalesce(v_mode = 'test' or (v_mode = 'suspended' and v_before = 'test'), false);
  return new;
end
$$;
comment on function bl.set_is_test() is 'SECURITY DEFINER (триггер): is_test новой записи — по родителю (сторно, возврат, чек, продажа с платежом, инкассация, задание ККТ) или по режиму клуба (№153, 1251).';

-- Признак записи кассы ставится один раз (как у остальных таблиц с is_test).
create trigger cashbook_entries_is_test_guard before update of is_test on bl.cashbook_entries for each row execute function bl.is_test_guard();

alter table bl.maintenance_alerts add column notified boolean not null default true;
comment on column bl.maintenance_alerts.notified is 'Уведомление отправлено (false — лимит уведомлений клуба за сутки исчерпан, M5.6 Н-2).';
create index maintenance_alerts_club_created_idx on bl.maintenance_alerts (club_id, created_at);
