-- Платёж, которого ЮKassa не знает (404 на GET /v3/payments/{id}): сбой при создании, чужой магазин,
-- в разработке — перезапущенный эмулятор. Сверка отмечает первый 404 (лог и тревога — один раз),
-- pending старше часа отменяет с причиной not_found_at_provider (server/payments/pay.mjs).

alter table bl.payments add column provider_missing_at timestamptz;

grant update (provider_missing_at) on bl.payments to app_api;

comment on column bl.payments.provider_missing_at is 'Когда ЮKassa впервые ответила 404 на запрос этого платежа (сверка).';
