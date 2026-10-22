-- 0707 (backend-core): пояс клуба — только имена IANA вида Область/Место или UTC.
--
-- bl.is_valid_timezone (0002) пропускал всё, что знает Postgres: сокращения (MSK), posix/…,
-- right/… — Intl в Node таких не знает, и расчёты по местному времени падали бы с RangeError.
-- Теперь: UTC или имя с областью из списка IANA, и его знает Postgres. Сервер при записи
-- пояса дополнительно сверяет со списком Intl.supportedValuesOf('timeZone')
-- (server/lib/timezone.mjs). Существующие строки не перепроверяются.

create or replace function bl.is_valid_timezone(tz text) returns boolean
language plpgsql immutable parallel safe
set search_path = pg_catalog, pg_temp
as $$
begin
  if tz is null or length(tz) > 64 then
    return false;
  end if;
  if tz <> 'UTC'
     and tz !~ '^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)/[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)?$' then
    return false;
  end if;
  perform pg_catalog.timezone(tz, timestamptz '2000-01-01 00:00:00+00');
  return true;
exception when others then
  return false;
end
$$;
comment on function bl.is_valid_timezone(text) is 'Пояс клуба: UTC или IANA Область/Место, известный Postgres (без сокращений и posix/…).';
