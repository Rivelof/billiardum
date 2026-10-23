-- 1001 (backend-A, M5.1 №153): тестовые записи клуба (is_test).
--
-- is_test ставит триггер базы при вставке — по режиму клуба в этот момент (test, или suspended
-- после test); присланное приложением значение не учитывается. После перехода клуба в live
-- старые записи остаются тестовыми. Изменить is_test нельзя никому из рабочих ролей.
-- Зависимые записи наследуют признак родителя (они про те же деньги или ту же игру):
--   refunds ← payments; receipts ← payments (или refunds); tournament_entries ← tournaments;
--   matches ← tournaments (турнирная партия) или sessions (партия в сессии).
-- Тестовые записи не входят в отчёт смены, утреннюю сводку, рейтинг, достижения, каталог и
-- публичные страницы (server/reports, server/summaries, server/plus, server/directory,
-- server/tournaments). Журнал (audit_log) пишется как обычно и признака не имеет.

alter table bl.sessions add column is_test boolean not null default false;
alter table bl.payments add column is_test boolean not null default false;
alter table bl.refunds add column is_test boolean not null default false;
alter table bl.receipts add column is_test boolean not null default false;
alter table bl.orders add column is_test boolean not null default false;
alter table bl.pos_sales add column is_test boolean not null default false;
alter table bl.shifts add column is_test boolean not null default false;
alter table bl.bookings add column is_test boolean not null default false;
alter table bl.matches add column is_test boolean not null default false;
alter table bl.tournaments add column is_test boolean not null default false;
alter table bl.tournament_entries add column is_test boolean not null default false;

-- Чек тестового режима на ККТ — нефискальный документ «ТЕСТ» (мост получает test: true):
-- printed без фискальных реквизитов; фискальных реквизитов у тестового чека не бывает.
alter table bl.receipts drop constraint receipts_printed_check;
alter table bl.receipts add constraint receipts_printed_check
  check (status <> 'printed' or (channel = 'kkt' and printed_at is not null and (fd is not null or is_test)));
alter table bl.receipts add constraint receipts_test_nonfiscal_check
  check (not is_test or (fd is null and fp is null and fn is null));

-- Узкая функция триггера видит только режим клуба и признак родителя.
grant select (is_test) on bl.payments, bl.refunds, bl.sessions, bl.tournaments to bl_definer;
grant select (id) on bl.tournaments to bl_definer;
create policy tournaments_definer on bl.tournaments for select to bl_definer using (true);

create function bl.set_is_test() returns trigger
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
alter function bl.set_is_test() owner to bl_definer;
revoke all on function bl.set_is_test() from public;
comment on function bl.set_is_test() is 'SECURITY DEFINER (триггер): is_test новой записи по режиму клуба или по родителю (№153).';

create function bl.is_test_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.is_test is distinct from old.is_test then
    raise exception 'bl.%: is_test is set once', tg_table_name using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function bl.is_test_guard() owner to bl_owner;
revoke all on function bl.is_test_guard() from public;

do $$
declare
  t text;
begin
  foreach t in array array['sessions', 'payments', 'refunds', 'receipts', 'orders', 'pos_sales', 'shifts', 'bookings',
                           'matches', 'tournaments', 'tournament_entries'] loop
    execute format('create trigger %I before insert on bl.%I for each row execute function bl.set_is_test()', t || '_is_test', t);
    execute format('create trigger %I before update of is_test on bl.%I for each row execute function bl.is_test_guard()', t || '_is_test_guard', t);
    execute format('comment on column bl.%I.is_test is %L', t, 'Запись тестового режима клуба (M5.1 №153): ставит триггер при вставке, не меняется.');
  end loop;
end
$$;
