-- 0751 (backend-light, M3): источник удержания reserved (decisions №122).
--
-- reserved ставит бронь (booking) или предложение из листа ожидания (waitlist) на свои
-- 5 минут; ресепшн видит в плане зала, чьё удержание: «Предложен из очереди до HH:MM».

alter table bl.resource_holds
  add column source text check (source in ('booking', 'waitlist', 'staff')),
  add constraint resource_holds_reserved_source check (kind <> 'reserved' or source is not null) not valid;

comment on column bl.resource_holds.source is 'Чьё удержание reserved: booking, waitlist, staff (M3, №122).';
