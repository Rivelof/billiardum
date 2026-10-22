// Сверка за смену (PRODUCT §4.2, §8.7): сумма чеков ККТ против продаж в системе и онлайн-оплаты
// против ЮKassa — до копейки.
//
// ККТ: платежи смены наличными и через терминал (method cash, card_terminal) против пробитых
// чеков ККТ этих платежей (bl.receipts channel kkt, kind sale, printed) по типу оплаты в задании;
// возвраты — против чеков возврата. Платёж без пробитого чека — в списке missing (чек в очереди,
// с ошибкой или его нет).
// Онлайн: каждый платёж ЮKassa смены (СБП, карта) запрашивается по API ключами клуба (функции
// money: loadPaymentSettings, clientFor) — статус и сумма; возвраты ЮKassa — так же.

import { clientFor, loadPaymentSettings } from '../payments/settings.mjs';
import { amountKopecks } from '../payments/yookassa.mjs';

const KKT_METHODS = ['cash', 'card_terminal'];
export const MAX_ONLINE_CHECKS = 500;
const CONCURRENCY = 4;

const zero = () => ({ cash: 0, card_terminal: 0 });

/** Сверка чеков ККТ с продажами смены. */
export async function reconcileKkt(db, { clubId, payments, refunds }) {
  const sysSales = zero();
  const sysRefunds = zero();
  const pays = payments.filter((p) => KKT_METHODS.includes(p.method) && p.status === 'succeeded');
  for (const p of pays) sysSales[p.method] += p.counted_kopecks;
  const refs = refunds.filter((f) => KKT_METHODS.includes(f.method));
  for (const f of refs) sysRefunds[f.method] += f.amount_kopecks;

  const ids = pays.map((p) => p.id);
  const refundIds = refs.map((f) => f.id);
  const { rows } = await db.query(
    `select id, kind, status, amount_kopecks, payment_id, refund_id, kkt_job, fd
       from bl.receipts
      where club_id = $1 and channel = 'kkt'
        and ((kind = 'sale' and payment_id = any($2::uuid[])) or (kind = 'refund' and refund_id = any($3::uuid[])))`,
    [clubId, ids, refundIds],
  );
  const kktSales = zero();
  const kktRefunds = zero();
  const states = { printed: { count: 0, amount_kopecks: 0 }, pending: { count: 0, amount_kopecks: 0 }, unknown: { count: 0, amount_kopecks: 0 }, failed: { count: 0, amount_kopecks: 0 } };
  const printedSale = new Set();
  const printedRefund = new Set();
  const methodOf = new Map(pays.map((p) => [p.id, p.method]));
  for (const f of refs) methodOf.set(`r:${f.id}`, f.method);
  for (const r of rows) {
    const amount = Number(r.amount_kopecks);
    const state = r.status === 'printed' ? 'printed' : r.status === 'failed' ? 'failed' : r.kkt_job?.state === 'lost' ? 'unknown' : r.status === 'receipt_pending' ? 'pending' : null;
    if (!state) continue;
    states[state].count += 1;
    states[state].amount_kopecks += amount;
    if (state !== 'printed') continue;
    const target = r.kind === 'refund' ? kktRefunds : kktSales;
    const jobPays = Array.isArray(r.kkt_job?.payments) && r.kkt_job.payments.length > 0
      ? r.kkt_job.payments
      : [{ method: methodOf.get(r.kind === 'refund' ? `r:${r.refund_id}` : r.payment_id), amount_kopecks: amount }];
    for (const jp of jobPays) if (jp.method in target) target[jp.method] += Number(jp.amount_kopecks);
    if (r.kind === 'refund') printedRefund.add(r.refund_id);
    else printedSale.add(r.payment_id);
  }
  const missing = pays.filter((p) => !printedSale.has(p.id)).map((p) => ({ payment_id: p.id, method: p.method, amount_kopecks: p.counted_kopecks }));
  const missingRefunds = refs.filter((f) => !printedRefund.has(f.id)).map((f) => ({ refund_id: f.id, method: f.method, amount_kopecks: f.amount_kopecks }));
  const diff = {};
  for (const m of KKT_METHODS) diff[m] = sysSales[m] - sysRefunds[m] - (kktSales[m] - kktRefunds[m]);
  const sys = KKT_METHODS.reduce((a, m) => a + sysSales[m] - sysRefunds[m], 0);
  const kkt = KKT_METHODS.reduce((a, m) => a + kktSales[m] - kktRefunds[m], 0);
  return {
    ok: sys === kkt && missing.length === 0 && missingRefunds.length === 0,
    system_kopecks: sys,
    kkt_kopecks: kkt,
    diff_kopecks: sys - kkt,
    by_method: Object.fromEntries(
      KKT_METHODS.map((m) => [m, { sales_kopecks: sysSales[m], refunds_kopecks: sysRefunds[m], kkt_sales_kopecks: kktSales[m], kkt_refunds_kopecks: kktRefunds[m], diff_kopecks: diff[m] }]),
    ),
    receipts: states,
    missing: missing.slice(0, 100),
    missing_refunds: missingRefunds.slice(0, 100),
    missing_count: missing.length + missingRefunds.length,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i;
      i += 1;
      out[k] = await fn(items[k]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Сверка онлайн-оплат смены с ЮKassa.
 * @param {{ clubId: string, payments: object[], refunds: object[], moneyConfig: object, fetch?: Function }} args
 */
export async function reconcileOnline(db, { clubId, payments, refunds, moneyConfig, fetch }) {
  const online = payments.filter((p) => p.provider === 'yookassa' && p.provider_payment_id);
  const onlineRefunds = refunds.filter((f) => f.provider === 'yookassa' && f.provider_refund_id);
  const systemKopecks = online.reduce((a, p) => a + p.counted_kopecks, 0);
  const systemRefunds = onlineRefunds.reduce((a, f) => a + f.amount_kopecks, 0);
  const base = { system_kopecks: systemKopecks, system_refunds_kopecks: systemRefunds, payments: online.length, refunds: onlineRefunds.length };
  if (online.length === 0 && onlineRefunds.length === 0) {
    return { ok: true, status: 'checked', ...base, yookassa_kopecks: 0, yookassa_refunds_kopecks: 0, diff_kopecks: 0, mismatches: [] };
  }
  if (online.length + onlineRefunds.length > MAX_ONLINE_CHECKS) return { ok: false, status: 'too_many', ...base, mismatches: [] };
  const settings = await loadPaymentSettings(db, clubId);
  if (!settings.online) return { ok: false, status: 'not_configured', ...base, mismatches: [] };
  let client;
  try {
    client = clientFor(settings, moneyConfig, fetch ? { fetch } : {});
  } catch {
    return { ok: false, status: 'not_configured', ...base, mismatches: [] };
  }
  const mismatches = [];
  let unavailable = 0;
  let ykKopecks = 0;
  let ykRefunds = 0;
  await mapLimit(online, CONCURRENCY, async (p) => {
    let remote;
    try {
      remote = await client.getPayment(p.provider_payment_id);
    } catch (err) {
      if (err?.retryable) unavailable += 1;
      else mismatches.push({ payment_id: p.id, reason: 'not_found_in_yookassa' });
      return;
    }
    const amount = amountKopecks(remote.amount);
    if (remote.status === 'succeeded' && amount !== null) ykKopecks += amount;
    const expectedStatus = p.status;
    if (remote.status !== expectedStatus) mismatches.push({ payment_id: p.id, reason: 'status', system: expectedStatus, yookassa: String(remote.status).slice(0, 30) });
    else if (expectedStatus === 'succeeded' && amount !== p.counted_kopecks) mismatches.push({ payment_id: p.id, reason: 'amount', system_kopecks: p.counted_kopecks, yookassa_kopecks: amount });
    else if (expectedStatus === 'waiting_for_capture' && amount !== p.amount_kopecks) mismatches.push({ payment_id: p.id, reason: 'amount', system_kopecks: p.amount_kopecks, yookassa_kopecks: amount });
    if (remote.metadata?.club_id && remote.metadata.club_id !== clubId) mismatches.push({ payment_id: p.id, reason: 'club' });
  });
  await mapLimit(onlineRefunds, CONCURRENCY, async (f) => {
    let remote;
    try {
      remote = await client.getRefund(f.provider_refund_id);
    } catch (err) {
      if (err?.retryable) unavailable += 1;
      else mismatches.push({ refund_id: f.id, reason: 'not_found_in_yookassa' });
      return;
    }
    const amount = amountKopecks(remote.amount);
    if (remote.status === 'succeeded' && amount !== null) ykRefunds += amount;
    if (remote.status !== 'succeeded') mismatches.push({ refund_id: f.id, reason: 'status', system: f.status, yookassa: String(remote.status).slice(0, 30) });
    else if (amount !== f.amount_kopecks) mismatches.push({ refund_id: f.id, reason: 'amount', system_kopecks: f.amount_kopecks, yookassa_kopecks: amount });
  });
  if (unavailable > 0) return { ok: false, status: 'unavailable', ...base, unavailable, mismatches: mismatches.slice(0, 100) };
  const diff = systemKopecks - systemRefunds - (ykKopecks - ykRefunds);
  return {
    ok: diff === 0 && mismatches.length === 0,
    status: 'checked',
    ...base,
    yookassa_kopecks: ykKopecks,
    yookassa_refunds_kopecks: ykRefunds,
    diff_kopecks: diff,
    mismatches: mismatches.slice(0, 100),
  };
}
