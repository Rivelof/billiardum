/**
 * Касса ресепшена: ввод полученной суммы и сдача. Всё в целых копейках (инвариант 10).
 * Сервер считает сдачу сам (контракт §5), на экране — та же арифметика заранее.
 */

const MAX_KOPECKS = 1_000_000_000; // 10 000 000 ₽ — защита от случайного ввода лишних цифр

/**
 * Рубли из того, что ввёл кассир: '2000', '2 000', '2000,50', '2000.5', '1 600 ₽'.
 * @param {string} input
 * @returns {number | null} копейки или null, если сумма не распознана
 */
export function parseRubles(input) {
  if (typeof input !== 'string') return null;
  const s = input.replace(/[\s\u00a0\u202f\u20bd]/g, '').replace(',', '.');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const kopecks = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return kopecks > MAX_KOPECKS ? null : kopecks;
}

/**
 * Сдача и нехватка.
 * @param {number} amount к оплате, копейки
 * @param {number | null} received получено, копейки
 * @returns {{ enough: boolean, change: number, short: number }}
 */
export function changeFor(amount, received) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new TypeError('changeFor: сумма — целые копейки');
  if (received === null || received === undefined || !Number.isSafeInteger(received)) return { enough: false, change: 0, short: amount };
  if (received >= amount) return { enough: true, change: received - amount, short: 0 };
  return { enough: false, change: 0, short: amount - received };
}

/**
 * Быстрые суммы для кнопок: без сдачи, до ближайших 500 и 1000 ₽, крупная купюра.
 * @param {number} amount копейки
 * @returns {number[]} копейки, по возрастанию, без повторов, не больше четырёх
 */
export function quickSums(amount) {
  const up = (step) => Math.ceil(amount / step) * step;
  const notes = [amount, up(50000), up(100000), up(500000)];
  return [...new Set(notes)].filter((v) => v >= amount).sort((a, b) => a - b).slice(0, 4);
}

/**
 * Экранная клавиатура суммы: цифры, '00', 'back' (стереть), 'clear'.
 * @param {string} current строка рублей без пробелов
 * @param {string} key
 * @returns {string}
 */
export function keypad(current, key) {
  const value = current ?? '';
  if (key === 'back') return value.slice(0, -1);
  if (key === 'clear') return '';
  if (!/^(\d|00)$/.test(key)) return value;
  if (value === '' && (key === '0' || key === '00')) return value; // без ведущих нулей
  const next = value + key;
  return next.length > 7 ? value : next; // до 9 999 999 ₽
}

/** Строка рублей для поля с пробелами по разрядам: '12500' → '12 500'. */
export function groupDigits(value) {
  return String(value ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
