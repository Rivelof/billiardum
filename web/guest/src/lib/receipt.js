/**
 * Чек сессии (GET /api/sessions/{id}/receipt). receipt_status у сервера — объект по платежам
 * { [payment_id]: 'pending' | 'succeeded' | 'receipt_pending' | 'failed' | 'canceled' | 'none' },
 * в контракте — строка; принимаем оба вида и сводим к одному состоянию для гостя.
 */

const RANK = ['failed', 'receipt_pending', 'pending', 'succeeded', 'none'];

/** @returns {'failed' | 'receipt_pending' | 'pending' | 'succeeded' | 'none'} */
export function receiptState(status) {
  if (typeof status === 'string') return status === 'sent' || status === 'done' ? 'succeeded' : RANK.includes(status) ? status : 'none';
  if (!status || typeof status !== 'object') return 'none';
  const values = Object.values(status).filter((v) => v !== 'canceled');
  if (!values.length) return 'none';
  // Худшее по платежам: если хоть один чек ждёт кассу — так и пишем
  for (const s of RANK) if (values.includes(s)) return s === 'none' && values.some((v) => v === 'succeeded') ? 'succeeded' : s;
  return 'none';
}

export const RECEIPT_TEXT = {
  succeeded: 'Чек по 54‑ФЗ отправлен на ваш номер.',
  pending: 'Чек по 54‑ФЗ формируется и придёт на ваш номер.',
  receipt_pending: 'Чек по 54‑ФЗ пробивается на кассе клуба.',
  failed: 'Чек пока не сформировался — клуб пробьёт его повторно.',
  none: 'Чек по 54‑ФЗ придёт на ваш номер.',
};

/** Строки возвратов из платежей: refunded_kopecks > 0 → отрицательная строка. */
export function refundLines(payments) {
  return (Array.isArray(payments) ? payments : [])
    .filter((p) => Number.isSafeInteger(p.refunded_kopecks) && p.refunded_kopecks > 0)
    .map((p) => ({ title: 'Возврат', amount_kopecks: -p.refunded_kopecks }));
}
