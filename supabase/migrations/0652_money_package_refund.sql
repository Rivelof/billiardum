-- 0652: возврат пакета часов (decisions №118) — только целиком и пока партия не тронута.
-- Отозванная партия: minutes_left = 0, revoked_at и revoked_by; минуты больше недоступны.
-- bl.money_object_club знает партию (lot): маршрут возврата приходит без клуба в контексте.

alter table bl.balance_lots
  add column revoked_at timestamptz,
  add column revoked_by uuid references bl.users (id),
  add constraint balance_lots_revoked_check check (revoked_at is null or minutes_left = 0);
grant update (revoked_at, revoked_by) on bl.balance_lots to app_api;

grant select (id, club_id) on bl.balance_lots to bl_definer;
create policy balance_lots_definer on bl.balance_lots for select to bl_definer using (true);

create or replace function bl.money_object_club(p_kind text, p_id uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select case p_kind
    when 'quote' then (select q.club_id from bl.quotes q where q.id = p_id)
    when 'payment' then (select p.club_id from bl.payments p where p.id = p_id)
    when 'reception_request' then (select rr.club_id from bl.reception_requests rr where rr.id = p_id)
    when 'package' then (select tp.club_id from bl.tariff_packages tp where tp.id = p_id and tp.active)
    when 'lot' then (select l.club_id from bl.balance_lots l where l.id = p_id)
  end
$$;
comment on function bl.money_object_club(text, uuid) is 'SECURITY DEFINER: club_id котировки, платежа, заявки ресепшена, активного пакета или партии минут по UUID (или NULL).';
