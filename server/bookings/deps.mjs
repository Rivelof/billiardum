// Зависимости брони и листа ожидания от соседей (контракт M3 §3, M1 §13).
//
// Каждая функция берётся по отдельности: из ctx.bookingDeps (тесты), иначе из модуля соседа
// (динамический импорт), иначе — заглушка. Соседи M3 дописывают свои функции параллельно:
// пока функции нет, заглушка либо бросает not_configured (деньги и старт — без них нельзя),
// либо пишет предупреждение в лог (индикатор state.reserved — бронь всё равно держит интервал).
//
//   light  (server/sessions/api.mjs):  startFromBooking, setReserved, clearReserved, holdPending, releasePending
//   money  (server/payments/api.mjs):  createPrepayment, createBookingQuote, settlePrepayment, forfeitPrepayment, refund
//   tariffs (server/tariffs/index.mjs): amountFor, tariffContext; engine: ruleAt
//   core: audit.appendAudit, outbox, notify.send, alarms.raise, sse.publish — из ctx

import { BookingError } from './errors.mjs';

const MODULES = {
  light: '../sessions/api.mjs',
  payments: '../payments/api.mjs',
  tariffs: '../tariffs/index.mjs',
  engine: '../tariffs/engine.mjs',
  tournaments: '../tournaments/api.mjs',
  audit: '../lib/audit.mjs',
  alarms: '../alarms/index.mjs',
  notify: '../notify/index.mjs',
};

/** Необязательные функции соседей: есть — берутся, нет — модуль обходится своим способом. */
const OPTIONAL = {
  light: ['getResourceStatus', 'availabilityDuring'],
  payments: ['pendingPlayUntil'],
  tournaments: ['tournamentHolds'],
};

const NEED = {
  light: ['startFromBooking', 'setReserved', 'clearReserved', 'holdPending', 'releasePending'],
  payments: ['createPrepayment', 'createBookingQuote', 'settlePrepayment', 'forfeitPrepayment', 'refund'],
  tariffs: ['amountFor', 'tariffContext'],
  engine: ['ruleAt'],
};

async function tryImport(spec) {
  const url = new URL(spec, import.meta.url);
  try {
    return await import(url.href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(url.pathname)) return null;
    throw err;
  }
}

function notConfigured(owner, name) {
  return async () => {
    throw new BookingError('not_configured', `${owner}.${name} ещё нет`, 501);
  };
}

function softStub(log, owner, name) {
  return async (_db, args = {}) => {
    log?.warn?.('booking_dep_missing', { dep: `${owner}.${name}`, resource_id: args.resourceId ?? null });
    return null;
  };
}

/**
 * @param {object} ctx общий контекст сервера (§2.1) и необязательный ctx.bookingDeps
 * @returns {Promise<{ light, payments, tariffs, engine, audit, outbox, alarms, notify, sse, missing: string[] }>}
 */
export async function resolveDeps(ctx, log) {
  const override = ctx.bookingDeps ?? {};
  const out = {};
  const missing = [];
  for (const [group, names] of Object.entries({ ...NEED, tournaments: [] })) {
    const mod = await tryImport(MODULES[group]);
    const o = override[group] ?? {};
    out[group] = {};
    for (const name of names) {
      const fn = typeof o[name] === 'function' ? o[name] : typeof mod?.[name] === 'function' ? mod[name] : null;
      if (fn) {
        out[group][name] = fn;
      } else {
        missing.push(`${group}.${name}`);
        out[group][name] = group === 'light' && (name === 'setReserved' || name === 'clearReserved') ? softStub(log, group, name) : notConfigured(group, name);
      }
    }
    for (const name of OPTIONAL[group] ?? []) {
      const fn = typeof o[name] === 'function' ? o[name] : typeof mod?.[name] === 'function' ? mod[name] : null;
      if (fn) out[group][name] = fn;
    }
  }
  const audit = ctx.audit?.appendAudit ? ctx.audit : await tryImport(MODULES.audit);
  const alarms = ctx.alarms?.raise ? ctx.alarms : await tryImport(MODULES.alarms);
  const notify = ctx.notify?.send ? ctx.notify : await tryImport(MODULES.notify);
  if (!ctx.outbox?.enqueue || !ctx.outbox?.subscribe) throw new Error('ctx.outbox (core) обязателен: enqueue и subscribe');
  out.audit = audit;
  out.alarms = alarms ?? { raise: async () => null };
  out.notify = notify;
  out.outbox = ctx.outbox;
  out.sse = ctx.sse?.publish ? ctx.sse : { publish() {} };
  out.missing = missing;
  if (missing.length > 0) log?.warn?.('booking_deps_stubbed', { missing });
  return out;
}
