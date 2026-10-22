-- Сид разработки backend-money (контракт M1 §13): настройки денег тестового клуба.
-- Только разработка (decisions №21). Повторный запуск ничего не дублирует и не трогает
-- то, что уже настроено. Праздники — в миграции 0201 (нужны и в проде).
--
-- Ключи магазина ЮKassa здесь не хранятся: shop_id и зашифрованный секрет для эмулятора
-- задаёт `npm run provision:dev` (server/payments/provision-dev.mjs).

-- Настройки тарифа клуба (decisions №43, №44): рабочие сутки с 06:00, округление до рубля.
update bl.clubs
   set settings = jsonb_build_object('day_start_local', '06:00', 'price_rounding_kopecks', 100) || settings
 where id = 'c1000000-0000-4000-8000-000000000001'
   and not (settings ? 'day_start_local' and settings ? 'price_rounding_kopecks');

-- Чеки 54-ФЗ: без НДС (vat_code 1), УСН «доходы» (tax_system_code 2) — синтетика;
-- у настоящего клуба — по ответу его бухгалтера (decisions №52).
insert into bl.club_payment_settings (club_id, vat_code, tax_system_code) values
  ('c1000000-0000-4000-8000-000000000001', 1, 2)
on conflict (club_id) do nothing;

-- Утро 06:00–12:00 — только в разработке: в примере PRODUCT §9 утра нет (клуб закрыт),
-- и котировка в эти часы даёт no_tariff. Чтобы сценарии T1–T12 шли в любое время суток,
-- утро стоит как день (500 ₽ пн–чт, 600 ₽ пт–вс и праздники).
insert into bl.tariff_rules (id, club_id, resource_type, days, start_local, end_local, price_per_hour, step_minutes, min_minutes, priority) values
  ('f1000000-0000-4000-8000-000000000013', 'c1000000-0000-4000-8000-000000000001', 'billiard_pyramid', '{1,2,3,4}', '06:00', '12:00', 50000, 1, 30, 0),
  ('f1000000-0000-4000-8000-000000000014', 'c1000000-0000-4000-8000-000000000001', 'billiard_pyramid', '{5,6,7}',   '06:00', '12:00', 60000, 1, 30, 0),
  ('f1000000-0000-4000-8000-000000000015', 'c1000000-0000-4000-8000-000000000001', 'billiard_pool',    '{1,2,3,4}', '06:00', '12:00', 50000, 1, 30, 0),
  ('f1000000-0000-4000-8000-000000000016', 'c1000000-0000-4000-8000-000000000001', 'billiard_pool',    '{5,6,7}',   '06:00', '12:00', 60000, 1, 30, 0)
on conflict (id) do nothing;
