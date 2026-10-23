-- 1003 (backend-A, M5.1 №153, решение оркестратора по вопросу 1): смена ККТ в тестовом режиме клуба.
--
-- В тестовом режиме ККТ не печатает фискальных документов: смена ККТ не открывается (задание
-- open_shift не создаётся), отчёт о закрытии смены — нефискальный «ТЕСТ». Признак задания —
-- kkt_ops.is_test: ставит тот же триггер bl.set_is_test при вставке — по смене клуба
-- (shifts.is_test), а без смены — по режиму клуба; изменить нельзя.

alter table bl.kkt_ops add column is_test boolean not null default false;
comment on column bl.kkt_ops.is_test is 'Задание смены ККТ тестового режима клуба (M5.1 №153): только нефискальный «ТЕСТ».';

grant select (id, is_test) on bl.shifts to bl_definer;
create policy shifts_definer on bl.shifts for select to bl_definer using (true);

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

create trigger kkt_ops_is_test before insert on bl.kkt_ops for each row execute function bl.set_is_test();
create trigger kkt_ops_is_test_guard before update of is_test on bl.kkt_ops for each row execute function bl.is_test_guard();
