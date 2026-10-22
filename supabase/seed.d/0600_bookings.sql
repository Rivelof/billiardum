-- Сид разработки брони (backend-booking, M3): правила брони тестового клуба. Только синтетика,
-- броней в сиде нет (время сида устарело бы к следующему запуску). Повторный запуск ничего не меняет.
--
-- clubs.settings (server/bookings/settings.mjs): полная предоплата, удержание 15/30 минут (№107),
-- шаг 30 минут, длительность 1–4 часа, бронь не ближе 15 минут и не дальше 30 дней,
-- бесплатная отмена — раньше чем за 2 часа. Процент удержания при сгорании — у money
-- (club_payment_settings.booking_forfeit_percent, по умолчанию 100, №108).

update bl.clubs
   set settings = jsonb_build_object(
         'booking_prepayment', 'full',
         'booking_deposit_kopecks', 50000,
         'booking_free_cancel_minutes', 120,
         'booking_min_minutes', 60,
         'booking_max_minutes', 240,
         'booking_step_minutes', 30,
         'booking_lead_minutes', 15,
         'booking_max_days', 30,
         'booking_pay_minutes', 15,
         'booking_hold_minutes', 15,
         'booking_hold_prepaid_minutes', 30
       ) || settings
 where id = 'c1000000-0000-4000-8000-000000000001'
   and not (settings ? 'booking_prepayment');
