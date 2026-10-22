-- 0410 (backend-pos): платежи бара в bl.payments (таблица money M1, контракт m2.md §5).
--
-- Оплата в кассе (cash, card_terminal, sbp) и оплата бара гостем (заказ со стола онлайн,
-- счёт стола) — строки bl.payments с kind = 'bar': так смена (server/shifts, decisions №83)
-- и выручка владельца считают все наличные и безналичные клуба по одной таблице, а вебхук,
-- сверка и возвраты ЮKassa money работают для бара без изменений.
--
-- У платежа бара нет стола (продажа на кассе) и может не быть гостя (покупатель на кассе):
-- resource_id и user_id становятся необязательными только для kind = 'bar'; для стола
-- (start, extend) они по-прежнему обязательны. Минут, котировки и «Без лимита» у бара нет.
-- Остальные ограничения 0200 (провайдер и способ, сумма > 0, payments_guard) не меняются.
--
-- Согласовать с backend-money: это правка таблицы money из миграции backend-pos.
-- Обработчик light payment.confirmed должен пропускать kind = 'bar' без тревоги (отчёт M2).

alter table bl.payments alter column resource_id drop not null;
alter table bl.payments alter column user_id drop not null;

alter table bl.payments drop constraint payments_kind_check;
alter table bl.payments add constraint payments_kind_check check (kind in ('start', 'extend', 'bar'));
alter table bl.payments add constraint payments_table_refs_check
  check (kind = 'bar' or (resource_id is not null and user_id is not null));
alter table bl.payments add constraint payments_bar_shape_check
  check (kind <> 'bar' or (quote_id is null and minutes is null and not unlimited and capture));

comment on column bl.payments.kind is 'start, extend — игра за столом (money M1); bar — бар и касса (backend-pos M2).';
