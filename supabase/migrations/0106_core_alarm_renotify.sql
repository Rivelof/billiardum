-- 0106 (backend-core): повторное уведомление о критичной тревоге (decisions №75).
--
-- Повтор открытой критичной тревоги того же типа по тому же столу снова уведомляет
-- владельца, если с прошлого уведомления прошло не меньше 10 минут; иначе только счётчик.

alter table bl.alarms add column last_notified_at timestamptz;
update bl.alarms set last_notified_at = raised_at where last_notified_at is null;

comment on column bl.alarms.last_notified_at is 'Когда персоналу последний раз ушло уведомление об этой тревоге (№75).';

grant update (last_notified_at) on bl.alarms to app_api;
