-- Показатели для монитора прода (deploy/prod/monitor/monitor.sh), раз в минуту.
-- Только чтение и только агрегаты: ни телефонов, ни имён гостей, ни сумм отдельных платежей.
-- Строка вывода — «ключ|значение». Клубы в test и suspended не считаются (кроме очередей).
-- Выполняется под supabase_admin внутри контейнера базы: RLS по club_id (инвариант 5) не даёт
-- рабочей роли app_api посчитать по всем клубам. Отдельная роль bl_monitor с узкой функцией —
-- вопрос backend (RUNBOOK §9).

begin transaction read only;
set local statement_timeout = '10s';

-- Контроллеры столов в боевых клубах.
select 'devices_total|' || count(*)
  from bl.devices d join bl.clubs c on c.id = d.club_id
 where d.resource_id is not null and c.mode = 'live';
-- Без связи сейчас: state не приходил дольше 150 с (протокол §6).
select 'devices_offline_now|' || count(*)
  from bl.devices d join bl.clubs c on c.id = d.club_id
 where d.resource_id is not null and c.mode = 'live'
   and (d.last_seen_at is null or d.last_seen_at < now() - interval '150 seconds');
-- Без связи дольше 10 минут (тревога Андрею; владельцу клуб сообщает сам через 120 с, №16).
select 'devices_offline_10m|' || count(*)
  from bl.devices d join bl.clubs c on c.id = d.club_id
 where d.resource_id is not null and c.mode = 'live'
   and (d.last_seen_at is null or d.last_seen_at < now() - interval '10 minutes');
-- Клубы, где без связи все контроллеры дольше 10 минут (интернет или питание клуба).
select 'clubs_all_offline|' || count(*) from (
  select d.club_id
    from bl.devices d join bl.clubs c on c.id = d.club_id
   where d.resource_id is not null and c.mode = 'live'
   group by d.club_id
  having bool_and(d.last_seen_at is null or d.last_seen_at < now() - interval '10 minutes')
) t;

-- Outbox (оплата → свет, №48): события, которые пора обработать, но они ждут дольше минуты.
select 'outbox_due|' || count(*)
  from bl.outbox where processed_at is null and next_attempt_at <= now() - interval '1 minute';
select 'outbox_oldest_due_s|' || coalesce(max(extract(epoch from now() - created_at))::bigint, 0)
  from bl.outbox where processed_at is null and next_attempt_at <= now() - interval '1 minute';
-- Застрявшие на повторах (обработчик падает).
select 'outbox_retrying|' || count(*)
  from bl.outbox where processed_at is null and attempts >= 5;
-- Самое «горячее»: подтверждённая оплата, свет по которой ещё не обработан.
select 'outbox_payment_due|' || count(*)
  from bl.outbox where processed_at is null and topic like 'payment.%' and created_at < now() - interval '2 minutes';

-- Уведомления (очередь доставки, №130).
select 'notify_queued_10m|' || count(*)
  from bl.notifications where status = 'queued' and created_at < now() - interval '10 minutes';
select 'notify_failed_1h|' || count(*)
  from bl.notifications where status = 'failed' and created_at > now() - interval '1 hour';

-- Очередь чеков (54-ФЗ): не пробит больше 15 минут (владельцу тревога через 10, №84).
select 'receipts_stuck|' || count(*)
  from bl.receipts r join bl.clubs c on c.id = r.club_id
 where r.status in ('receipt_pending', 'pending') and r.created_at < now() - interval '15 minutes'
   and c.mode = 'live' and not r.is_test;
select 'receipts_failed_24h|' || count(*)
  from bl.receipts r join bl.clubs c on c.id = r.club_id
 where r.status = 'failed' and r.updated_at > now() - interval '24 hours' and c.mode = 'live' and not r.is_test;

-- ЮKassa: тревоги денег за последние 15 минут во всех клубах (владельцам они уже ушли).
select 'yookassa_alarms_15m|' || count(*)
  from bl.alarms a
 where a.last_raised_at > now() - interval '15 minutes'
   and a.type in ('yookassa_webhook_missing', 'payment_unapplied', 'payment_mismatch', 'payment_conflict',
                  'payment_not_found_at_provider', 'payment_paid_after_cancel', 'refund_mismatch',
                  'refund_canceled', 'settlement_receipt_failed');
-- Критичные тревоги клубов, открытые и не принятые дольше 30 минут (свет в обход, подпись).
select 'alarms_critical_open_30m|' || count(*)
  from bl.alarms a join bl.clubs c on c.id = a.club_id
 where a.state = 'open' and a.level = 'critical' and a.raised_at < now() - interval '30 minutes' and c.mode = 'live';

-- Мост ККТ на ПК ресепшена: у боевого клуба с мостом нет связи дольше 10 минут.
select 'kkt_bridges_offline|' || count(*)
  from bl.kkt_bridges b join bl.clubs c on c.id = b.club_id
 where b.revoked_at is null and c.mode = 'live'
   and (b.last_seen_at is null or b.last_seen_at < now() - interval '10 minutes');

-- Архив WAL (бэкапы, PRODUCT §20): последняя ошибка позже последнего успеха — архив стоит.
select 'wal_archive_failing|' || (coalesce(last_failed_time > coalesce(last_archived_time, 'epoch'), false))::int
  from pg_stat_archiver;
select 'wal_last_archived_s|' || coalesce(extract(epoch from now() - last_archived_time)::bigint, -1)
  from pg_stat_archiver;

commit;
