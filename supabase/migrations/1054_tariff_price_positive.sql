-- 1054 (backend, M5.1 №163, pentester П-1): цена тарифа строго больше нуля и в базе.
--
-- API принимает только price_per_hour_kopecks > 0 (server/setup/tariffs.mjs), бесплатная игра —
-- ручное действие персонала (инвариант 8), а не тариф 0 ₽/ч. Ограничение 0002 разрешало 0 —
-- заменяем на > 0 с проверкой всех строк: в сиде и тестах правил с ценой 0 нет. Если в базе стенда
-- такое правило есть, миграция останавливается с понятной ошибкой и ничего не меняет: правило
-- исправляют вручную (цена или замена тарифа через мастер), затем миграцию применяют снова.

do $$
declare
  v_n integer;
begin
  select count(*) into v_n from bl.tariff_rules where price_per_hour <= 0;
  if v_n > 0 then
    raise exception '1054: % tariff rule(s) with price_per_hour <= 0; fix them before migrating', v_n
      using errcode = '23514';
  end if;
end
$$;

alter table bl.tariff_rules drop constraint tariff_rules_price_per_hour_check;
alter table bl.tariff_rules add constraint tariff_rules_price_per_hour_check check (price_per_hour > 0);

comment on constraint tariff_rules_price_per_hour_check on bl.tariff_rules is
  'Цена тарифа в копейках строго больше нуля (№163); бесплатная игра — ручное действие.';
