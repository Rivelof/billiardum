// Общее для сценариев приёмки M3 (tests/e2e/m3): бронь, лист ожидания, уведомления, пакеты
// часов, депозит наличными, персонал, сводка. Работают на поднятом `npm run dev` поверх хелперов
// M1/M2: API через Caddy, симулятор по HTTP, эмуляторы ЮKassa и АТОЛ — `docker exec`, база —
// чтение (DATABASE_ADMIN_URL) и три подготовки стенда, которых нет в API (всё возвращается):
//   * правила брони клуба (clubs.settings: шаг, упреждение, удержание, режим предоплаты) —
//     иначе каждая бронь ждёт до 45 минут; исходные значения сохраняются в файл E2E_M3_STATE
//     и восстанавливаются в конце файла (и в начале следующего прогона после сбоя);
//   * процент удержания club_payment_settings.booking_forfeit_percent (T18, 30 %);
//   * синтетические id мессенджеров гостя (T21).
// Секреты не печатаются. Столы tester — 1–6 (7–8 у pentester).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, CLUB_A, emu, ok, sleep, SIM_CONTAINER, logLines, waitFor, ykId } from '../m2/helpers.mjs';

export * from '../m2/helpers.mjs';

export const M3_STATE = process.env.E2E_M3_STATE || path.join(os.tmpdir(), 'bl-e2e-m3-state.json');
export const MIN = 60_000;
export const RES = (n) => `e1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const DEV = (n) => `d1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Правила брони для ускоренных сценариев: шаг 5 минут, без упреждения, бронь от 15 минут. */
export const FAST_BOOKING = Object.freeze({ booking_step_minutes: 5, booking_lead_minutes: 0, booking_min_minutes: 15 });

// Состояние стенда (что поменяли и что вернуть) ---------------------------------------------

function readState() {
  try {
    return existsSync(M3_STATE) ? JSON.parse(readFileSync(M3_STATE, 'utf8')) : {};
  } catch {
    return {};
  }
}

function writeState(s) {
  writeFileSync(M3_STATE, JSON.stringify(s));
}

/**
 * Поменять ключи clubs.settings клуба. Исходные значения ключей запоминаются один раз (первое
 * изменение после восстановления), чтобы restoreClubSettings вернул ровно их.
 */
export async function patchClubSettings(db, patch) {
  const { rows } = await db.query('select settings from bl.clubs where id = $1', [CLUB_A]);
  const cur = rows[0].settings ?? {};
  const s = readState();
  s.settings = s.settings ?? {};
  for (const k of Object.keys(patch)) {
    if (!(k in s.settings)) s.settings[k] = k in cur ? cur[k] : null;
  }
  writeState(s);
  await db.query('update bl.clubs set settings = settings || $2::jsonb where id = $1', [CLUB_A, JSON.stringify(patch)]);
}

export async function restoreClubSettings(db) {
  const s = readState();
  if (!s.settings || Object.keys(s.settings).length === 0) return {};
  const set = {};
  for (const [k, v] of Object.entries(s.settings)) if (v !== null) set[k] = v;
  const dropKeys = Object.entries(s.settings).filter(([, v]) => v === null).map(([k]) => k);
  await db.query('update bl.clubs set settings = (settings - $3::text[]) || $2::jsonb where id = $1', [CLUB_A, JSON.stringify(set), dropKeys]);
  delete s.settings;
  writeState(s);
  return set;
}

export async function setForfeitPercent(db, pct) {
  const { rows } = await db.query('select booking_forfeit_percent as p from bl.club_payment_settings where club_id = $1', [CLUB_A]);
  const s = readState();
  if (s.forfeit === undefined) s.forfeit = rows[0].p;
  writeState(s);
  await db.query('update bl.club_payment_settings set booking_forfeit_percent = $2 where club_id = $1', [CLUB_A, pct]);
}

export async function restoreForfeitPercent(db) {
  const s = readState();
  if (s.forfeit === undefined) return null;
  await db.query('update bl.club_payment_settings set booking_forfeit_percent = $2 where club_id = $1', [CLUB_A, s.forfeit]);
  const v = s.forfeit;
  delete s.forfeit;
  writeState(s);
  return v;
}

export async function clubSettings(db) {
  const { rows } = await db.query('select settings from bl.clubs where id = $1', [CLUB_A]);
  return rows[0].settings ?? {};
}

// Время ---------------------------------------------------------------------------------------

/**
 * Ближайшее начало брони на шаге stepMin (UTC; рабочие сутки клуба начинаются в 06:00 по
 * Екатеринбургу = 01:00 UTC, кратно 5 минутам) не раньше now + aheadMs.
 */
export function slotAfter(aheadMs, stepMin = 5, now = Date.now()) {
  const step = stepMin * MIN;
  return new Date(Math.ceil((now + aheadMs) / step) * step);
}

export function hhmm(d, tz = 'Asia/Yekaterinburg') {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(d));
}

/** Ждать момента (Date) с шагом не больше 30 с, печатая прогресс в log раз в 5 минут. */
export async function sleepUntil(at, log = () => {}) {
  let lastLog = 0;
  for (;;) {
    const left = new Date(at).getTime() - Date.now();
    if (left <= 0) return;
    if (Date.now() - lastLog > 5 * MIN) {
      log(`жду до ${hhmm(at)} (ещё ${Math.ceil(left / 1000)} с)`);
      lastLog = Date.now();
    }
    await sleep(Math.min(left, 30_000));
  }
}

// Бронь ---------------------------------------------------------------------------------------

export function createBooking(token, { table, startsAt, minutes }) {
  return api('POST', '/api/bookings', { token, body: { resource_id: RES(table), starts_at: new Date(startsAt).toISOString(), minutes } });
}

export function getBooking(token, id, { clubHeader = false } = {}) {
  return api('GET', `/api/bookings/${id}`, { token, headers: clubHeader ? { 'x-club-id': CLUB_A } : {} });
}

export async function waitBooking(token, id, pred, { timeoutMs = 60_000, what, clubHeader = false } = {}) {
  return waitFor(
    async () => {
      const r = await getBooking(token, id, { clubHeader });
      return r.status === 200 && pred(r.json) ? r.json : null;
    },
    { timeoutMs, intervalMs: 500, what: what ?? `бронь ${id}` },
  );
}

/** Предоплата брони гостем: pay → «Оплатить» в эмуляторе → бронь confirmed. → { payResp, pid, booking } */
export async function payBooking(guest, bookingId, { method = 'sbp' } = {}) {
  const payResp = await ok(api('POST', `/api/bookings/${bookingId}/pay`, { token: guest.token, body: { method }, idem: true }));
  const pid = ykId(payResp.confirmation);
  emu(`/__emu/payments/${pid}/succeed?wait=1`, { post: true });
  const booking = await waitBooking(guest.token, bookingId, (b) => b.status === 'confirmed' && b.paid_kopecks > 0, { what: 'бронь confirmed после предоплаты' });
  return { payResp, pid, booking };
}

/** Бронь по телефону (ресепшн и выше). */
export function phoneBooking(token, { table, startsAt, minutes, name = 'Гость e2e', phone, source }) {
  return api('POST', `/api/clubs/${CLUB_A}/bookings`, {
    token,
    body: { resource_id: RES(table), starts_at: new Date(startsAt).toISOString(), minutes, name, phone, ...(source ? { source } : {}) },
  });
}

export function cancelBooking(token, id, { reason, staff = false } = {}) {
  return api('POST', `/api/bookings/${id}/cancel`, { token, body: reason ? { reason } : {}, headers: staff ? { 'x-club-id': CLUB_A } : {} });
}

/** Отменить свои живые брони столов (после сбоя прошлого прогона) — управляющим, с причиной. */
export async function cancelLeftovers(db, man, tables, log = () => {}) {
  const { rows } = await db.query(
    `select b.id, r.number from bl.bookings b join bl.resources r on r.id = b.resource_id
      where b.club_id = $1 and r.number = any($2::int[]) and b.status in ('pending_payment', 'confirmed', 'reserved')`,
    [CLUB_A, tables],
  );
  for (const r of rows) {
    const res = await cancelBooking(man.token, r.id, { reason: 'e2e: уборка после прошлого прогона', staff: true });
    log(`осталась бронь стола ${r.number} (${r.id.slice(0, 8)}) — отмена управляющим: ${res.status}`);
  }
  return rows.length;
}

export async function bookingRow(db, id) {
  const { rows } = await db.query('select * from bl.bookings where id = $1', [id]);
  return rows[0] ?? null;
}

// Деньги -------------------------------------------------------------------------------------

export async function paymentRow(db, id) {
  const { rows } = await db.query(
    'select id, kind, provider, method, status, amount_kopecks, settlement_status, settled_kopecks, session_id, booking_id, package_id, provider_payment_id, deposit from bl.payments where id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** Все чеки, относящиеся к платежу: продажа/возврат по нему и зачёты предоплаты. */
export async function receiptsOf(db, paymentId) {
  const { rows } = await db.query(
    `select id, kind, channel, status, amount_kopecks, payment_id, refund_id, settles_payment_id, settlement_kopecks, provider_receipt_id, items, fd
       from bl.receipts where payment_id = $1 or settles_payment_id = $1 order by created_at`,
    [paymentId],
  );
  return rows;
}

export async function refundsOf(db, paymentId) {
  const { rows } = await db.query('select id, amount_kopecks, status, reason, provider_refund_id from bl.refunds where payment_id = $1 order by created_at', [paymentId]);
  return rows;
}

/** Отдельные чеки эмулятора ЮKassa (/v3/receipts — зачёты), по id платежа ЮKassa. */
export function emuReceipts(ykPaymentId) {
  const all = emu('/__emu/receipts');
  const list = Array.isArray(all) ? all : (all.items ?? all.receipts ?? []);
  return ykPaymentId ? list.filter((r) => r.payment_id === ykPaymentId) : list;
}

/** Ждать, пока все чеки зачёта платежа уйдут в ЮKassa (status succeeded). */
export async function waitSettlementSent(db, paymentId, { timeoutMs = 30_000 } = {}) {
  return waitFor(
    async () => {
      const rs = (await receiptsOf(db, paymentId)).filter((r) => r.settles_payment_id === paymentId && r.channel === 'yookassa');
      return rs.length > 0 && rs.every((r) => r.status === 'succeeded' && r.provider_receipt_id) ? rs : null;
    },
    { timeoutMs, intervalMs: 500, what: `чек зачёта по платежу ${paymentId} отправлен в ЮKassa` },
  );
}

// Свет и журнал ------------------------------------------------------------------------------

/** Команды симулятора стола n с момента since (лог sim_cmd). */
export function simCmds(n, since) {
  return logLines(SIM_CONTAINER, since, 'sim_cmd').filter((l) => l.table === n);
}

/** Команды стола из bl.device_commands за окно и их записи device.cmd в журнале. → { cmds, missing } */
export async function cmdsWithAudit(db, n, since) {
  const { rows: cmds } = await db.query(
    `select id, type, status, created_at, acked_at from bl.device_commands where device_id = $1 and created_at >= $2 order by created_at`,
    [DEV(n), new Date(since)],
  );
  const ids = cmds.map((c) => c.id);
  const { rows: au } = ids.length
    ? await db.query("select data->>'cmd_id' as cmd_id from bl.audit_log where club_id = $1 and action = 'device.cmd' and data->>'cmd_id' = any($2::text[])", [CLUB_A, ids])
    : { rows: [] };
  const have = new Set(au.map((r) => r.cmd_id));
  return { cmds, missing: cmds.filter((c) => !have.has(c.id) && !['skipped', 'queued', 'cancelled', 'superseded'].includes(c.status)) };
}

/** Записи журнала клуба по брони/объекту (id в object_id или в data). */
export async function auditOf(db, id, since) {
  const { rows } = await db.query(
    `select seq, action, object_type, object_id, reason, actor_type, actor_id, data, created_at from bl.audit_log
      where club_id = $1 and (object_id = $2::uuid or data::text like $3) ${since ? 'and created_at >= $4' : ''} order by seq`,
    since ? [CLUB_A, id, `%${id}%`, new Date(since)] : [CLUB_A, id, `%${id}%`],
  );
  return rows;
}

export async function notificationsOf(db, userId, { kind, since } = {}) {
  const params = [userId];
  let where = 'user_id = $1';
  if (kind) {
    params.push([].concat(kind));
    where += ` and kind = any($${params.length}::text[])`;
  }
  if (since) {
    params.push(new Date(since));
    where += ` and created_at >= $${params.length}`;
  }
  const { rows } = await db.query(`select id, kind, level, status, channel, attempts, text, data, actions, created_at from bl.notifications where ${where} order by created_at`, params);
  return rows;
}

export async function alarmsSince(db, since, type) {
  const { rows } = await db.query('select id, type, level, resource_id, data, raised_at from bl.alarms where club_id = $1 and raised_at >= $2 and ($3::text is null or type = $3) order by raised_at', [
    CLUB_A,
    new Date(since),
    type ?? null,
  ]);
  return rows;
}

/** Стол свободен и в API, и в симуляторе; иначе ждать (чужая игра, хвост прошлого прогона). */
export async function ensureFree(n, { timeoutMs = 10 * MIN } = {}) {
  const { waitTableFree } = await import('../m1/helpers.mjs');
  return waitTableFree(n, { timeoutMs });
}
