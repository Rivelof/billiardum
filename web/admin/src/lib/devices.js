/**
 * Контроллеры столов: проверка ввода для привязки (контракт §6, №67) и подписи для экрана «Контроллеры».
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM = /^[A-Za-z0-9-]{6,64}$/;

/** Номер контроллера с наклейки (UUID): регистр и пробелы по краям не важны. */
export function parseDeviceId(input) {
  const v = String(input ?? '').trim().toLowerCase();
  return UUID.test(v) ? v : null;
}

/** Код привязки с наклейки: 6–64 символа, латиница, цифры, дефис. Пробелы внутри убираем (их ставят при печати). */
export function parseClaimCode(input) {
  const v = String(input ?? '').replace(/\s+/g, '');
  return CLAIM.test(v) ? v : null;
}

/** Сигнал Wi-Fi словом: статус не только цифрой. */
export function signalWord(rssi) {
  if (!Number.isFinite(rssi)) return null;
  if (rssi >= -60) return 'отличный';
  if (rssi >= -70) return 'хороший';
  if (rssi >= -80) return 'слабый';
  return 'очень слабый';
}

const CAPS = { relay: 'реле', led: 'индикатор', buzzer: 'пищалка', current: 'датчик тока', dimmer: 'диммер' };
const ORDER = ['relay', 'current', 'led', 'buzzer', 'dimmer'];

/** Возможности контроллера (caps) словами в постоянном порядке. */
export function capsWords(caps) {
  const list = Array.isArray(caps) ? caps : [];
  return ORDER.filter((c) => list.includes(c)).map((c) => CAPS[c]);
}

/** Без датчика тока не работает защита от света в обход системы (PRODUCT §8, №14.4). */
export function noCurrentSensor(device) {
  return Boolean(device?.id) && Array.isArray(device.caps) && device.caps.length > 0 && !device.caps.includes('current');
}
