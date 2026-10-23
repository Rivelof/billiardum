-- 0710 (backend-core, M4 §1 п. 5, decisions №134): роли платформы и журнал платформы.
--
-- platform_members — роли платформы отдельно от club_members: platform_operator (заявки гостей
-- и клубов, модерация) и platform_admin (Андрей: всё платформенное, в том числе права оператора).
-- Контекст роли платформы: сервер после проверки ставит app.platform_role (на транзакцию);
-- bl.ctx_platform_role() отдаёт его, только если пользователь из контекста действительно
-- активный участник платформы с этой ролью (иначе NULL) — политики модулей M4 опираются на неё.
-- Журнал платформы (club_id IS NULL): маршруты платформы работают с actor_type support и
-- app.user_id сотрудника — запись идёт в цепочку платформы от его имени по политике M0
-- (журнал и его политики не меняются).

create table bl.platform_members (
  user_id uuid primary key references bl.users (id),
  role text not null check (role in ('platform_operator', 'platform_admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index platform_members_role_idx on bl.platform_members (role) where active;

alter table bl.platform_members owner to bl_owner;
alter table bl.platform_members enable row level security;
alter table bl.platform_members force row level security;

-- Свою строку пользователь видит в личном контексте (роутер узнаёт роли); все — платформе.
create policy platform_members_select on bl.platform_members for select to app_api
  using ((bl.ctx_club_id() is null and user_id = bl.ctx_user_id()) or bl.ctx_is_platform());

revoke all on bl.platform_members from public;
grant select on bl.platform_members to app_api;

grant select (user_id, role, active) on bl.platform_members to bl_definer;
create policy platform_members_definer on bl.platform_members for select to bl_definer using (true);

comment on table bl.platform_members is 'Роли платформы (№134): platform_operator, platform_admin. Назначаются миграцией или администратором базы.';

-- Роль платформы из контекста, подтверждённая базой ---------------------------------------
create function bl.ctx_platform_role() returns text
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select m.role
    from bl.platform_members m
   where m.user_id = nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
     and m.active
     and m.role = nullif(pg_catalog.current_setting('app.platform_role', true), '')
     and nullif(pg_catalog.current_setting('app.club_id', true), '') is null
$$;
alter function bl.ctx_platform_role() owner to bl_definer;
revoke all on function bl.ctx_platform_role() from public;
grant execute on function bl.ctx_platform_role() to app_api;
comment on function bl.ctx_platform_role() is
  'SECURITY DEFINER: роль платформы из app.platform_role, если пользователь из контекста — активный участник платформы с этой ролью; иначе NULL.';

-- Получатели уведомлений платформы --------------------------------------------------------
-- Операторы: активные platform_operator; если их нет — администраторы (заявка не теряется).
-- Администратор: активные platform_admin.
create function bl.platform_recipients(p_role text) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  with ops as (
    select m.user_id from bl.platform_members m where m.active and m.role = p_role
  )
  select user_id from ops
  union all
  select m.user_id from bl.platform_members m
   where p_role = 'platform_operator' and m.active and m.role = 'platform_admin'
     and not exists (select 1 from ops)
$$;
alter function bl.platform_recipients(text) owner to bl_definer;
revoke all on function bl.platform_recipients(text) from public;
grant execute on function bl.platform_recipients(text) to app_api;
comment on function bl.platform_recipients(text) is
  'SECURITY DEFINER: получатели уведомлений платформы по роли (операторов нет — администраторы).';
