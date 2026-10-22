// Деньги бара в целых копейках (инвариант 10): скидка, её раскладка по строкам, позиции
// чека 54-ФЗ, доли возврата. Чистые функции без базы.
//
// * Скидка процентом округляется один раз, «половина вверх»; сумма — копейки как есть.
// * Раскладка скидки по строкам — пропорционально суммам строк, методом наибольшего остатка:
//   доли в сумме дают скидку ровно до копейки.
// * Позиция чека: цена за единицу × количество. Если сумма строки после скидки не делится
//   на количество, строка делится на две с ценами q+1 и q (Σ = сумма строки до копейки).
// * Возврат k единиц строки: единица i стоит q + (i < r ? 1 : 0), где q = A div n, r = A mod n;
//   возвращаются последние ещё не возвращённые единицы — все возвраты строки дают ровно A.

import { formatValue } from '../payments/yookassa.mjs';

const big = (v) => BigInt(v);

/** round(a × b / c), «половина вверх» (от нуля), целые BigInt, c > 0. */
export function mulDivRound(a, b, c) {
  const A = big(a);
  const B = big(b);
  const C = big(c);
  if (C <= 0n) throw new RangeError('mulDivRound: делитель > 0');
  const n = A * B;
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const q = (abs * 2n + C) / (2n * C);
  return neg ? -q : q;
}

/**
 * Скидка в копейках. discount: { percent } (целое 1…100) или { amount_kopecks } (целое ≥ 1).
 * @returns {number}
 */
export function discountKopecks(discount, subtotal) {
  if (discount == null) return 0;
  if (typeof discount !== 'object' || Array.isArray(discount)) throw new RangeError('discount');
  const hasPercent = discount.percent !== undefined && discount.percent !== null;
  const hasAmount = discount.amount_kopecks !== undefined && discount.amount_kopecks !== null;
  if (hasPercent === hasAmount) {
    if (!hasPercent) return 0;
    throw new RangeError('discount: percent или amount_kopecks');
  }
  if (hasPercent) {
    const p = discount.percent;
    if (!Number.isInteger(p) || p < 0 || p > 100) throw new RangeError('discount.percent');
    return Number(mulDivRound(subtotal, p, 100));
  }
  const a = discount.amount_kopecks;
  if (!Number.isSafeInteger(a) || a < 0) throw new RangeError('discount.amount_kopecks');
  if (a > subtotal) throw new RangeError('discount больше суммы');
  return a;
}

/** Скидка выше лимита процентов клуба (ровно лимит — в пределах). */
export function overLimit(discount, subtotal, limitPercent) {
  if (discount <= 0) return false;
  return big(discount) * 100n > big(limitPercent) * big(subtotal);
}

/**
 * Разложить total по весам пропорционально, методом наибольшего остатка (ничья — раньше строка).
 * Σ результата = total; каждая доля ≤ своего веса при total ≤ Σ весов.
 * @param {number} total
 * @param {number[]} weights
 * @returns {number[]}
 */
export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('allocate: total');
  const sum = weights.reduce((s, w) => s + big(w), 0n);
  if (total === 0 || weights.length === 0) return weights.map(() => 0);
  if (sum <= 0n) throw new RangeError('allocate: сумма весов');
  const T = big(total);
  const parts = weights.map((w) => (T * big(w)) / sum);
  const rems = weights.map((w, i) => ({ i, r: (T * big(w)) % sum }));
  let left = T - parts.reduce((s, p) => s + p, 0n);
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of rems) {
    if (left <= 0n) break;
    parts[i] += 1n;
    left -= 1n;
  }
  return parts.map(Number);
}

/** Цены единиц строки: [q+1 × r, q × (n−r)]. */
export function unitSplit(amount, qty) {
  const q = Math.floor(amount / qty);
  const r = amount - q * qty;
  return { q, r };
}

/** Сумма k единиц строки (amount за qty), если уже возвращено m последних единиц. */
export function refundAmount(amount, qty, alreadyQty, k) {
  if (!Number.isInteger(k) || k < 1 || alreadyQty + k > qty) throw new RangeError('refundAmount: количество');
  const { q, r } = unitSplit(amount, qty);
  let sum = 0;
  for (let i = qty - alreadyQty - k; i < qty - alreadyQty; i += 1) sum += q + (i < r ? 1 : 0);
  return sum;
}

/** Единицы [from, to) строки, сгруппированные по цене: [{ qty, price }]. */
export function unitGroups(amount, qty, from, to) {
  const { q, r } = unitSplit(amount, qty);
  const hi = Math.max(0, Math.min(to, r) - from);
  const lo = to - from - hi;
  const out = [];
  if (hi > 0) out.push({ qty: hi, price: q + 1 });
  if (lo > 0) out.push({ qty: lo, price: q });
  return out;
}

/**
 * Позиции чека 54-ФЗ (формат позиций ЮKassa и bl.receipts.items M1) из строк продажи.
 * @param {{ name: string, qty: number, amount_kopecks: number, vat_code: number, payment_subject: string,
 *           from?: number, to?: number }[]} rows from/to — единицы строки (по умолчанию все)
 */
export function receiptLines(rows) {
  const lines = [];
  for (const row of rows) {
    const from = row.from ?? 0;
    const to = row.to ?? row.qty;
    for (const g of unitGroups(row.amount_kopecks, row.qty, from, to)) {
      if (g.price <= 0) throw new RangeError('позиция чека с нулевой ценой');
      lines.push({
        description: String(row.name).slice(0, 128),
        quantity: g.qty,
        amount: { value: formatValue(g.price), currency: 'RUB' },
        vat_code: row.vat_code,
        payment_mode: 'full_payment',
        payment_subject: row.payment_subject,
      });
    }
  }
  return lines;
}

/** Сумма позиций чека в копейках (для проверки «до копейки»). */
export function linesTotal(lines) {
  let total = 0;
  for (const l of lines) {
    const [rub, kop = ''] = l.amount.value.split('.');
    total += (Number(rub) * 100 + Number(kop.padEnd(2, '0'))) * Number(l.quantity);
  }
  return total;
}

/** 15000 → «150,00 ₽» (для текстов уведомлений). */
export function rub(kopecks) {
  const [r, k] = formatValue(kopecks).split('.');
  return `${r.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${k} ₽`;
}
