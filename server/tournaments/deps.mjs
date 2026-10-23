// Зависимости турниров от соседей (контракт M4 §3).
//
// Каждая функция берётся по отдельности: ctx.tournamentDeps (тесты) → модуль соседа
// (динамический импорт) → заглушка. Соседи M4 пишут свои функции параллельно; пока функции нет:
//
//   plus   (server/plus/api.mjs):     ratingOf(db, { userId, discipline }) → { rating, games, level }
//                                     заглушка — стартовый рейтинг 1 200 (PRODUCT §13) с предупреждением в лог;
//                                     playerCard(db, { userId, viewerId }) → { nick, … } — ник для сайта и ТВ;
//                                     заглушка — ника нет (наружу «Участник N»).
//   money  (server/payments/api.mjs): createTournamentFee(db, { clubId, tournamentId, entryId, amountKopecks,
//                                     customer, returnUrl, … }) → { payment, confirmation };
//                                     refundTournamentFee(db, { entryId, paymentId?, reason, reasonCode }) — возврат
//                                     взноса записи целиком; необязательная refund(db, { paymentId, … }) —
//                                     лишняя повторная оплата той же записи (только этот платёж)
//                                     заглушка — 501 not_configured (запись со взносом и возврат невозможны;
//                                     возврат стоит в outbox и повторяется, пока функция не появится).
//   light  (server/sessions/api.mjs): setReserved / clearReserved (source 'tournament', refId = match_id),
//                                     startFromTournament / stopFromTournament (№143); необязательная
//                                     extendFromTournament(db, { resourceId, matchId, until }).
//                                     Нет функции — предупреждение в лог, матч ждёт (повтор на тике).
//   core: audit.appendAudit, outbox, notify.send/sendToClubStaff, alarms.raise, sse.publish — из ctx.

import { TournamentError } from './errors.mjs';

const MODULES = {
  plus: '../plus/api.mjs',
  payments: '../payments/api.mjs',
  light: '../sessions/api.mjs',
  audit: '../lib/audit.mjs',
  alarms: '../alarms/index.mjs',
  notify: '../notify/index.mjs',
};

const NEED = {
  plus: ['ratingOf'],
  payments: ['createTournamentFee', 'refundTournamentFee'],
  light: ['setReserved', 'clearReserved', 'startFromTournament', 'stopFromTournament'],
};

const OPTIONAL = {
  plus: ['playerCard'],
  // Общий возврат money — только для лишней оплаты уже подтверждённой записи (ключ trn-<payment_id>).
  payments: ['refund'],
  light: ['extendFromTournament', 'getResourceStatus'],
};

export const START_RATING = 1200;

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
    throw new TournamentError('not_configured', `${owner}.${name} ещё нет`, 501);
  };
}

function stubRating(log) {
  return async (_db, { discipline } = {}) => {
    log?.warn?.('tournament_dep_missing', { dep: 'plus.ratingOf', discipline: discipline ?? null });
    return { rating: START_RATING, games: 0, level: 'amateur', stub: true };
  };
}

function softStub(log, owner, name) {
  return async () => {
    log?.warn?.('tournament_dep_missing', { dep: `${owner}.${name}` });
    throw new TournamentError('not_configured', `${owner}.${name} ещё нет`, 501);
  };
}

/**
 * @returns {Promise<{ plus, payments, light, audit, outbox, alarms, notify, sse, missing: string[] }>}
 */
export async function resolveDeps(ctx, log) {
  const override = ctx.tournamentDeps ?? {};
  const out = {};
  const missing = [];
  for (const [group, names] of Object.entries(NEED)) {
    const mod = await tryImport(MODULES[group]);
    const o = override[group] ?? {};
    out[group] = {};
    for (const name of names) {
      const fn = typeof o[name] === 'function' ? o[name] : typeof mod?.[name] === 'function' ? mod[name] : null;
      if (fn) {
        out[group][name] = fn;
        continue;
      }
      missing.push(`${group}.${name}`);
      if (group === 'plus') out[group][name] = stubRating(log);
      else if (group === 'light') out[group][name] = softStub(log, group, name);
      else out[group][name] = notConfigured(group, name);
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
  if (missing.length > 0) log?.warn?.('tournament_deps_stubbed', { missing });
  return out;
}
