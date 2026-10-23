-- 1051 (backend-B, M5.1 №159): заводской реестр контроллеров.
--
-- scripts/provision-factory.mjs (суперпользователь, DATABASE_ADMIN_URL) создаёт device_id
-- и код привязки, печатает наклейку на корпус с QR «BLD1:{device_id}:{claim_code}» и
-- команду консоли «factory …» для прошивки, а в базу пишет только
-- hex(sha256(utf8(device_id || ':' || claim_code))) — тот же хеш, что у окна привязки (№67).
--
-- Привязка (POST /api/clubs/{club}/devices/bind): если устройство есть в реестре, код
-- с наклейки сверяется с хешем ДО открытия окна. Пять неверных кодов подряд закрывают
-- привязку этого устройства на 30 минут (как окно claim, №67). Устройства без записи
-- в реестре (сид разработки, контроллеры до M5.1) привязываются по-прежнему: код проверит
-- сам контроллер при claim.
--
-- Таблица платформенная (без club_id): app_api её не видит и не меняет. Проверка — только
-- узкой функцией bl.device_factory_check (SECURITY DEFINER, владелец bl_definer).

create table bl.device_factory (
  device_id uuid primary key,
  claim_code_hash text not null check (claim_code_hash ~ '^[0-9a-f]{64}$'),
  batch text check (batch ~ '^[A-Za-z0-9._-]{1,64}$'),
  created_at timestamptz not null default now(),
  bind_failed integer not null default 0 check (bind_failed between 0 and 100),
  bind_locked_until timestamptz
);

alter table bl.device_factory owner to bl_owner;
alter table bl.device_factory enable row level security;
alter table bl.device_factory force row level security;
revoke all on bl.device_factory from public;

-- bl_definer видит хеш и счётчик и меняет только счётчик и блокировку.
grant select (device_id, claim_code_hash, bind_failed, bind_locked_until) on bl.device_factory to bl_definer;
grant update (bind_failed, bind_locked_until) on bl.device_factory to bl_definer;
create policy device_factory_definer_select on bl.device_factory for select to bl_definer using (true);
create policy device_factory_definer_update on bl.device_factory for update to bl_definer using (true) with check (true);

-- Проверка кода привязки по реестру. Возвращает:
--   'unknown' — устройства нет в реестре;
--   'locked'  — привязка закрыта после 5 неверных кодов (до bind_locked_until);
--   'ok'      — код верный (счётчик сброшен);
--   'bad'     — код неверный (счётчик +1; пятая ошибка закрывает привязку на 30 минут).
-- Вызывающий фиксирует транзакцию и при 'bad' (ответ 403 без отката), чтобы счётчик не терялся.
create function bl.device_factory_check(p_device_id uuid, p_hash text, p_now timestamptz)
returns text
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  r record;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or p_now is null then
    return 'bad';
  end if;
  select device_id, claim_code_hash, bind_failed, bind_locked_until into r
    from bl.device_factory where device_id = p_device_id for update;
  if not found then
    return 'unknown';
  end if;
  if r.bind_locked_until is not null and r.bind_locked_until > p_now then
    return 'locked';
  end if;
  if r.claim_code_hash = p_hash then
    update bl.device_factory set bind_failed = 0, bind_locked_until = null where device_id = p_device_id;
    return 'ok';
  end if;
  if r.bind_failed + 1 >= 5 then
    update bl.device_factory set bind_failed = 0, bind_locked_until = p_now + interval '30 minutes'
     where device_id = p_device_id;
  else
    update bl.device_factory set bind_failed = r.bind_failed + 1 where device_id = p_device_id;
  end if;
  return 'bad';
end
$$;
alter function bl.device_factory_check(uuid, text, timestamptz) owner to bl_definer;
revoke all on function bl.device_factory_check(uuid, text, timestamptz) from public;
grant execute on function bl.device_factory_check(uuid, text, timestamptz) to app_api;

comment on table bl.device_factory is 'Заводской реестр контроллеров (M5.1 №159): только хеш кода привязки.';
comment on function bl.device_factory_check(uuid, text, timestamptz) is
  'SECURITY DEFINER: сверка кода с наклейки по реестру, 5 неверных — привязка закрыта на 30 минут. Только bind.';
