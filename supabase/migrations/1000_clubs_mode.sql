-- 1000 (backend-A, M5.1 №152, №153, №160): клуб создаёт сам пользователь; режим клуба test | live,
-- приостановка платформой.
--
-- * clubs.mode — 'test' | 'live' | 'suspended'. Новый клуб пользователя (bl.create_club) — всегда
--   'test'. Значение столбца по умолчанию — 'live': так ведут себя клубы, которые заводит только
--   администратор базы (сид, миграции, тесты) и которые уже работали до M5.1; рабочая роль app_api
--   клубов не вставляет вовсе. Все существующие клубы — 'live' (они уже работали).
-- * suspended — клуб приостановлен платформой (mode_before_suspend — режим до приостановки;
--   записи такого клуба помечаются тестовыми, если он был в test).
-- * Режим меняют только узкие функции: bl.club_go_live (владелец клуба, test → live),
--   bl.club_suspend и bl.club_resume (Андрей, platform_admin). У app_api нет права UPDATE этих
--   столбцов: update на bl.clubs сужен до описательных полей.
-- * bl.club_mode(club) — режим клуба (без данных клуба), bl.ctx_club_mode() — режим клуба из контекста.
-- * bl.public_clubs() — только клубы в боевом режиме: тестовые и приостановленные не видны гостям.

-- Клубы ---------------------------------------------------------------------------------------

alter table bl.clubs
  add column mode text not null default 'live' check (mode in ('test', 'live', 'suspended')),
  add column mode_before_suspend text check (mode_before_suspend in ('test', 'live')),
  add column created_by uuid references bl.users (id),
  add column city_id uuid references bl.cities (id),
  add column listing_id uuid references bl.club_public (id),
  add column went_live_at timestamptz,
  add column offer_version text check (offer_version ~ '^[0-9A-Za-z._-]{1,32}$'),
  add column offer_accepted_at timestamptz,
  add column offer_accepted_by uuid references bl.users (id),
  add column suspended_at timestamptz,
  add column suspended_reason text check (length(btrim(suspended_reason)) between 1 and 2000),
  add constraint clubs_suspend_check check ((mode = 'suspended') = (mode_before_suspend is not null)),
  add constraint clubs_offer_check check ((offer_accepted_at is null) = (offer_version is null));

create unique index clubs_listing_uidx on bl.clubs (listing_id) where listing_id is not null;
create index clubs_created_by_idx on bl.clubs (created_by) where created_by is not null;

comment on column bl.clubs.mode is 'Режим клуба (M5.1 №153): test — проверка без денег, live — боевой, suspended — приостановлен платформой.';
comment on column bl.clubs.mode_before_suspend is 'Режим до приостановки (test или live); только у suspended.';
comment on column bl.clubs.listing_id is 'Карточка каталога из одобренной заявки «Подтвердить клуб» владельца: связывается при переходе в live.';
comment on column bl.clubs.went_live_at is 'Когда клуб перешёл в боевой режим (№160).';

-- Описательные поля клуба app_api меняет как раньше; режим, создателя и оферту — только функции ниже.
revoke update on bl.clubs from app_api;
grant update (name, city, timezone, settings, address) on bl.clubs to app_api;

-- Узким функциям (bl_definer) — режим и поля создания.
grant select (mode, mode_before_suspend, created_by, city_id, listing_id, went_live_at) on bl.clubs to bl_definer;
grant insert (id, name, city, timezone, settings, mode, created_by, city_id, listing_id) on bl.clubs to bl_definer;
grant update (mode, mode_before_suspend, went_live_at, offer_version, offer_accepted_at, offer_accepted_by,
              suspended_at, suspended_reason) on bl.clubs to bl_definer;
create policy clubs_definer_insert on bl.clubs for insert to bl_definer with check (true);
create policy clubs_definer_update on bl.clubs for update to bl_definer using (true) with check (true);

-- Режим клуба ---------------------------------------------------------------------------------

create function bl.club_mode(p_club uuid) returns text
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$ select c.mode from bl.clubs c where c.id = p_club $$;
alter function bl.club_mode(uuid) owner to bl_definer;
revoke all on function bl.club_mode(uuid) from public;
grant execute on function bl.club_mode(uuid) to app_api;
comment on function bl.club_mode(uuid) is 'SECURITY DEFINER: режим клуба (test, live, suspended) или NULL; данных клуба не отдаёт.';

-- Режим клуба из контекста: по таблице, а не по app.club_mode (тот — только справка для сервера).
create function bl.ctx_club_mode() returns text
language sql stable
set search_path = pg_catalog, pg_temp
as $$ select bl.club_mode(bl.ctx_club_id()) $$;
alter function bl.ctx_club_mode() owner to bl_owner;
revoke all on function bl.ctx_club_mode() from public;
grant execute on function bl.ctx_club_mode() to app_api;

-- Создание клуба (№152) ---------------------------------------------------------------------
-- Вызывает вошедший пользователь в личном контексте (app.user_id задан, клуба нет, actor user).
-- Клуб в режиме test, пользователь — владелец, настройки денег по умолчанию. Не больше 3 клубов
-- в режиме test, где пользователь — владелец (блокировка по пользователю — без гонки).
-- p_listing_id — карточка каталога, на которую у пользователя одобрена заявка «Подтвердить клуб»
-- (или «Добавить клуб»), ещё не связанная с клубом. Ошибки: BLC01 — лимит, BLC02 — карточка
-- недоступна, BLC04 — у пользователя нет телефона, 42501 — нет пользователя или не личный контекст,
-- 22023 — неверные данные.

grant select (id, kind, card_id, user_id, status) on bl.directory_claims to bl_definer;
create policy directory_claims_definer on bl.directory_claims for select to bl_definer using (true);
grant select (id, club_id, status, city_id) on bl.club_public to bl_definer;
create policy club_public_definer on bl.club_public for select to bl_definer using (true);
grant select (id, name, timezone, active) on bl.cities to bl_definer;
create policy cities_definer on bl.cities for select to bl_definer using (true);
grant insert (club_id) on bl.club_payment_settings to bl_definer;
grant select (club_id) on bl.club_payment_settings to bl_definer;
create policy club_payment_settings_definer on bl.club_payment_settings for all to bl_definer using (true) with check (true);
-- Проверка пояса (check у clubs.timezone) при вставке клуба узкой функцией.
grant execute on function bl.is_valid_timezone(text) to bl_definer;

create function bl.create_club(p_name text, p_city_name text, p_city_id uuid, p_timezone text, p_listing_id uuid)
returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_me uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  v_ctx_club text := nullif(pg_catalog.current_setting('app.club_id', true), '');
  v_actor text := nullif(pg_catalog.current_setting('app.actor_type', true), '');
  v_name text := btrim(p_name);
  v_city text := btrim(p_city_name);
  v_city_id uuid := null;
  v_tz text := p_timezone;
  v_n integer;
  v_club uuid;
begin
  if v_me is null or v_ctx_club is not null or v_actor is distinct from 'user' then
    raise exception 'bl.create_club: only a signed-in user in personal context' using errcode = '42501';
  end if;
  if not exists (select 1 from bl.users u where u.id = v_me and u.merged_into is null and u.phone is not null) then
    raise exception 'bl.create_club: user without phone' using errcode = 'BLC04';
  end if;
  if v_name is null or length(v_name) < 1 or length(v_name) > 200 then
    raise exception 'bl.create_club: name' using errcode = '22023';
  end if;
  if p_city_id is not null then
    select c.id, c.name, coalesce(v_tz, c.timezone) into v_city_id, v_city, v_tz
      from bl.cities c where c.id = p_city_id and c.active;
    if v_city_id is null then
      raise exception 'bl.create_club: city' using errcode = '22023';
    end if;
  else
    if v_city is null or length(v_city) < 1 or length(v_city) > 100 then
      raise exception 'bl.create_club: city' using errcode = '22023';
    end if;
    select c.id, c.name into v_city_id, v_city from bl.cities c
     where c.active and lower(c.name) = lower(v_city) order by c.name limit 1;
    if v_city_id is null then
      v_city := btrim(p_city_name);
    end if;
  end if;
  if v_tz is null or not bl.is_valid_timezone(v_tz) then
    raise exception 'bl.create_club: timezone' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bl.create_club:' || v_me::text, 0));
  select count(*) into v_n
    from bl.clubs c join bl.club_members m on m.club_id = c.id
   where m.user_id = v_me and m.role = 'owner' and m.active and c.mode = 'test';
  if v_n >= 3 then
    raise exception 'bl.create_club: test clubs limit' using errcode = 'BLC01';
  end if;

  if p_listing_id is not null then
    if not exists (
         select 1 from bl.directory_claims dc
          where dc.card_id = p_listing_id and dc.user_id = v_me and dc.status = 'approved' and dc.kind in ('claim', 'add'))
       or exists (select 1 from bl.club_public cp where cp.id = p_listing_id and cp.club_id is not null)
       or exists (select 1 from bl.clubs c where c.listing_id = p_listing_id) then
      raise exception 'bl.create_club: listing not available' using errcode = 'BLC02';
    end if;
  end if;

  insert into bl.clubs (name, city, timezone, mode, created_by, city_id, listing_id)
  values (v_name, v_city, v_tz, 'test', v_me, v_city_id, p_listing_id)
  returning id into v_club;
  insert into bl.club_members (club_id, user_id, role) values (v_club, v_me, 'owner');
  insert into bl.club_payment_settings (club_id) values (v_club);
  return v_club;
end
$$;
alter function bl.create_club(text, text, uuid, text, uuid) owner to bl_definer;
revoke all on function bl.create_club(text, text, uuid, text, uuid) from public;
grant execute on function bl.create_club(text, text, uuid, text, uuid) to app_api;
comment on function bl.create_club(text, text, uuid, text, uuid) is
  'SECURITY DEFINER: клуб пользователя из контекста в режиме test (владелец — он), не больше 3 тестовых клубов (№152).';

-- Переход в боевой режим (№160) ----------------------------------------------------------------
-- Только владелец клуба из контекста (app.club_id = p_club, actor user). Чек-лист проверяет сервер
-- до вызова; функция отвечает за то, что режим меняется только test → live и только владельцем.
-- Уже live — без изменений (повтор). Ошибки: 42501 — не владелец, BLC03 — клуб приостановлен.

create function bl.club_go_live(p_club uuid, p_offer_version text)
returns timestamptz
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_me uuid := nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  v_ctx uuid := nullif(pg_catalog.current_setting('app.club_id', true), '')::uuid;
  v_mode text;
  v_at timestamptz;
begin
  if v_me is null or v_ctx is distinct from p_club
     or nullif(pg_catalog.current_setting('app.actor_type', true), '') is distinct from 'user'
     or not exists (select 1 from bl.club_members m where m.club_id = p_club and m.user_id = v_me and m.role = 'owner' and m.active) then
    raise exception 'bl.club_go_live: owner of the club in context only' using errcode = '42501';
  end if;
  if p_offer_version is null or p_offer_version !~ '^[0-9A-Za-z._-]{1,32}$' then
    raise exception 'bl.club_go_live: offer version' using errcode = '22023';
  end if;
  select c.mode, c.went_live_at into v_mode, v_at from bl.clubs c where c.id = p_club for update;
  if v_mode = 'live' then
    return v_at;
  end if;
  if v_mode is distinct from 'test' then
    raise exception 'bl.club_go_live: club is %', v_mode using errcode = 'BLC03';
  end if;
  update bl.clubs
     set mode = 'live', went_live_at = now(), offer_version = p_offer_version, offer_accepted_at = now(), offer_accepted_by = v_me
   where id = p_club
  returning went_live_at into v_at;
  return v_at;
end
$$;
alter function bl.club_go_live(uuid, text) owner to bl_definer;
revoke all on function bl.club_go_live(uuid, text) from public;
grant execute on function bl.club_go_live(uuid, text) to app_api;
comment on function bl.club_go_live(uuid, text) is 'SECURITY DEFINER: владелец переводит клуб из контекста test → live (№160).';

-- Приостановка и возобновление платформой (№160) -------------------------------------------------
-- Только Андрей (bl.ctx_platform_role() = 'platform_admin', клуба в контексте нет).
-- suspend: test или live → suspended (режим запоминается). resume: suspended → p_mode
-- ('test' или 'live'; NULL — прежний). Обратно в test клуб попадает только так.
-- Возвращают прежний режим. Ошибки: 42501 — не администратор, BLC03 — переход не из того режима.

create function bl.club_suspend(p_club uuid, p_reason text)
returns text
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_mode text;
begin
  if bl.ctx_platform_role() is distinct from 'platform_admin' then
    raise exception 'bl.club_suspend: platform_admin only' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 1 or length(p_reason) > 2000 then
    raise exception 'bl.club_suspend: reason' using errcode = '22023';
  end if;
  select c.mode into v_mode from bl.clubs c where c.id = p_club for update;
  if v_mode is null then
    return null;
  end if;
  if v_mode = 'suspended' then
    raise exception 'bl.club_suspend: already suspended' using errcode = 'BLC03';
  end if;
  update bl.clubs
     set mode = 'suspended', mode_before_suspend = v_mode, suspended_at = now(), suspended_reason = btrim(p_reason)
   where id = p_club;
  return v_mode;
end
$$;

create function bl.club_resume(p_club uuid, p_mode text)
returns text
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_mode text;
  v_before text;
  v_to text;
begin
  if bl.ctx_platform_role() is distinct from 'platform_admin' then
    raise exception 'bl.club_resume: platform_admin only' using errcode = '42501';
  end if;
  if p_mode is not null and p_mode not in ('test', 'live') then
    raise exception 'bl.club_resume: mode' using errcode = '22023';
  end if;
  select c.mode, c.mode_before_suspend into v_mode, v_before from bl.clubs c where c.id = p_club for update;
  if v_mode is null then
    return null;
  end if;
  if v_mode <> 'suspended' then
    raise exception 'bl.club_resume: club is not suspended' using errcode = 'BLC03';
  end if;
  v_to := coalesce(p_mode, v_before);
  update bl.clubs
     set mode = v_to, mode_before_suspend = null, suspended_at = null, suspended_reason = null,
         went_live_at = case when v_to = 'live' then coalesce(went_live_at, now()) else went_live_at end
   where id = p_club;
  return v_to;
end
$$;

alter function bl.club_suspend(uuid, text) owner to bl_definer;
alter function bl.club_resume(uuid, text) owner to bl_definer;
revoke all on function bl.club_suspend(uuid, text), bl.club_resume(uuid, text) from public;
grant execute on function bl.club_suspend(uuid, text), bl.club_resume(uuid, text) to app_api;
comment on function bl.club_suspend(uuid, text) is 'SECURITY DEFINER: platform_admin приостанавливает клуб (№160); возвращает прежний режим.';
comment on function bl.club_resume(uuid, text) is 'SECURITY DEFINER: platform_admin возобновляет клуб в test или live (№160); возвращает новый режим.';

-- Публичный список: только боевые клубы ------------------------------------------------------------

create or replace function bl.public_clubs()
returns table (id uuid, name text, city text, address text, timezone text, plan jsonb)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select c.id, c.name, c.city, c.address, c.timezone,
         case when jsonb_typeof(c.settings->'plan') = 'object'
              then jsonb_build_object('width_cm', c.settings->'plan'->'width_cm', 'height_cm', c.settings->'plan'->'height_cm')
         end
    from bl.clubs c
   where c.active and c.mode = 'live'
   order by c.city, c.name, c.id
$$;
comment on function bl.public_clubs() is
  'SECURITY DEFINER: публичные сведения активных клубов в боевом режиме (№120, №153), без персональных данных.';
