-- 0703 (backend-core, M3): публичный список клубов (decisions №120).
--
-- GET /api/clubs без входа: id, название, город, адрес, часовой пояс и план зала (размеры) —
-- только активных клубов, без персональных данных. Анонимный запрос клубов под RLS не видит,
-- поэтому список даёт узкая функция bl.public_clubs(). Наполнение — только данными самих клубов.

alter table bl.clubs
  add column address text check (length(btrim(address)) between 1 and 300),
  add column active boolean not null default true;

comment on column bl.clubs.address is 'Адрес клуба для гостей (публичный список, №120).';
comment on column bl.clubs.active is 'Клуб работает и виден в публичном списке.';

grant select (name, city, address, active) on bl.clubs to bl_definer;

create function bl.public_clubs()
returns table (id uuid, name text, city text, address text, timezone text, plan jsonb)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select c.id, c.name, c.city, c.address, c.timezone,
         case when jsonb_typeof(c.settings->'plan') = 'object'
              then jsonb_build_object('width_cm', c.settings->'plan'->'width_cm', 'height_cm', c.settings->'plan'->'height_cm')
         end
    from bl.clubs c
   where c.active
   order by c.city, c.name, c.id
$$;
alter function bl.public_clubs() owner to bl_definer;
revoke all on function bl.public_clubs() from public;
grant execute on function bl.public_clubs() to app_api;
comment on function bl.public_clubs() is 'SECURITY DEFINER: публичные сведения активных клубов (№120), без персональных данных.';
