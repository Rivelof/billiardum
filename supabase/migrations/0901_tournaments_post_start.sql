-- 0901 (backend-tournaments, решения №147, №149): после старта турнира.
--
-- * №149: напоминание организатору — соперник не подтвердил счёт матча за 15 минут от первого
--   внесённого счёта. confirm_reminded_at — когда напомнили; одно напоминание на матч
--   (условный UPDATE … where confirm_reminded_at is null — без гонки планировщиков).
-- * Продление идущего турнира (POST …/extend, №147) и возврат взноса после старта (№149) новых
--   столбцов не требуют: ends_at, match_minutes и refund_status уже есть, причина — в журнале.

alter table bl.tournament_matches add column confirm_reminded_at timestamptz;

comment on column bl.tournament_matches.confirm_reminded_at is
  'Когда организатору ушло напоминание «соперник не подтвердил счёт» (№149); одно на матч.';

grant update (confirm_reminded_at) on bl.tournament_matches to app_api;
