-- 0752 (backend-light, M3): на что ссылается удержание reserved (decisions №122): id записи
-- листа ожидания (source = waitlist) или брони (source = booking). Нужно плану зала для кнопки
-- «Снять удержание»; ПДн не хранит.

alter table bl.resource_holds add column ref_id uuid;

comment on column bl.resource_holds.ref_id is 'Запись листа ожидания или бронь, чьё это удержание reserved (M3, №122).';
