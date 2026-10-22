// Интерфейс модуля заказов для соседей (контракт M2 §5).
//
//   openTab(db, sessionId) → { orders, total_kopecks }
//       Счёт стола: заказы «в счёт стола», которые ещё не оплачены и не отменены
//       (decisions №79: счёт живёт дольше сессии). Для чека сессии (light) и экрана ресепшена.
//       db — транзакция с контекстом клуба сессии или без клуба (контекст ставится по сессии).
//
//   shiftLinkProblems(db, { clubId }) → [{ object: 'pos_sale' | 'pos_refund', id, shift_id }]
//       Сверка (decisions №92): shift_id продажи и возврата — мягкая ссылка на bl.shifts (kkt);
//       каждая должна указывать на существующую смену своего клуба. Пустой список — всё сходится.

export { openTab } from './service.mjs';

export async function shiftLinkProblems(db, { clubId }) {
  const { rows } = await db.query(
    `select 'pos_sale' as object, s.id, s.shift_id from bl.pos_sales s
      where s.club_id = $1 and s.shift_id is not null
        and not exists (select 1 from bl.shifts sh where sh.id = s.shift_id and sh.club_id = s.club_id)
     union all
     select 'pos_refund', r.id, r.shift_id from bl.pos_refunds r
      where r.club_id = $1 and r.shift_id is not null
        and not exists (select 1 from bl.shifts sh where sh.id = r.shift_id and sh.club_id = r.club_id)
     order by 1, 2`,
    [clubId],
  );
  return rows;
}
