// Зависимости Бильярдум+ от соседей (контракт M4 §3).
//
// Каждая функция — из ctx.plusDeps (тесты), иначе из модуля соседа (динамический импорт), иначе
// заглушка: без light партию засчитать нельзя (not_configured), без брони — приглашение не
// принимается (not_configured), без функции турниров — данные берутся из события.
//
//   light       (server/sessions/api.mjs):    sessionOf, sessionParticipants
//   bookings    (server/bookings/api.mjs):    createBooking
//   tournaments (server/tournaments/api.mjs): matchForRating (необязательно)
//   core: audit.appendAudit, outbox, notify.send / sendToClubStaff, sse.publish — из ctx

import { PlusError } from './errors.mjs';

const MODULES = {
  light: '../sessions/api.mjs',
  bookings: '../bookings/api.mjs',
  tournaments: '../tournaments/api.mjs',
  audit: '../lib/audit.mjs',
  notify: '../notify/index.mjs',
  outbox: '../outbox.mjs',
};

const NEED = {
  light: ['sessionOf', 'sessionParticipants'],
  bookings: ['createBooking'],
};
const OPTIONAL = {
  tournaments: ['matchForRating'],
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
    throw new PlusError('not_configured', `${owner}.${name} ещё нет`, 501);
  };
}

/**
 * @param {object} ctx общий контекст сервера (§2.1) и необязательный ctx.plusDeps
 * @returns {Promise<{ light, bookings, tournaments, audit, notify, outbox, sse, missing: string[] }>}
 */
export async function resolveDeps(ctx = {}, log = null) {
  const override = ctx.plusDeps ?? {};
  const out = {};
  const missing = [];
  for (const [group, names] of Object.entries(NEED)) {
    const mod = await tryImport(MODULES[group]);
    const o = override[group] ?? {};
    out[group] = {};
    for (const name of names) {
      const fn = typeof o[name] === 'function' ? o[name] : typeof mod?.[name] === 'function' ? mod[name] : null;
      if (fn) out[group][name] = fn;
      else {
        missing.push(`${group}.${name}`);
        out[group][name] = notConfigured(group, name);
      }
    }
  }
  for (const [group, names] of Object.entries(OPTIONAL)) {
    const mod = await tryImport(MODULES[group]);
    const o = override[group] ?? {};
    out[group] = {};
    for (const name of names) {
      const fn = typeof o[name] === 'function' ? o[name] : typeof mod?.[name] === 'function' ? mod[name] : null;
      if (fn) out[group][name] = fn;
    }
  }
  out.audit = ctx.audit?.appendAudit ? ctx.audit : await tryImport(MODULES.audit);
  out.notify = ctx.notify?.send ? ctx.notify : await tryImport(MODULES.notify);
  out.outbox = ctx.outbox?.enqueue ? ctx.outbox : await tryImport(MODULES.outbox);
  out.sse = ctx.sse?.publish ? ctx.sse : { publish() {} };
  out.missing = missing;
  if (missing.length > 0) log?.warn?.('plus_deps_stubbed', { missing });
  return out;
}
