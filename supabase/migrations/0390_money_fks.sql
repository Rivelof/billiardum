-- 0390 (backend-light): внешние ключи между таблицами money (0200) и light (0310, 0320).
--
-- Порядок миграций M1: core 0100 → money 0200 → light 0300; таблицы money ссылаются на
-- сессии, которых при 0200 ещё нет, а light — на платежи. Связи по (club_id, id): строка
-- не сошлётся на сессию или платёж другого клуба (как resources/devices в M0).

-- money → light: сессия котировки, платежа и заявки ресепшена.
alter table bl.quotes
  add constraint quotes_session_fk foreign key (club_id, session_id) references bl.sessions (club_id, id);
alter table bl.payments
  add constraint payments_session_fk foreign key (club_id, session_id) references bl.sessions (club_id, id);
alter table bl.reception_requests
  add constraint reception_requests_session_fk foreign key (club_id, session_id) references bl.sessions (club_id, id);

-- light → money: платёж и котировка сессии, платёж-причина команды контроллеру.
alter table bl.session_payments
  add constraint session_payments_payment_fk foreign key (club_id, payment_id) references bl.payments (club_id, id),
  add constraint session_payments_quote_fk foreign key (club_id, quote_id) references bl.quotes (club_id, id);
alter table bl.device_commands
  add constraint device_commands_payment_fk foreign key (club_id, payment_id) references bl.payments (club_id, id);

create index quotes_session_idx on bl.quotes (session_id) where session_id is not null;
create index payments_session_idx on bl.payments (session_id) where session_id is not null;
create index reception_requests_session_idx on bl.reception_requests (session_id) where session_id is not null;
