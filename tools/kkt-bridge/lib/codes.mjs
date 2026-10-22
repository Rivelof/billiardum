// Коды ошибок драйвера ККТ АТОЛ (ДТО 10, libfptr) и статусы заданий веб-сервера.
// Общие для моста и эмулятора. Документация АТОЛ из среды разработки не открывается:
// коды взяты из открытых источников (README, раздел «Сверить со Swagger»); мост решает
// по категории, а не по одному коду, и для неизвестных ошибок спрашивает состояние смены.

/** Статусы задачи в результате задания веб-сервера АТОЛ. */
export const TASK_STATUS = Object.freeze({
  WAIT: 'wait',
  IN_PROGRESS: 'inProgress',
  READY: 'ready',
  ERROR: 'error',
  INTERRUPTED: 'interrupted',
  BLOCKED: 'blocked',
  CANCELED: 'canceled',
});

/** Задача ещё может завершиться: ждём. */
export const OPEN_STATUSES = new Set(['wait', 'inProgress', 'blocked']);

export const CODES = Object.freeze({
  OK: 0,
  CONNECTION_DISABLED: 1, // соединение не установлено
  NO_CONNECTION: 2, // нет связи с ККТ
  PORT_BUSY: 3,
  PORT_NOT_AVAILABLE: 4,
  INCORRECT_DATA: 5,
  INVALID_PARAM: 9, // неверный параметр задания (сверить)
  NO_PAPER: 44,
  COVER_OPENED: 45,
  PRINTER_FAULT: 46,
  SHIFT_EXPIRED: 68, // смена превысила 24 часа (сверить)
  DENIED_IN_CLOSED_SHIFT: 69, // смена закрыта — операция невозможна (сверить)
  DENIED_IN_OPENED_SHIFT: 70, // смена открыта — операция невозможна (сверить)
  PRINTER_OVERHEAT: 114,
  FN_EXCHANGE: 115, // ошибка обмена с ФН (сверить)
  FN_NOT_FOUND: 116,
  FN_FAULT: 159,
  FN_INTERRUPTED: 166,
  FN_CLOSE_RECEIPT_INTERRUPTED: 177,
  CONNECTION_LOST: 241,
  // Веб-сервер: задача не выполнялась из-за ошибки предыдущей, задание отменено.
  INTERRUPTED: 502,
  CANCELED: 503,
});

const CONNECTION = new Set([1, 2, 3, 4, 241]);
const PAPER = new Set([44, 45, 46, 114]);
const FN = new Set([115, 116, 159, 166, 177]);
const INVALID = new Set([5, 8, 9]);

/**
 * Категория ошибки для сервера:
 *   connection — ККТ не на связи (повторять, пока не появится);
 *   paper — бумага, крышка, принтер (повторять, предупредить ресепшн);
 *   fn — фискальный накопитель (несколько повторов, затем failed и тревога);
 *   shift_expired — смена ККТ дольше 24 часов (закрыть смену и повторить);
 *   invalid — задание отклонено (чек не пробить без исправления);
 *   unknown — прочее.
 */
export function categoryOf(code) {
  if (CONNECTION.has(code)) return 'connection';
  if (PAPER.has(code)) return 'paper';
  if (FN.has(code)) return 'fn';
  if (code === CODES.SHIFT_EXPIRED) return 'shift_expired';
  if (INVALID.has(code)) return 'invalid';
  return 'unknown';
}

export const DESCRIPTIONS = Object.freeze({
  0: 'Ошибок нет',
  1: 'Соединение не установлено',
  2: 'Нет связи',
  3: 'Порт занят',
  4: 'Порт недоступен',
  5: 'Некорректные данные от устройства',
  9: 'Неверный параметр',
  44: 'Нет бумаги',
  45: 'Открыта крышка',
  46: 'Неисправность печатающего устройства',
  68: 'Смена превысила 24 часа',
  69: 'Смена закрыта - операция невозможна',
  70: 'Смена открыта - операция невозможна',
  114: 'Перегрев печатающей головки',
  115: 'Ошибка обмена с ФН',
  116: 'ФН не найден',
  159: 'Ошибка ФН',
  166: 'Операция с ФН прервана',
  177: 'Закрытие чека прервано',
  241: 'Соединение потеряно',
  502: 'Выполнение прервано из-за предыдущих ошибок',
  503: 'Задание отменено',
});

export function describe(code) {
  return DESCRIPTIONS[code] ?? `Ошибка ${code}`;
}
