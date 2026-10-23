-- 0902 (backend-tournaments, Д2 приёмки M4): отмена турнира закрывает его открытые матчи.
--
-- Матчи отменённого турнира (waiting, ready, playing, pending_confirm, disputed) получают статус
-- canceled: удержание стола матча (hold_until) больше не держит стол, свет гасится, удержание light
-- снимается. Без этого стол оставался заблокированным до hold_until матча (до 2 × match_minutes).
-- Сыгранные матчи (done) остаются как есть. Новых прав не нужно: status уже в grant update.

alter table bl.tournament_matches drop constraint tournament_matches_status_check;
alter table bl.tournament_matches add constraint tournament_matches_status_check
  check (status in ('waiting', 'ready', 'playing', 'pending_confirm', 'disputed', 'done', 'canceled'));

comment on column bl.tournament_matches.status is
  'waiting, ready (наружу scheduled), playing, pending_confirm, disputed, done; canceled — турнир отменён (Д2 M4).';
