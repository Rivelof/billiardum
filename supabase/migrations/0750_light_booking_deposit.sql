-- 0750 (backend-light, M3): сессия по брони и по депозиту наличными (контракт M3 §1, §3).
--
-- booking_id — бронь, с которой начата сессия (startFromBooking): старт по брони идемпотентен,
-- одна бронь — не больше одной сессии. Внешний ключ на bl.bookings добавит модуль брони.
-- deposit_kopecks — депозит наличными для «Без лимита» (decisions №112): paid_until — по остатку
-- депозита по тарифу; сама сессия не продлевается; при закрытии money получает расчёт
-- (outbox session.closed с used_kopecks).

alter table bl.sessions
  add column booking_id uuid,
  add column deposit_kopecks bigint check (deposit_kopecks > 0),
  add constraint sessions_booking_key unique (booking_id),
  add constraint sessions_deposit_unlimited check (deposit_kopecks is null or unlimited);

comment on column bl.sessions.booking_id is 'Бронь, с которой начата сессия (M3): старт по брони один раз.';
comment on column bl.sessions.deposit_kopecks is 'Депозит наличными «Без лимита» (№112), копейки; NULL — не депозит.';

-- Порядок команд в очереди устройства: несколько команд одной транзакции получают одно время
-- (ctx.clock), и порядок по id был бы случайным (session.stop и затем state.reserved).
alter table bl.device_commands add column queue_no bigint generated always as identity;
