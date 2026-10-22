# Склад бара (backend-pos, M2)

Решение №80: остаток — сумма движений `bl.stock_movements` (`sale`, `arrival`, `writeoff`, `audit`, `return`), себестоимость — средняя по приходам (Σ стоимости приходов / Σ количества приходов). Количество — до тысячных (модификатор «0,4 л» списывает 1,3 порции), считается в тысячных `BigInt`; деньги — копейки, «половина вверх».

- `api.mjs` — `balances`, `avgCosts`, `recordSales` (продажа строки заказа один раз), `recordReturns` (отмена заказа или возврат продажи — только списанные строки), `movementCost`.
- `service.mjs` — приход (`cost_kopecks` или `unit_cost_kopecks`), списание (причина обязательна), ревизия «факт против расчёта» (поправка `audit`, расхождение в деньгах по средней, `bl.stock_audits`), остатки и движения; журнал `stock.arrival`, `stock.writeoff`, `stock.audit`.
- Стоп-лист при нуле — настройка клуба `pos_stop_at_zero` (меню и заказ: товар с учётом склада и остатком ≤ 0 недоступен).

Маршруты — `api/routes/stock.mjs` (управляющий и выше; остатки — ресепшн и выше). Тесты — `server/stock/test/qty.test.mjs`, `server/orders/test/db/catalog.test.mjs`.
