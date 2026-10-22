-- 0300 (backend-light): код стола и узкие функции поиска ресурса.
--
-- Код стола (decisions №47): 10 символов Crockford Base32 (50 бит), не выводится
-- из номера стола. Алфавит 0-9 A-H J K M N P-T V-Z (без I, L, O, U). Источник случайности —
-- gen_random_uuid() (pg_strong_random): первый байт UUID v4 случаен целиком, младшие
-- 5 бит дают один символ. Код глобально уникален: по нему /api/t/{code} находит клуб
-- до того, как известен контекст запроса.

create function bl.gen_resource_code() returns text
language plpgsql volatile parallel safe
set search_path = pg_catalog, pg_temp
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  code text := '';
begin
  for i in 1..10 loop
    code := code || substr(alphabet, 1 + (get_byte(uuid_send(gen_random_uuid()), 0) & 31), 1);
  end loop;
  return code;
end
$$;
alter function bl.gen_resource_code() owner to bl_owner;
revoke all on function bl.gen_resource_code() from public;
grant execute on function bl.gen_resource_code() to app_api;

alter table bl.resources add column code text;
update bl.resources set code = bl.gen_resource_code() where code is null;
alter table bl.resources
  alter column code set default bl.gen_resource_code(),
  alter column code set not null,
  add constraint resources_code_format check (code ~ '^[0-9A-HJKMNP-TV-Z]{10}$'),
  add constraint resources_code_key unique (code);

comment on column bl.resources.code is 'Код стола для QR: 10 символов Crockford Base32 (decisions №47), глобально уникален.';

-- Узкие функции SECURITY DEFINER ----------------------------------------------------
-- bl_definer видит у resources только id, club_id, code, active.

grant select (id, club_id, code, active) on bl.resources to bl_definer;
create policy resources_definer on bl.resources for select to bl_definer using (true);

-- Ресурс и клуб по коду стола (только активные столы). Код сравнивается точно:
-- нормализацию Crockford (регистр, I/L → 1, O → 0) делает сервер.
create function bl.resource_by_code(p_code text)
returns table (resource_id uuid, club_id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select r.id, r.club_id from bl.resources r
   where r.code = p_code and r.active
$$;

-- Клуб ресурса по id: маршруты /api/resources/{id}/… узнают клуб до проверки ролей.
create function bl.resource_club(p_resource_id uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$ select r.club_id from bl.resources r where r.id = p_resource_id $$;

alter function bl.resource_by_code(text) owner to bl_definer;
alter function bl.resource_club(uuid) owner to bl_definer;
revoke all on function bl.resource_by_code(text), bl.resource_club(uuid) from public;
grant execute on function bl.resource_by_code(text), bl.resource_club(uuid) to app_api;

comment on function bl.resource_by_code(text) is 'SECURITY DEFINER: (resource_id, club_id) активного стола по коду или пусто. /api/t/{code}.';
comment on function bl.resource_club(uuid) is 'SECURITY DEFINER: club_id ресурса или NULL. Маршруты ресурсов до проверки ролей.';
