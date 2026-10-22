-- 0104 (backend-core): уборка просроченных ключей идемпотентности в контексте платформы.
--
-- DELETE … WHERE expires_at < … читает столбцы строки, поэтому строка должна быть видна
-- и политикой SELECT. Своя строка видна только самому пользователю (0101); уборщику
-- (контекст платформы, bl.ctx_is_platform()) нужна отдельная политика чтения.

create policy idempotency_keys_platform_select on bl.idempotency_keys for select to app_api
  using (bl.ctx_is_platform());
