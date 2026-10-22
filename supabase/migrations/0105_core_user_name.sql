-- 0105 (backend-core): имя пользователя для персонала (контракт M1 §14).
--
-- Показывается в GET /api/me, в списке персонала терминала ресепшена и в журнале
-- (actor_name — только у участников клуба). Гостям имя не нужно и не собирается:
-- пользователь задаёт его сам (PATCH /api/me), имя из мессенджера не копируется.

alter table bl.users
  add column name text check (name = btrim(name) and length(name) between 1 and 100 and name !~ '[[:cntrl:]]');

comment on column bl.users.name is 'Имя для персонала (журнал, терминал); задаёт сам пользователь. NULL — не задано.';

-- Своя строка (политика users_app_update_self, 0100): имя и канал уведомлений.
grant update (name) on bl.users to app_api;
