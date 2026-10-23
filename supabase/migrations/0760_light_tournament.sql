-- 0760 (backend-light, M4, decisions №138): столы турнира.
--
-- * Удержание reserved с source = 'tournament' и ref_id = id матча: стол на время матча не
--   принимает старт по QR, депозит и брони; сервис ресепшена с причиной допустим.
-- * Игра матча — сессия source = 'tournament' без платежа и без плательщика (startFromTournament):
--   действие турнира, не ручное действие персонала; команда сервера с журналом (инвариант 1).
--   match_id — идемпотентность старта и остановка по матчу.

alter table bl.resource_holds drop constraint if exists resource_holds_source_check;
alter table bl.resource_holds
  add constraint resource_holds_source_check check (source in ('booking', 'waitlist', 'staff', 'tournament'));
comment on column bl.resource_holds.source is 'Чьё удержание reserved: booking, waitlist, staff (M3, №122), tournament (M4, №138).';

alter table bl.sessions drop constraint if exists sessions_source_check;
alter table bl.sessions
  add constraint sessions_source_check check (source in ('qr', 'booking', 'reception', 'staff', 'tournament'));

alter table bl.sessions add column match_id uuid;
create unique index sessions_match_key on bl.sessions (match_id) where match_id is not null;
comment on column bl.sessions.match_id is 'Матч турнира, для которого включён свет (M4, №138).';

-- Плательщика нет только у игры турнира.
alter table bl.sessions alter column payer_user_id drop not null;
alter table bl.sessions
  add constraint sessions_payer_check check (payer_user_id is not null or source = 'tournament'),
  add constraint sessions_match_check check ((source = 'tournament') = (match_id is not null));
