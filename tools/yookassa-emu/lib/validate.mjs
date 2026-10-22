// Проверка запросов эмулятора ЮKassa: суммы, чек 54-ФЗ, метаданные.
// Ошибка — EmuError с кодом и полем parameter, как в ответах API v3.

export class EmuError extends Error {
  constructor(status, code, description, parameter) {
    super(description);
    this.status = status;
    this.code = code;
    this.parameter = parameter;
  }
}

const bad = (description, parameter) => new EmuError(400, 'invalid_request', description, parameter);

const VALUE = /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/;

/** '1600.00' → 160000 копеек; формат — строка с точкой и не больше двух знаков. */
export function parseValue(value, parameter) {
  if (typeof value !== 'string' && typeof value !== 'number') throw bad('Сумма — строка вида 100.00', parameter);
  const s = String(value);
  if (!VALUE.test(s)) throw bad(`Неверная сумма ${s}`, parameter);
  const [rub, kop = ''] = s.split('.');
  return Number(rub) * 100 + Number(kop.padEnd(2, '0'));
}

export function formatValue(kopecks) {
  return `${Math.floor(kopecks / 100)}.${String(kopecks % 100).padStart(2, '0')}`;
}

/** amount {value, currency: 'RUB'} → копейки (> 0). */
export function parseAmount(amount, parameter = 'amount') {
  if (!amount || typeof amount !== 'object') throw bad('Нет суммы', parameter);
  const kopecks = parseValue(amount.value, `${parameter}.value`);
  if (amount.currency !== 'RUB') throw bad('Валюта — только RUB', `${parameter}.currency`);
  if (kopecks <= 0) throw bad('Сумма должна быть больше нуля', `${parameter}.value`);
  return kopecks;
}

/** Количество позиции: число или строка, > 0, не больше трёх знаков после точки. */
function parseQuantity(q, parameter) {
  const s = String(q);
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(s) || Number(s) <= 0) throw bad('Неверное количество', parameter);
  return Math.round(Number(s) * 1000);
}

/**
 * Чек 54-ФЗ: обязателен; покупатель с телефоном или почтой; позиции с описанием,
 * количеством, ценой, ставкой НДС; сумма позиций равна сумме платежа (или возврата).
 */
export function checkReceipt(receipt, totalKopecks, parameter = 'receipt') {
  if (!receipt || typeof receipt !== 'object') throw bad('Нет чека: магазин работает с чеками 54-ФЗ', parameter);
  const customer = receipt.customer;
  const phone = customer?.phone;
  const email = customer?.email;
  if (!customer || (!phone && !email)) throw bad('Нет контакта покупателя (phone или email)', `${parameter}.customer`);
  if (phone !== undefined && !/^\d{7,15}$/.test(String(phone))) throw bad('Телефон — цифры в формате ITU-T E.164 без +', `${parameter}.customer.phone`);
  if (email !== undefined && !/^[^@\s]+@[^@\s]+$/.test(String(email))) throw bad('Неверная почта', `${parameter}.customer.email`);
  const items = receipt.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw bad('В чеке от 1 до 100 позиций', `${parameter}.items`);
  let sumMilli = 0;
  items.forEach((item, i) => {
    const p = `${parameter}.items[${i}]`;
    if (!item || typeof item !== 'object') throw bad('Неверная позиция', p);
    if (typeof item.description !== 'string' || item.description.length < 1 || item.description.length > 128) {
      throw bad('Описание позиции — от 1 до 128 символов', `${p}.description`);
    }
    const qty = parseQuantity(item.quantity, `${p}.quantity`);
    const price = parseAmount(item.amount, `${p}.amount`);
    if (!Number.isInteger(item.vat_code) || item.vat_code < 1 || item.vat_code > 12) throw bad('vat_code — от 1 до 12', `${p}.vat_code`);
    for (const f of ['payment_mode', 'payment_subject']) {
      if (item[f] !== undefined && (typeof item[f] !== 'string' || !/^[a-z_]{1,40}$/.test(item[f]))) throw bad(`Неверное ${f}`, `${p}.${f}`);
    }
    sumMilli += price * qty;
  });
  if (receipt.tax_system_code !== undefined && (!Number.isInteger(receipt.tax_system_code) || receipt.tax_system_code < 1 || receipt.tax_system_code > 6)) {
    throw bad('tax_system_code — от 1 до 6', `${parameter}.tax_system_code`);
  }
  if (sumMilli !== totalKopecks * 1000) {
    throw bad(`Сумма позиций чека (${formatValue(Math.round(sumMilli / 1000))}) не равна сумме (${formatValue(totalKopecks)})`, `${parameter}.items`);
  }
}

/** metadata: до 16 ключей, ключ до 32 символов, значение — строка до 512. */
export function checkMetadata(metadata) {
  if (metadata === undefined) return {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw bad('metadata — объект', 'metadata');
  const keys = Object.keys(metadata);
  if (keys.length > 16) throw bad('metadata — не больше 16 ключей', 'metadata');
  for (const k of keys) {
    const v = metadata[k];
    if (k.length > 32) throw bad('Ключ metadata длиннее 32 символов', 'metadata');
    if (typeof v !== 'string' || v.length > 512) throw bad('Значение metadata — строка до 512 символов', `metadata.${k}`);
  }
  return { ...metadata };
}

export function checkDescription(description) {
  if (description === undefined) return undefined;
  if (typeof description !== 'string' || description.length > 128) throw bad('description — строка до 128 символов', 'description');
  return description;
}
