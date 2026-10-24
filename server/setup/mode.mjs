// Режим клуба и ручные действия мастера подключения (M5.1 №153, №155, №156; backend-B).
//
// Режим test | live делает backend-A (clubs.mode, ctx.clubMode, app.club_mode). Режим читается
// так: ctx (clubMode или club.mode) → настройка транзакции app.club_mode →
// столбец bl.clubs.mode → 'test'. В боевом режиме (live или приостановлен после live —
// isLiveClub, server/lib/club-mode.mjs) изменения зала и тарифа — ручное действие (инвариант 8):
// причина обязательна, запись manual.* в журнал и тревога manual_action владельцу и
// управляющему (уведомление при каждом действии, №66).

import { HttpError } from '../http/errors.mjs';
import { raise } from '../alarms/index.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { isLiveClub } from '../lib/club-mode.mjs';

export const MODES = ['test', 'live'];
export const MAX_REASON_LEN = 500;

let modeColumn = null;

/** Есть ли столбец bl.clubs.mode (миграция backend-A); кэш на процесс после первого «есть». */
async function hasModeColumn(db) {
  if (modeColumn === true) return true;
  const { rows } = await db.query(
    "select exists (select 1 from information_schema.columns where table_schema = 'bl' and table_name = 'clubs' and column_name = 'mode') as ok",
  );
  if (rows[0].ok) modeColumn = true;
  return rows[0].ok;
}

/**
 * Режим клуба: 'test' | 'live' (и прочие значения backend-A, например 'suspended', как есть).
 * @param {import('pg').ClientBase} db транзакция в контексте клуба
 * @param {string} clubId
 * @param {object} [ctx] контекст запроса роутера
 */
export async function clubMode(db, clubId, ctx = null) {
  if (typeof ctx?.clubMode === 'string') return ctx.clubMode;
  if (ctx?.club && typeof ctx.club === 'object' && typeof ctx.club.mode === 'string') return ctx.club.mode;
  const { rows } = await db.query("select nullif(current_setting('app.club_mode', true), '') as m");
  if (rows[0].m) return rows[0].m;
  if (await hasModeColumn(db)) {
    const r = await db.query('select mode from bl.clubs where id = $1', [clubId]);
    if (typeof r.rows[0]?.mode === 'string') return r.rows[0].mode;
  }
  return 'test';
}

/** Боевой ли режим: live или приостановлен после live (одна функция с правилами денег). */
export const isLive = (mode, modeBeforeSuspend = null) => isLiveClub(mode, modeBeforeSuspend);

/**
 * Режим клуба и признак «боевой» для ручных действий мастера (П-2): приостановленный клуб
 * боевой, если до приостановки был live. Режим до приостановки — из ctx.club (объект) или
 * bl.clubs.mode_before_suspend; не прочитан — клуб считается боевым (причина и уведомление
 * лишними не бывают; у suspended столбец всегда задан, clubs_suspend_check).
 * @returns {Promise<{ mode: string, live: boolean }>}
 */
export async function clubLive(db, clubId, ctx = null) {
  const mode = await clubMode(db, clubId, ctx);
  if (mode !== 'suspended') return { mode, live: isLiveClub(mode) };
  let before = ctx?.club && typeof ctx.club === 'object' ? ctx.club.mode_before_suspend : undefined;
  if (typeof before !== 'string') {
    const { rows } = await db.query('select mode_before_suspend from bl.clubs where id = $1', [clubId]);
    before = rows[0]?.mode_before_suspend;
  }
  return { mode, live: isLiveClub(mode, before === 'test' ? 'test' : 'live') };
}

/** Причина ручного действия: 1–500 символов после обрезки пробелов; иначе 400 reason_required. */
export function cleanReason(reason) {
  if (typeof reason !== 'string') throw new HttpError(400, 'reason_required');
  const r = reason.trim();
  if (r.length === 0) throw new HttpError(400, 'reason_required');
  if (r.length > MAX_REASON_LEN) throw new HttpError(400, 'bad_request', { detail: 'reason too long' });
  return r;
}

/** Имя сотрудника для текста тревоги (без телефона). */
async function staffLabel(db, clubId, userId) {
  if (!userId) return 'сотрудник';
  const { rows } = await db.query(
    'select u.name, m.role from bl.club_members m join bl.users u on u.id = m.user_id where m.club_id = $1 and m.user_id = $2',
    [clubId, userId],
  );
  const r = rows[0];
  const role = { owner: 'владелец', manager: 'управляющий' }[r?.role] ?? 'сотрудник';
  return r?.name ? `${r.name} (${role})` : role;
}

/**
 * Ручное действие в live: журнал manual.* с причиной и тревога manual_action владельцу.
 * Тревога — в savepoint: сбой уведомления не откатывает само действие (журнал есть).
 * @param {import('pg').ClientBase} db
 * @param {{ clubId: string, userId: string|null, action: string, reason: string, objectType?: string,
 *           objectId?: string|null, resourceId?: string|null, data?: object, text: string, log?: object }} p
 */
export async function manualAction(db, { clubId, userId, action, reason, objectType = null, objectId = null, resourceId = null, data = {}, text, log, ctx = null }) {
  if (!/^manual\.[a-z_]+$/.test(action)) throw new Error('manualAction: action');
  // Роутер даёт ctx.manual (server/lib/manual.mjs, backend-A, M5.1 §3) — общий путь всех ручных действий.
  if (typeof ctx?.manual === 'function' && ctx.club === clubId) {
    return ctx.manual({ action, reason, objectType, objectId, resourceId, data, text });
  }
  const audit = await appendAudit(db, { action, objectType, objectId, actorType: 'user', actorId: userId, reason, data });
  const who = await staffLabel(db, clubId, userId);
  await db.query('savepoint setup_manual_alarm');
  try {
    await raise(db, clubId, {
      type: 'manual_action',
      level: 'important',
      manual: true,
      resourceId,
      data: { action, staff_id: userId, reason, audit_seq: audit.seq, ...data },
      dedupeKey: `${action}:${audit.id}`,
      text: `${text} — ${who}: ${reason}`,
    });
    await db.query('release savepoint setup_manual_alarm');
  } catch (err) {
    await db.query('rollback to savepoint setup_manual_alarm');
    log?.warn?.('setup_manual_alarm_failed', { action, error: err.message });
  }
  return audit;
}
