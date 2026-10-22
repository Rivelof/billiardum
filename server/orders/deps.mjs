// Зависимости модулей бара и кассы (backend-pos) от core, money и kkt (контракты M1 §13, M2 §5).
//
// Берутся из ctx (так их подменяют тесты), иначе — динамическим импортом модуля соседа.
// Пока модуля соседа нет (параллельная разработка M2), подставляется заглушка:
//   * kkt (enqueueReceipt) — строка bl.receipts channel kkt, receipt_pending: её заберёт
//     server/kkt/, как чеки заявок стола M1 (decisions №84);
//   * shifts (currentShift) — смены нет: касса отвечает shift_closed (безопасно);
//   * тревоги и уведомления — в лог, SSE — молча.
// Журнал и outbox нужны всегда: без них денежная операция невозможна (ошибка, откат).

import { resolveDeps as resolveMoneyDeps } from '../payments/deps.mjs';
import { moneyConfig } from '../payments/config.mjs';

const MODULES = {
  audit: { spec: '../lib/audit.mjs', ctxKey: 'audit', need: ['appendAudit'] },
  outbox: { spec: '../outbox.mjs', ctxKey: 'outbox', need: ['enqueue'] },
  alarms: { spec: '../alarms/index.mjs', ctxKey: 'alarms', need: ['raise'] },
  notify: { spec: '../notify/index.mjs', ctxKey: 'notify', need: ['sendToClubStaff'] },
  sse: { spec: '../http/sse.mjs', ctxKey: 'sse', need: ['publish'] },
  kkt: { spec: '../kkt/api.mjs', ctxKey: 'kktApi', need: ['enqueueReceipt'] },
  shifts: { spec: '../shifts/api.mjs', ctxKey: 'shiftsApi', need: ['currentShift'] },
};

const imported = new Map();

async function tryImport(spec) {
  if (imported.has(spec)) return imported.get(spec);
  const url = new URL(spec, import.meta.url);
  let mod = null;
  try {
    mod = await import(url.href);
  } catch (err) {
    if (!(err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(url.pathname))) throw err;
  }
  imported.set(spec, mod);
  return mod;
}

/**
 * Задание на чек ККТ без модуля kkt: строка bl.receipts (receipt_pending), формат позиций —
 * как у чеков M1 (bl.receipts.items, позиции ЮKassa). Возвращает id чека.
 */
export async function enqueueReceiptDirect(db, { clubId, kind, lines, paymentId = null, refundId = null, amountKopecks, taxSystemCode = null, at }) {
  const { rows } = await db.query(
    `insert into bl.receipts (club_id, payment_id, refund_id, kind, channel, status, amount_kopecks, items, tax_system_code, created_at, updated_at)
     values ($1, $2, $3, $4, 'kkt', 'receipt_pending', $5, $6::jsonb, $7, $8, $8)
     returning id`,
    [clubId, paymentId, refundId, kind === 'sell_refund' ? 'refund' : 'sale', amountKopecks, JSON.stringify(lines), taxSystemCode, at],
  );
  return rows[0].id;
}

function stubs(log) {
  return {
    alarms: {
      async raise(_db, clubId, { type, level }) {
        log?.error?.('alarm_unrouted', { club_id: clubId, type, level });
        return null;
      },
    },
    notify: {
      async sendToClubStaff(_db, clubId, roles, { kind }) {
        log?.warn?.('notify_unrouted', { club_id: clubId, roles, kind });
      },
    },
    sse: { publish() {} },
    kkt: { enqueueReceipt: null },
    shifts: {
      async currentShift() {
        return null;
      },
    },
  };
}

const usable = (candidate, need) => candidate && need.every((n) => typeof candidate[n] === 'function');

/**
 * @param {object} ctx общий контекст сервера или контекст запроса
 * @returns {Promise<object>} { audit, outbox, alarms, notify, sse, kkt, shifts, money, moneyConfig, clock, log, missing }
 */
export async function resolveDeps(ctx = {}) {
  const log = ctx.log ?? { debug() {}, info() {}, warn() {}, error() {} };
  const fallback = stubs(log);
  const out = { missing: [] };
  for (const [name, { spec, ctxKey, need }] of Object.entries(MODULES)) {
    let chosen = ctx[ctxKey];
    if (!usable(chosen, need)) {
      const mod = await tryImport(spec);
      chosen = usable(mod, need) ? mod : null;
    }
    if (!chosen) {
      if (!fallback[name]) throw new Error(`зависимость ${name} недоступна`);
      chosen = fallback[name];
      out.missing.push(name);
    }
    out[name] = chosen;
  }
  out.clock = ctx.clock ?? { now: () => new Date() };
  out.log = log;
  out.money = await resolveMoneyDeps(ctx);
  out.moneyConfig = moneyConfig(ctx);
  out.publicHost = ctx.config?.publicHost ?? process.env.PUBLIC_HOST ?? 'localhost:8443';
  // Своя транзакция вне транзакции запроса (тревога о промахах поиска гостя, №121).
  out.pool = ctx.pool ?? null;
  out.withContext = ctx.withContext ?? null;
  return out;
}
