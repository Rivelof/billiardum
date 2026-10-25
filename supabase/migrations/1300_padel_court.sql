-- 1300 (backend, M5.8 №203–205): падел-корт — новый вид ресурса.
--
-- * Тип ресурса padel_court (в интерфейсе «корт»): клуб может иметь и столы, и корты. Код и API —
--   resource; слово интерфейса — из вида ресурса (server/lib/resource-kinds.mjs).
-- * Нумерация — своя у каждой семьи вида: «Стол 1…8» и «Корт 1…2» в одном клубе. Уникальность номера
--   (club_id, number) заменяется на (club_id, семья, number); семья — bl.resource_family(type).
-- * Правило тарифа по слотам (№204): slot_minutes (60, 90, 120) и price_per_slot (копейки, > 0) —
--   цена за слот; шаг и минимум правила слота — слот (step_minutes = min_minutes = slot_minutes).
--   price_per_hour у такого правила — справочная цена часа (её показывают старые экраны), движок
--   считает по цене слота. У типа padel_court — только правила слота; у столов слота нет
--   (проверяет мастер тарифов, server/setup/tariffs.mjs). Почасовые правила не меняются.
-- * Каталог сайта (№205): дисциплина карточки «padel».
-- Новых таблиц и прав нет: новые столбцы tariff_rules наследуют права app_api на таблицу (0002),
-- RLS прежняя (ENABLE и FORCE, club_id = контекст).

-- Семья вида ресурса ------------------------------------------------------------------------

create function bl.resource_family(p_type text) returns text
language sql immutable parallel safe
set search_path = pg_catalog
as $$ select case when p_type = 'padel_court' then 'court' else 'table' end $$;

comment on function bl.resource_family(text) is
  'Семья вида ресурса (M5.8 №203): court — падел-корт, table — столы бильярда; своя нумерация у каждой.';

revoke all on function bl.resource_family(text) from public;
grant execute on function bl.resource_family(text) to app_api;

-- Тип ресурса и правила тарифа ----------------------------------------------------------------

alter table bl.resources drop constraint resources_type_check;
alter table bl.resources add constraint resources_type_check
  check (type in ('billiard_pyramid', 'billiard_pool', 'billiard_snooker', 'billiard_mixed', 'padel_court'));

alter table bl.resources drop constraint resources_club_id_number_key;
create unique index resources_club_family_number_key on bl.resources (club_id, bl.resource_family(type), number);

comment on column bl.resources.type is
  'billiard_pyramid, billiard_pool, billiard_snooker, billiard_mixed (M5.1 №155); padel_court — падел-корт (M5.8 №203).';
comment on index bl.resources_club_family_number_key is
  'Номер ресурса уникален в клубе внутри семьи вида: стол 1 и корт 1 — разные (M5.8).';

alter table bl.tariff_rules drop constraint tariff_rules_resource_type_check;
alter table bl.tariff_rules add constraint tariff_rules_resource_type_check
  check (resource_type in ('billiard_pyramid', 'billiard_pool', 'billiard_snooker', 'billiard_mixed', 'padel_court'));

alter table bl.tariff_rules add column slot_minutes integer;
alter table bl.tariff_rules add column price_per_slot bigint;

alter table bl.tariff_rules add constraint tariff_rules_slot_check check (
  (slot_minutes is null and price_per_slot is null)
  or (slot_minutes in (60, 90, 120) and price_per_slot > 0 and step_minutes = slot_minutes and min_minutes = slot_minutes)
);
-- Тип со слотами — только правила слота (правило конкретного ресурса проверяет мастер: тип ресурса
-- в ограничении строки не виден).
alter table bl.tariff_rules add constraint tariff_rules_slot_type_check
  check (resource_type is distinct from 'padel_court' or slot_minutes is not null);

-- Шаг почасового правила — 1…60 минут, как раньше; у правила слота шаг равен слоту.
alter table bl.tariff_rules drop constraint tariff_rules_step_minutes_check;
alter table bl.tariff_rules add constraint tariff_rules_step_minutes_check
  check (step_minutes between 1 and 60 or (slot_minutes is not null and step_minutes = slot_minutes));

comment on column bl.tariff_rules.slot_minutes is
  'Длина слота правила (60, 90, 120 мин; M5.8 №204); null — почасовое правило.';
comment on column bl.tariff_rules.price_per_slot is
  'Цена слота в копейках (> 0) у правила слота; price_per_hour такого правила — справочная цена часа.';

-- Каталог сайта ------------------------------------------------------------------------------

alter table bl.club_public drop constraint club_public_disciplines_check;
alter table bl.club_public add constraint club_public_disciplines_check
  check (disciplines <@ '{pyramid,pool,snooker,padel}'::text[]);
