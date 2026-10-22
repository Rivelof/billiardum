-- 0656 (backend-money, дефект tester Д2): повтор чека зачёта предоплаты после отказа ЮKassa (4xx).
--
-- 5xx и сеть повторяет outbox сам (пауза 1, 2, 4 … 300 с) тем же ключом st-<receipt_id>.
-- Отказ 4xx — статус failed и тревога settlement_receipt_failed с действием «Повторить»:
-- POST /api/receipts/{id}/retry (управляющий и выше, причина) увеличивает settle_retry и ставит
-- чек обратно в очередь. Ключ ЮKassa повтора — st-<receipt_id>-r<settle_retry>: ЮKassa (как и
-- эмулятор) на тот же ключ 24 часа возвращает тот же ответ, в том числе ту же ошибку 4xx, а
-- отказ 4xx означает, что чек не создан, — новый ключ не даёт второго чека.

alter table bl.receipts add column settle_retry smallint not null default 0 check (settle_retry between 0 and 100);

grant update (settle_retry) on bl.receipts to app_api;

comment on column bl.receipts.settle_retry is 'Сколько раз персонал повторил отправку чека зачёта после отказа ЮKassa (ключ st-<id>-r<n>).';
