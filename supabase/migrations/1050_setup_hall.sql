-- 1050 (backend-B, M5.1 №155, №159): зал клуба в мастере подключения.
--
-- * Тип стола «смешанный» (billiard_mixed): стол, на котором играют и пирамиду, и пул.
--   Тарифы задаются по типу так же, как у остальных (tariff_rules.resource_type).
--   Рейтинг и каталог дисциплину такому столу не приписывают (DISCIPLINE_OF_TYPE → null).
-- * resources.sticker_printed_at — когда QR-наклейку стола последний раз выгружали в PDF
--   (GET /api/clubs/{club}/qr-stickers.pdf). Пункт 6 чек-листа запуска (№160): «наклейки
--   напечатаны хотя бы раз» — функция qr.printedAt (server/setup).
-- Новых прав не нужно: у app_api уже select, insert, update на bl.resources и bl.tariff_rules
-- (0002), удаления нет — стол с историей только выводится из работы (active = false).

alter table bl.resources drop constraint resources_type_check;
alter table bl.resources add constraint resources_type_check
  check (type in ('billiard_pyramid', 'billiard_pool', 'billiard_snooker', 'billiard_mixed'));

alter table bl.tariff_rules drop constraint tariff_rules_resource_type_check;
alter table bl.tariff_rules add constraint tariff_rules_resource_type_check
  check (resource_type in ('billiard_pyramid', 'billiard_pool', 'billiard_snooker', 'billiard_mixed'));

alter table bl.resources add column sticker_printed_at timestamptz;

comment on column bl.resources.type is
  'billiard_pyramid, billiard_pool, billiard_snooker; billiard_mixed — смешанный стол (M5.1 №155).';
comment on column bl.resources.sticker_printed_at is
  'Последняя выгрузка QR-наклейки стола в PDF (M5.1 №159, чек-лист №160 п. 6).';
