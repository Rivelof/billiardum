// Зависимости денежного модуля от core и light (контракт M1 §2.1, §13).
//
// Берутся из ctx (так их подменяют тесты), иначе — динамическим импортом модуля соседа.
// Пока модуля соседа нет (параллельная разработка), подставляется заглушка: журнал пишется
// напрямую в bl.audit_log (хеш считает база), тревоги и уведомления — в лог, SSE — молча.
// Без outbox (core) и API сессий (light) денежные операции невозможны: ошибка, откат.

const MODULES = {
  sessions: { spec: '../sessions/api.mjs', ctxKey: 'sessionsApi', need: ['getResourceByCode', 'getResourceStatus', 'holdPending', 'releasePending', 'getSessionForExtend'] },
  audit: { spec: '../lib/audit.mjs', ctxKey: 'audit', need: ['appendAudit'] },
  outbox: { spec: '../outbox.mjs', ctxKey: 'outbox', need: ['enqueue', 'subscribe'] },
  alarms: { spec: '../alarms/index.mjs', ctxKey: 'alarms', need: ['raise'] },
  notify: { spec: '../notify/index.mjs', ctxKey: 'notify', need: ['sendToClubStaff'] },
  sse: { spec: '../http/sse.mjs', ctxKey: 'sse', need: ['publish'] },
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

function missing(name) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        return () => {
          throw new Error(`зависимость ${name}.${String(prop)} недоступна (модуль соседа не подключён)`);
        };
      },
    },
  );
}

function stubs(log) {
  return {
    sessions: missing('sessions'),
    audit: { appendAudit: appendAuditDirect },
    outbox: missing('outbox'),
    alarms: {
      async raise(_db, clubId, { type, level, resourceId = null, data = {} }) {
        log?.error?.('alarm_unrouted', { club_id: clubId, type, level, resource_id: resourceId, data });
        return null;
      },
    },
    notify: {
      async send(_db, userId, { kind }) {
        log?.warn?.('notify_unrouted', { user_id: userId, kind });
      },
      async sendToClubStaff(_db, clubId, roles, { kind }) {
        log?.warn?.('notify_unrouted', { club_id: clubId, roles, kind });
      },
    },
    sse: { publish() {} },
  };
}

const usable = (candidate, need) => candidate && need.every((n) => typeof candidate[n] === 'function');

/**
 * @param {object} ctx общий контекст или контекст запроса
 * @returns {Promise<{ sessions, audit, outbox, alarms, notify, sse, clock, log, missing: string[] }>}
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
      chosen = fallback[name];
      out.missing.push(name);
    }
    out[name] = chosen;
  }
  out.clock = ctx.clock ?? { now: () => new Date() };
  out.log = log;
  return out;
}
