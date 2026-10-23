-- 1053 (backend-B, M5.1 №162): в проде bind и claim принимают только устройства из заводского реестра.
--
-- bl.device_factory_known(device_id) — есть ли устройство в bl.device_factory (без хеша и счётчиков).
-- Сервер при NODE_ENV=production отказывает в привязке и выдаче ключей устройству без записи
-- (403); в разработке и тестах устройства без реестра работают как раньше (сид, симулятор).

create function bl.device_factory_known(p_device_id uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$ select exists (select 1 from bl.device_factory where device_id = p_device_id) $$;
alter function bl.device_factory_known(uuid) owner to bl_definer;
revoke all on function bl.device_factory_known(uuid) from public;
grant execute on function bl.device_factory_known(uuid) to app_api;

comment on function bl.device_factory_known(uuid) is
  'SECURITY DEFINER: есть ли устройство в заводском реестре (M5.1 №162). Только bind и claim.';
