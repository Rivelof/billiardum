-- 0601 (backend-booking, M3): правки по ревью брони и листа ожидания (решения №128, №122).
--
-- * bookings.expire_reason += 'table_unavailable': стол в окне удержания был недоступен гостю —
--   бронь закрывается без удержания предоплаты (№128).
-- * booking_due: принятые предложения очереди, у которых кончилось удержание стола без игры
--   (accepted, hold_until <= now), и столы, где в очереди кто-то ждёт, а предложения нет
--   (waitlist_resource: id — стол) — очередь не «засыпает» после принятия без оплаты. Если ресепшн
--   только что (10 минут) снял удержание предложения, стол сам не предлагается — его отдают гостю у стойки.

alter table bl.bookings drop constraint bookings_expire_reason_check;
alter table bl.bookings add constraint bookings_expire_reason_check
  check (expire_reason in ('unpaid', 'no_show', 'table_unavailable'));

grant select (resource_id, hold_until, close_reason, updated_at) on bl.waitlist to bl_definer;

create or replace function bl.booking_due(p_now timestamptz, p_lead interval, p_stale interval, p_limit integer)
returns table (kind text, id uuid, club_id uuid)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  (select 'booking'::text, b.id, b.club_id from bl.bookings b
    where (b.status = 'pending_payment' and b.pay_until <= p_now)
       or (b.status in ('confirmed', 'reserved') and b.starts_at - p_lead <= p_now)
       or (b.status = 'started' and b.ends_at <= p_now)
    order by b.starts_at
    limit greatest(least(p_limit, 1000), 1))
  union all
  (select 'waitlist'::text, w.id, w.club_id from bl.waitlist w
    where (w.status = 'offered' and w.offer_until <= p_now)
       or (w.status = 'waiting' and w.created_at <= p_now - p_stale)
       or (w.status = 'accepted' and w.hold_until <= p_now)
    order by w.created_at
    limit greatest(least(p_limit, 1000), 1))
  union all
  (select distinct on (w.resource_id) 'waitlist_resource'::text, w.resource_id, w.club_id from bl.waitlist w
    where w.status = 'waiting'
      and not exists (
        select 1 from bl.waitlist o
         where o.resource_id = w.resource_id
           and ((o.status = 'offered' and o.offer_until > p_now) or (o.status = 'accepted' and o.hold_until > p_now)
                or (o.close_reason = 'released' and o.updated_at > p_now - interval '10 minutes')))
    order by w.resource_id
    limit greatest(least(p_limit, 1000), 1))
$$;

comment on function bl.booking_due(timestamptz, interval, interval, integer) is
  'SECURITY DEFINER: (kind, id, club_id) броней, записей очереди и столов с очередью без предложения, по которым планировщику пора действовать. Только планировщик.';
