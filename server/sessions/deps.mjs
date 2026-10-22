// Зависимости модуля light от core и money (контракт M1 §2.1, §13).
//
// Берутся из ctx (так их подменяют тесты), иначе — динамическим импортом модуля соседа.
// Если модуля соседа ещё нет (параллельная разработка), подставляется заглушка: журнал пишется
// напрямую в bl.audit_log (хеш считает база), тревоги и уведомления — в лог с уровнем error/warn,
// SSE — молча. Возврат денег без money невозможен: заглушка бросает ошибку, транзакция
// откатывается, outbox повторит событие.

const OPTIONAL = {
  audit: '../lib/audit.mjs',
  alarms: '../alarms/index.mjs',
  notify: '../notify/index.mjs',
  sse: '../http/sse.mjs',
  tariffs: '../tariffs/index.mjs',
  payments: '../payments/api.mjs',
  bookings: '../bookings/api.mjs',
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

/** Запись журнала без core: обычный INSERT, seq/prev_hash/hash ставит триггер (decisions №13). */
export async function appendAuditDirect(db, { action, objectType = null, objectId = null, reason = null, data = {}, actorType = null, actorId = null }) {
  const { rows } = await db.query(
    `insert into bl.audit_log (club_id, actor_type, actor_id, action, object_type, object_id, reason, data)
     values (bl.ctx_club_id(), coalesce($1, bl.ctx_actor_type(), 'system'), $2, $3, $4, $5, $6, $7::jsonb)
     returning id, seq, hash`,
    [actorType, actorId, action, objectType, objectId, reason, JSON.stringify(data ?? {})],
  );
  return { id: rows[0].id, seq: Number(rows[0].seq), hash: rows[0].hash };
}

function stubs(log) {
  return {
    audit: { appendAudit: appendAuditDirect },
    alarms: {
      async raise(_db, clubId, { type, level, resourceId = null, data = {} }) {
        log.error('alarm_unrouted', { club_id: clubId, type, level, resource_id: resourceId, data });
        return null;
      },
    },
    notify: {
      async send(_db, userId, { kind }) {
        log.warn('notify_unrouted', { user_id: userId, kind });
      },
      async sendToClubStaff(_db, clubId, roles, { kind }) {
        log.warn('notify_unrouted', { club_id: clubId, roles, kind });
      },
    },
    sse: { publish() {} },
    tariffs: {
      async amountForActual() {
        throw new Error('server/tariffs/index.mjs (money) недоступен');
      },
    },
    payments: {
      async refund() {
        throw new Error('server/payments/api.mjs (money) недоступен');
      },
    },
    // Без модуля брони (M3) броней нет: предел продления не ограничен.
    bookings: { async nextBookingStart() { return null; } },
  };
}

function pick(fromCtx, fromModule, fallback, names) {
  for (const candidate of [fromCtx, fromModule]) {
    if (candidate && names.every((n) => typeof candidate[n] === 'function')) return candidate;
  }
  return fallback;
}

/**
 * @param {object} ctx общий контекст (§2.1): outbox обязателен, остальное — по возможности.
 * @returns {Promise<{ audit, outbox, alarms, notify, sse, tariffs, payments, missing: string[] }>}
 */
export async function resolveDeps(ctx, log) {
  const fallback = stubs(log);
  const missing = [];
  const out = {};
  const need = {
    audit: ['appendAudit'],
    alarms: ['raise'],
    notify: ['send'],
    sse: ['publish'],
    tariffs: ['amountForActual'],
    payments: ['refund'],
    bookings: ['nextBookingStart'],
  };
  const ctxKey = { audit: 'audit', alarms: 'alarms', notify: 'notify', sse: 'sse', tariffs: 'tariffs', payments: 'paymentsApi', bookings: 'bookingsApi' };
  for (const [name, spec] of Object.entries(OPTIONAL)) {
    const fromCtx = ctx[ctxKey[name]];
    const fromModule = fromCtx ? null : await tryImport(spec);
    const chosen = pick(fromCtx, fromModule, fallback[name], need[name]);
    if (chosen === fallback[name]) missing.push(name);
    out[name] = chosen;
  }
  if (!ctx.outbox || typeof ctx.outbox.enqueue !== 'function' || typeof ctx.outbox.subscribe !== 'function') {
    throw new Error('ctx.outbox (core) обязателен: enqueue и subscribe');
  }
  out.outbox = ctx.outbox;
  if (missing.length > 0) log.warn('light_deps_stubbed', { missing });
  return { ...out, missing };
}
