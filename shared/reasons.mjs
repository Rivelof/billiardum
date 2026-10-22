/**
 * Бильярдум — коды причин ручных действий и их подписи. Код уходит в API (reason_code),
 * свободный текст причины — в reason_text и журнал (decisions №31, инвариант 8).
 * Список согласуется с backend; неизвестный код показывается как «Другое».
 */

/** Отклонение заявки «Оплачу на ресепшене» (POST /api/reception/requests/{id}/decline). */
export const DECLINE_REASONS = Object.freeze([
  { code: 'guest_left', label: 'Гость не подошёл', guest: 'на ресепшене вас не дождались' },
  { code: 'guest_cancelled', label: 'Гость передумал', guest: 'вы отказались на ресепшене' },
  { code: 'payment_failed', label: 'Оплата не прошла', guest: 'оплата на ресепшене не прошла' },
  { code: 'table_problem', label: 'Стол неисправен', guest: 'стол неисправен' },
  { code: 'other', label: 'Другое', guest: 'причина не указана' },
]);

/** Сервисный свет (POST /api/resources/{id}/service). */
export const SERVICE_REASONS = Object.freeze([
  { code: 'cleaning', label: 'Уборка' },
  { code: 'repair', label: 'Ремонт или осмотр' },
  { code: 'training', label: 'Тренировка персонала' },
  { code: 'other', label: 'Другое' },
]);

/**
 * Подпись причины по коду.
 * @param {readonly { code: string, label: string }[]} list
 * @param {string | undefined} code
 */
export function reasonLabel(list, code) {
  return (list.find((r) => r.code === code) ?? list.find((r) => r.code === 'other'))?.label ?? 'Другое';
}
