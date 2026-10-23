-- 0602 (backend-booking, M4 §1 п. 9, §3): бронь на двоих для «Сыграем?» (Бильярдум+).
--
-- participants — гости-участники брони кроме владельца (user_id): видят бронь у себя, могут
-- начать игру по ней у стола; платит, отменяет и получает возврат — владелец.

alter table bl.bookings
  add column participants uuid[] not null default '{}'
    check (cardinality(participants) <= 7 and array_position(participants, null) is null);

create index bookings_participants_idx on bl.bookings using gin (participants);

grant update (participants) on bl.bookings to app_api;

-- Участник видит бронь в любом клубе (GET /api/me/bookings), как владелец.
create policy bookings_participant on bl.bookings for select to app_api
  using (bl.ctx_user_id() = any (participants));
