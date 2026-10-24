-- 1201 (backend, M5.7 №201): уведомление владельцу, что вебхук не принимает события.
--
-- Доставка перешла в failed (24 часа без 2xx) — владельцу одно уведомление (не тревога) на адрес;
-- повтор — не раньше чем через сутки. webhooks.failure_notified_at — когда уведомили последний раз;
-- триггер bl.webhooks_guard этот столбец не охраняет, app_api меняет только его и выключение.

alter table bl.webhooks add column failure_notified_at timestamptz;
grant update (failure_notified_at) on bl.webhooks to app_api;

comment on column bl.webhooks.failure_notified_at is
  'Последнее уведомление владельцу «вебхук не принимает события» (не чаще раза в сутки, M5.7).';
