-- 0654 (backend-money, M3 волна B): поиск гостя для экрана возврата пакета часов (№118).
--
-- bl.money_lot_guest(p_phone) — узкая функция SECURITY DEFINER, только поиск по ТОЧНОМУ телефону
-- (E.164, без частичного совпадения — это было бы перечисление гостей): id, имя и маска телефона
-- гостя, если у него есть партии пакета часов в клубе из контекста и запрос делает управляющий или
-- владелец этого клуба (app.user_id, активное членство). Иначе — пусто. Полный телефон не отдаёт.

grant select (name) on bl.users to bl_definer;
grant select (user_id) on bl.balance_lots to bl_definer;

create function bl.money_lot_guest(p_phone text)
returns table (user_id uuid, name text, phone_masked text)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select u.id, u.name, left(u.phone, 5) || '***' || right(u.phone, 4)
    from bl.users u
   where p_phone ~ '^\+[1-9][0-9]{7,14}$'
     and u.phone = p_phone
     and u.merged_into is null
     and exists (
           select 1 from bl.club_members m
            where m.club_id = nullif(pg_catalog.current_setting('app.club_id', true), '')::uuid and m.user_id = nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
              and m.active and m.role in ('manager', 'owner'))
     and exists (select 1 from bl.balance_lots l where l.user_id = u.id and l.club_id = nullif(pg_catalog.current_setting('app.club_id', true), '')::uuid)
   limit 1
$$;

alter function bl.money_lot_guest(text) owner to bl_definer;
revoke all on function bl.money_lot_guest(text) from public;
grant execute on function bl.money_lot_guest(text) to app_api;

comment on function bl.money_lot_guest(text) is
  'SECURITY DEFINER, только поиск: гость с партиями пакета часов в клубе из контекста по точному телефону (id, имя, маска) — управляющему и владельцу клуба; иначе пусто (№118).';
