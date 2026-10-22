-- 0700 (backend-core, M3): цепочка уведомлений (контракт M3 §1 п. 7, decisions №110).
--
-- users.channels_order — порядок каналов, выбранный гостем (PATCH /api/me); пусто —
-- основной канал notify_channel, затем max → telegram → webpush. notifications.actions —
-- действия в уведомлении («Продлить», «Принять предложение»): [{id, title, url}].

alter table bl.users
  add column channels_order text[] check (
    channels_order is null
    or (cardinality(channels_order) between 1 and 3
        and channels_order <@ array['max', 'telegram', 'webpush']
        and array_position(channels_order, null) is null)
  );
grant update (channels_order) on bl.users to app_api;
grant select (channels_order) on bl.users to bl_definer;

alter table bl.notifications
  add column actions jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) <= 5);

-- Маршрут доставки теперь с порядком каналов (тип результата меняется — пересоздание).
drop function bl.notify_route(uuid);
create function bl.notify_route(p_user_id uuid)
returns table (user_id uuid, notify_channel text, channels_order text[], telegram_user_id bigint, max_user_id text)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select u.id, u.notify_channel, u.channels_order, u.telegram_user_id, u.max_user_id
    from bl.users u
   where u.id = p_user_id and u.merged_into is null
$$;
alter function bl.notify_route(uuid) owner to bl_definer;
revoke all on function bl.notify_route(uuid) from public;
grant execute on function bl.notify_route(uuid) to app_api;
comment on function bl.notify_route(uuid) is 'SECURITY DEFINER: канал, порядок каналов и id мессенджеров пользователя, без телефона.';
