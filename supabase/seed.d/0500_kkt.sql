-- Сид разработки backend-kkt (контракт M2 §3): настройки ККТ и смен тестового клуба.
-- Только разработка (decisions №21). Повторный запуск ничего не дублирует.
--
-- Мост ККТ в сид не входит: токен выдаётся владельцу один раз (POST /api/clubs/{club}/kkt/bridges)
-- или провижинингом разработки (server/kkt/provision-dev.mjs пишет токен в файл с правами 0600).
--
-- clubs.settings:
--   service_light_alarm_minutes — порог минут сервисного света за смену, выше — тревога (№71, по умолчанию 60);
--   kkt_shift_sync — открывать и закрывать смену ККТ вместе со сменой клуба (по умолчанию true).

update bl.clubs
   set settings = settings
       || jsonb_build_object('service_light_alarm_minutes', coalesce(settings -> 'service_light_alarm_minutes', '60'::jsonb))
       || jsonb_build_object('kkt_shift_sync', coalesce(settings -> 'kkt_shift_sync', 'true'::jsonb))
 where id = 'c1000000-0000-4000-8000-000000000001';
