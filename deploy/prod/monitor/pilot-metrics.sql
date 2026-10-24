-- Метрики пилота (PRODUCT §21) за последние 7 дней по каждому боевому клубу — для еженедельного
-- отчёта Андрею (deploy/prod/monitor/pilot-report.sh). Только чтение и только агрегаты.
-- Формулы — как в дашборде владельца (server/dashboard/day.mjs, M5.2): там же метрики по дням.
-- Если формулы дашборда поменяются, этот файл сверяется с ними (RUNBOOK §6.3).
-- Вывод — строка на клуб: поля через «|».

begin transaction read only;
set local statement_timeout = '60s';

with period as (
  select now() - interval '7 days' as since, now() as till
), clubs as (
  select c.id, c.name from bl.clubs c where c.mode = 'live'
), games as (
  select s.club_id,
         count(*) as total,
         count(*) filter (where s.source in ('qr', 'booking')) as no_staff
    from bl.sessions s, period p
   where s.started_at >= p.since and s.started_at < p.till and s.status <> 'cancelled' and not s.is_test
   group by s.club_id
), light_cmds as (
  -- Свет без журнала: команда включения ушла (sent/acked), а записи device.cmd с её id нет.
  select c.club_id, count(*) as n
    from bl.device_commands c, period p
   where c.type in ('session.start', 'session.resume', 'session.extend', 'service.start')
     and c.status in ('sent', 'acked') and c.created_at >= p.since and c.created_at < p.till
     and not exists (select 1 from bl.audit_log a
                      where a.club_id = c.club_id and a.action = 'device.cmd'
                        and a.created_at >= p.since - interval '1 day' and a.data->>'cmd_id' = c.id::text)
   group by c.club_id
), light_sessions as (
  -- Игра без записи session.start в журнале.
  select s.club_id, count(*) as n
    from bl.sessions s, period p
   where s.started_at >= p.since and s.started_at < p.till and s.status <> 'cancelled' and not s.is_test
     and not exists (select 1 from bl.audit_log a where a.club_id = s.club_id and a.action = 'session.start' and a.object_id = s.id)
   group by s.club_id
), cash as (
  select sh.club_id,
         count(*) filter (where sh.discrepancy_kopecks <> 0) as shifts_off,
         count(*) filter (where sh.discrepancy_kopecks <> 0 and sh.close_comment is null) as shifts_off_unexplained,
         coalesce(sum(abs(sh.discrepancy_kopecks)), 0) as off_kopecks,
         count(*) as shifts
    from bl.shifts sh, period p
   where sh.closed_at >= p.since and sh.closed_at < p.till and not sh.is_test
   group by sh.club_id
), scan as (
  -- Скан → свет: котировка гостя по QR → ack контроллера на session.start; игры по QR с ЮKassa.
  select s.club_id,
         percentile_cont(0.5) within group (order by greatest(0, extract(epoch from (c.acked_at - q.created_at)))) as median_s,
         count(*) as n
    from bl.sessions s
    join bl.payments pay on pay.session_id = s.id and pay.kind = 'start' and pay.provider = 'yookassa'
    join bl.quotes q on q.id = pay.quote_id
    join lateral (select min(dc.acked_at) as acked_at from bl.device_commands dc
                   where dc.session_id = s.id and dc.type = 'session.start' and dc.status = 'acked') c on c.acked_at is not null,
         period p
   where s.source = 'qr' and s.started_at >= p.since and s.started_at < p.till and not s.is_test
   group by s.club_id
), ext as (
  select pay.club_id,
         count(*) as paid,
         count(*) filter (where pay.provider in ('yookassa', 'balance')) as from_app
    from bl.payments pay, period p
   where pay.kind = 'extend' and pay.status = 'succeeded' and pay.confirmed_at >= p.since and pay.confirmed_at < p.till and not pay.is_test
   group by pay.club_id
), ext_free as (
  select a.club_id, count(*) as n
    from bl.audit_log a, period p
   where a.action = 'manual.extend_free' and a.created_at >= p.since and a.created_at < p.till
   group by a.club_id
)
select concat_ws('|',
         c.name,
         coalesce(g.total, 0), coalesce(g.no_staff, 0),
         coalesce(lc.n, 0), coalesce(ls.n, 0),
         coalesce(ca.shifts, 0), coalesce(ca.shifts_off, 0), coalesce(ca.shifts_off_unexplained, 0), coalesce(ca.off_kopecks, 0),
         coalesce(round(sc.median_s)::bigint, -1), coalesce(sc.n, 0),
         coalesce(e.paid, 0) + coalesce(ef.n, 0), coalesce(e.from_app, 0))
  from clubs c
  left join games g on g.club_id = c.id
  left join light_cmds lc on lc.club_id = c.id
  left join light_sessions ls on ls.club_id = c.id
  left join cash ca on ca.club_id = c.id
  left join scan sc on sc.club_id = c.id
  left join ext e on e.club_id = c.id
  left join ext_free ef on ef.club_id = c.id
 order by c.name;

commit;
