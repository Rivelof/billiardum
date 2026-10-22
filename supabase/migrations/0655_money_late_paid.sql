-- 0655 (backend-money, находка pentester B-L1): платёж оплачен в ЮKassa после того, как мы его
-- отменили (404 у ЮKassa, сгоревшая заявка, отмена по таймауту). Деньги гостя возвращаются сами:
-- succeeded — возврат ЮKassa с чеком возврата (ключ late-<payment_id>), waiting_for_capture — отмена
-- заморозки. late_paid_at — когда это обнаружено (ставится один раз): тревога владельцу и
-- уведомление гостю — только при первой отметке (server/payments/late.mjs).

alter table bl.payments add column late_paid_at timestamptz;

grant update (late_paid_at) on bl.payments to app_api;

comment on column bl.payments.late_paid_at is 'Когда обнаружено, что отменённый у нас платёж оплачен в ЮKassa (деньги возвращаются автоматически).';
