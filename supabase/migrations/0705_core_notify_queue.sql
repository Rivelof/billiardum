-- 0705 (backend-core, решение №130): очередь доставки уведомлений вне outbox.
--
-- Обработчик outbox notify.deliver только будит воркер; воркер захватывает уведомление
-- (status sending, claimed_at) и ходит в каналы вне транзакции outbox. Каждая попытка
-- отмечается в attempts до вызова канала (started) и после: после сбоя процесса захват старше
-- аренды продолжается с непройденных каналов, без повторной отправки туда, где попытка была.

alter table bl.notifications drop constraint notifications_status_check;
alter table bl.notifications
  add constraint notifications_status_check check (status in ('queued', 'sending', 'sent', 'failed', 'skipped'));
alter table bl.notifications add column claimed_at timestamptz;

create index notifications_queue_idx on bl.notifications (created_at) where status in ('queued', 'sending');

grant update (claimed_at) on bl.notifications to app_api;

comment on column bl.notifications.claimed_at is 'Воркер доставки взял уведомление (status sending); старше аренды — продолжить после сбоя.';
