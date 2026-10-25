-- 1351 (backend, M5.5 × M5.8): шаблон тарифов сети с правилами слота (падел-корт, №204).
--
-- Правило шаблона хранится в виде мастера тарифов (server/setup/tariffs.mjs normalizeRules):
-- у вида со слотом — slot_minutes и price_per_slot_kopecks (цена слота), без цены часа; у столов —
-- price_per_hour_kopecks. Столбец price_per_hour — цена правила в копейках (часа или слота), строго > 0
-- (№163, проверка 1350 остаётся); здесь — что он равен цене из правила, и длина слота — 60, 90 или 120.

alter table bl.network_tariff_rules drop constraint network_tariff_rules_check;
alter table bl.network_tariff_rules add constraint network_tariff_rules_price_matches check (
  case
    when rule ? 'price_per_slot_kopecks' then
      (rule ->> 'price_per_slot_kopecks') = price_per_hour::text
      and (rule ->> 'slot_minutes') in ('60', '90', '120')
      and not rule ? 'price_per_hour_kopecks'
    else (rule ->> 'price_per_hour_kopecks') = price_per_hour::text
  end
);

comment on column bl.network_tariff_rules.price_per_hour is
  'Цена правила в копейках, > 0 (№163): часа — у столов, слота — у вида со слотом (M5.8, rule.price_per_slot_kopecks).';
