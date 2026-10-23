-- Сид разработки backend-core (M4, decisions №134): роли платформы. Только разработка.
-- Андрей-тест (+70000000009) — platform_admin, оператор (+70000000010) — platform_operator.
-- Вход — через бота или POST /api/auth/dev. Повторный запуск ничего не дублирует.

insert into bl.users (id, phone, name) values
  ('af000000-0000-4000-8000-000000000009', '+70000000009', 'Андрей (тест)'),
  ('af000000-0000-4000-8000-000000000010', '+70000000010', 'Оператор (тест)')
on conflict (id) do nothing;

insert into bl.platform_members (user_id, role) values
  ('af000000-0000-4000-8000-000000000009', 'platform_admin'),
  ('af000000-0000-4000-8000-000000000010', 'platform_operator')
on conflict (user_id) do nothing;
