-- 0108 (backend-core): ключ склейки открытых тревог — тип + стол + объект.
--
-- Тревоги по чекам и платежам стола не имеют: открытая receipt_unknown по одному чеку
-- глушила бы уведомление о другом чеке. dedupe_key — объект тревоги (receipt:<id>,
-- payment:<id> …); NULL — склейка по типу и столу, как раньше.

alter table bl.alarms add column dedupe_key text check (length(dedupe_key) between 1 and 200);

drop index bl.alarms_open_key;
create unique index alarms_open_key on bl.alarms (
  club_id, type,
  coalesce(resource_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(dedupe_key, '')
) where state = 'open';

comment on column bl.alarms.dedupe_key is 'Объект тревоги для склейки повторов (receipt:<id>, payment:<id> …); NULL — по типу и столу.';
