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

/**
 * M2. Скидка выше лимита клуба (№82): управляющий подтверждает с причиной, владельцу — тревога.
 * Код уходит в `discount.reason_code`, текст — в `discount.reason_text`. Список сверяется с backend-pos.
 */
export const DISCOUNT_REASONS = Object.freeze([
  { code: 'regular_guest', label: 'Постоянный гость' },
  { code: 'compensation', label: 'Компенсация за неудобство' },
  { code: 'promo', label: 'Акция клуба' },
  { code: 'staff', label: 'Сотрудник клуба' },
  { code: 'other', label: 'Другое' },
]);

/** M2. Списание со склада (POST /api/stock/writeoffs): причина обязательна. */
export const WRITEOFF_REASONS = Object.freeze([
  { code: 'broken', label: 'Бой или порча' },
  { code: 'expired', label: 'Истёк срок годности' },
  { code: 'treat', label: 'Угощение от клуба' },
  { code: 'staff_meal', label: 'Питание персонала' },
  { code: 'other', label: 'Другое' },
]);

/**
 * M4, №149. Возврат взноса за турнир после старта — только объективные причины из закрытого списка
 * (POST …/tournaments/{id}/entries/{entry_id}/refund { reason_code, comment }). Личные причины не основание.
 * Варианта «Другое» нет намеренно: неизвестный код подписывается «Причина не из списка».
 */
export const LATE_REFUND_REASONS = Object.freeze([
  { code: 'health', label: 'Здоровье игрока' },
  { code: 'equipment', label: 'Поломка оборудования' },
  { code: 'venue', label: 'Авария в клубе (свет, помещение)' },
]);

/** Отмена турнира после старта с возвратом взносов всем — только авария (POST …/cancel { refund: 'all', reason_code }). */
export const CANCEL_REFUND_CODES = Object.freeze(['equipment', 'venue']);

/** Подпись причины возврата взноса: код не из списка — «причина не из списка». */
export function lateRefundLabel(code) {
  return LATE_REFUND_REASONS.find((r) => r.code === code)?.label ?? 'Причина не из списка';
}
