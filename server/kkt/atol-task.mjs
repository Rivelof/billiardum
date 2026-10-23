// Задание АТОЛ (JSON-задание драйвера ДТО 10) из строки bl.receipts (контракт M2 §4: позиции
// с ценой, количеством, vat, paymentObject, paymentMethod; оплаты cash/electronically; кассир;
// система налогообложения клуба).
//
// Позиции чека в bl.receipts.items — в виде чека ЮKassa (так их пишет money M1):
//   { description, quantity, amount: { value: '1600.00', currency: 'RUB' }, vat_code, payment_mode,
//     payment_subject, measure? }
// amount.value — цена за единицу (как у ЮKassa); сумма позиции = цена × количество, до копейки.
// Поля АТОЛ, в которых нет уверенности, перечислены в tools/kkt-bridge/README.md («Сверить со Swagger»).

import { createHash } from 'node:crypto';

export class ReceiptDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReceiptDataError';
    this.code = 'invalid_receipt';
  }
}

/** vat_code ЮKassa → tax.type АТОЛ. 11 и 12 — НДС 22 % и 22/122 (с 2026 года). */
export const VAT_BY_CODE = Object.freeze({
  1: 'none',
  2: 'vat0',
  3: 'vat10',
  4: 'vat20',
  5: 'vat110',
  6: 'vat120',
  7: 'vat5',
  8: 'vat7',
  9: 'vat105',
  10: 'vat107',
  11: 'vat22',
  12: 'vat122',
});

/** tax_system_code ЮKassa → taxationType АТОЛ. */
export const TAXATION_BY_CODE = Object.freeze({
  1: 'osn',
  2: 'usnIncome',
  3: 'usnIncomeOutcome',
  4: 'envd',
  5: 'esn',
  6: 'patent',
});

/** payment_mode (ЮKassa, ФФД) → paymentMethod АТОЛ. */
export const PAYMENT_METHOD = Object.freeze({
  full_prepayment: 'fullPrepayment',
  partial_prepayment: 'prepayment',
  advance: 'advance',
  full_payment: 'fullPayment',
  partial_payment: 'partialPayment',
  credit: 'credit',
  credit_payment: 'creditPayment',
});

/** payment_subject (ЮKassa, ФФД) → paymentObject АТОЛ. */
export const PAYMENT_OBJECT = Object.freeze({
  commodity: 'commodity',
  excise: 'excise',
  job: 'job',
  service: 'service',
  gambling_bet: 'gamblingBet',
  gambling_prize: 'gamblingPrize',
  lottery: 'lottery',
  lottery_prize: 'lotteryPrize',
  intellectual_activity: 'intellectualActivity',
  payment: 'payment',
  agent_commission: 'agentCommission',
  composite: 'composite',
  another: 'another',
});

/**
 * Способ оплаты платежа → тип оплаты АТОЛ: наличные, безналичные (терминал банка) или
 * зачёт предоплаты (prepaid: чек зачёта брони, пакета часов, депозита — M3, decisions №52, №112).
 */
export const PAYMENT_TYPE = Object.freeze({
  cash: 'cash',
  card_terminal: 'electronically',
  card: 'electronically',
  sbp: 'electronically',
  prepayment: 'prepaid',
});

/** Признаки расчёта «предоплата» и «аванс»: такую позицию нельзя оплатить зачётом предоплаты. */
const PREPAYMENT_MODES = new Set(['fullPrepayment', 'prepayment', 'advance']);

export const MAX_OPERATOR = 64;
export const DEFAULT_OPERATOR = 'Кассир';

/** '1600.00' → 160000 копеек (строго: до двух знаков). */
export function parseRub(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = value.toFixed(2);
  if (typeof value !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(value)) throw new ReceiptDataError(`сумма ${value}`);
  const [r, k = ''] = value.split('.');
  return Number(r) * 100 + Number(k.padEnd(2, '0'));
}

/** Копейки → рубли числом с двумя знаками для JSON АТОЛ (1490.5). */
export function rub(kopecks) {
  return Math.round(kopecks) / 100;
}

/** Сумма позиции в копейках: цена × количество, округление до копейки «половина вверх». */
export function lineAmount(priceKopecks, quantity) {
  // Количество — до 3 знаков (вес): считаем в тысячных, без плавающей ошибки.
  const q = Math.round(quantity * 1000);
  return Math.floor((priceKopecks * q + 500) / 1000);
}

/** UUID задания АТОЛ: первая попытка — id чека (№78), следующая — детерминированно от id и номера. */
export function jobUuid(id, attempt) {
  if (attempt <= 1) return id;
  const h = createHash('sha256').update(`bl.kkt.job:${id}:${attempt}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Управляющие символы (код < 32) → пробел. */
export function withoutControl(text) {
  return [...String(text)].map((ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch)).join('');
}

export function operatorName(name) {
  const s = typeof name === 'string' ? withoutControl(name).trim() : '';
  return (s || DEFAULT_OPERATOR).slice(0, MAX_OPERATOR);
}

/**
 * Позиции чека → позиции АТОЛ и сумма.
 * @returns {{ items: object[], totalKopecks: number }}
 */
export function atolItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw new ReceiptDataError('позиции чека');
  let total = 0;
  const out = items.map((it, i) => {
    const name = typeof it.description === 'string' ? it.description.trim().slice(0, 128) : '';
    if (!name) throw new ReceiptDataError(`позиция ${i}: название`);
    const quantity = Number(it.quantity);
    if (!(quantity > 0) || quantity > 100000 || Math.round(quantity * 1000) !== quantity * 1000) throw new ReceiptDataError(`позиция ${i}: количество`);
    const price = parseRub(it.amount?.value);
    const tax = VAT_BY_CODE[it.vat_code];
    if (!tax) throw new ReceiptDataError(`позиция ${i}: vat_code ${it.vat_code}`);
    const paymentMethod = PAYMENT_METHOD[it.payment_mode ?? 'full_payment'];
    if (!paymentMethod) throw new ReceiptDataError(`позиция ${i}: payment_mode`);
    const paymentObject = PAYMENT_OBJECT[it.payment_subject ?? 'commodity'];
    if (!paymentObject) throw new ReceiptDataError(`позиция ${i}: payment_subject`);
    const amount = lineAmount(price, quantity);
    total += amount;
    const pos = {
      type: 'position',
      name,
      price: rub(price),
      quantity,
      amount: rub(amount),
      tax: { type: tax },
      paymentMethod,
      paymentObject,
      measurementUnit: typeof it.measure === 'string' && /^[a-z]{1,20}$/.test(it.measure) ? it.measure : 'piece',
    };
    return pos;
  });
  return { items: out, totalKopecks: total };
}

/**
 * JSON-задание чека АТОЛ.
 * @param {{ kind: 'sale'|'refund', items: object[], amountKopecks: number, taxSystemCode: number|null,
 *           payments: { method: string, amount_kopecks: number }[], operatorName?: string|null }} r
 */
export function receiptTask({ kind, items, amountKopecks, taxSystemCode, payments, operatorName: op }) {
  const { items: positions, totalKopecks } = atolItems(items);
  // Зачёт предоплаты покрывает только позиции «полный расчёт» (и частичный расчёт, кредит):
  // аванс авансом не оплачивается.
  const settleable = positions.reduce((a, pos) => (PREPAYMENT_MODES.has(pos.paymentMethod) ? a : a + Math.round(pos.amount * 100)), 0);
  if (totalKopecks !== Number(amountKopecks)) throw new ReceiptDataError(`сумма позиций ${totalKopecks} ≠ сумма чека ${amountKopecks}`);
  if (!Array.isArray(payments) || payments.length === 0) throw new ReceiptDataError('оплаты');
  const byType = new Map();
  for (const p of payments) {
    const type = PAYMENT_TYPE[p.method];
    const amount = Number(p.amount_kopecks);
    if (!type || !Number.isSafeInteger(amount) || amount <= 0) throw new ReceiptDataError(`оплата ${p.method}`);
    byType.set(type, (byType.get(type) ?? 0) + amount);
  }
  const paid = [...byType.values()].reduce((a, b) => a + b, 0);
  if (paid !== totalKopecks) throw new ReceiptDataError(`оплаты ${paid} ≠ сумма чека ${totalKopecks}`);
  const prepaid = byType.get('prepaid') ?? 0;
  if (prepaid > settleable) throw new ReceiptDataError(`зачёт предоплаты ${prepaid} больше позиций «полный расчёт» ${settleable}`);
  const task = {
    type: kind === 'refund' ? 'sellReturn' : 'sell',
    electronically: false,
    operator: { name: operatorName(op) },
    items: positions,
    payments: [...byType.entries()].map(([type, sum]) => ({ type, sum: rub(sum) })),
    total: rub(totalKopecks),
  };
  if (taxSystemCode != null) {
    const t = TAXATION_BY_CODE[taxSystemCode];
    if (!t) throw new ReceiptDataError(`tax_system_code ${taxSystemCode}`);
    task.taxationType = t;
  }
  return task;
}

/**
 * Нефискальный документ «ТЕСТ» вместо чека (M5.1 №153): продажа в тестовом режиме клуба —
 * денег нет, фискального чека нет. Позиции и итог печатаются для проверки ККТ и бумаги.
 * @param {{ kind: 'sale'|'refund', items: object[], amountKopecks: number, operatorName?: string|null }} r
 */
export function testReceiptTask({ kind, items, amountKopecks, operatorName: op }) {
  const { items: positions, totalKopecks } = atolItems(items);
  if (totalKopecks !== Number(amountKopecks)) throw new ReceiptDataError(`сумма позиций ${totalKopecks} ≠ сумма чека ${amountKopecks}`);
  const money = (k) => `${Math.floor(k / 100)},${String(k % 100).padStart(2, '0')}`;
  const lines = [
    { type: 'text', text: 'ТЕСТ', alignment: 'center', doubleWidth: true, doubleHeight: true },
    { type: 'text', text: 'Тестовый режим клуба. Не чек: денег нет', alignment: 'center' },
    { type: 'text', text: kind === 'refund' ? 'Возврат' : 'Продажа', alignment: 'left' },
    ...positions.map((p) => ({ type: 'text', text: `${p.name.slice(0, 40)} ${p.quantity} × ${money(Math.round(p.price * 100))}`, alignment: 'left' })),
    { type: 'text', text: `Итого ${money(totalKopecks)} ₽`, alignment: 'left' },
    { type: 'text', text: `Кассир: ${operatorName(op)}`, alignment: 'left' },
    { type: 'text', text: 'ТЕСТ', alignment: 'center', doubleWidth: true },
  ];
  return { type: 'nonFiscal', items: lines, printFooter: false };
}

/**
 * Отчёт о закрытии смены тестового режима клуба (M5.1 №153) — нефискальный «ТЕСТ»: смена ККТ в
 * тестовом режиме не открывается и не закрывается, фискальных документов нет.
 * @param {{ number?: number|null, operatorName?: string|null, sales?: { count: number, kopecks: number }|null }} r
 */
export function testShiftReportTask({ number = null, operatorName: op = null, sales = null } = {}) {
  const money = (k) => `${Math.floor(k / 100)},${String(k % 100).padStart(2, '0')}`;
  const lines = [
    { type: 'text', text: 'ТЕСТ', alignment: 'center', doubleWidth: true, doubleHeight: true },
    { type: 'text', text: 'Тестовый режим клуба', alignment: 'center' },
    { type: 'text', text: 'Отчёт о закрытии смены. Не фискальный', alignment: 'center' },
    ...(Number.isInteger(number) ? [{ type: 'text', text: `Смена №${number}`, alignment: 'left' }] : []),
    ...(sales ? [{ type: 'text', text: `Тестовых продаж: ${sales.count} на ${money(sales.kopecks)} ₽`, alignment: 'left' }] : []),
    { type: 'text', text: `Кассир: ${operatorName(op)}`, alignment: 'left' },
    { type: 'text', text: 'ТЕСТ', alignment: 'center', doubleWidth: true },
  ];
  return { type: 'nonFiscal', items: lines, printFooter: false };
}

/** Задание смены ККТ. */
export function shiftTask(kind, name) {
  return { type: kind === 'open_shift' ? 'openShift' : 'closeShift', operator: { name: operatorName(name) } };
}
