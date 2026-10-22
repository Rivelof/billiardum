// Ресепшн (контракт M1 §5): заявки «Оплачу на ресепшене».
//
// * Заявка живёт reception_request_minutes (15) минут, держит стол в pending за гостем,
//   затем сгорает и снимает pending (планировщик server/payments/index.mjs).
// * Принять: наличные (received_kopecks ≥ суммы, сдачу считает сервер) или карта через
//   терминал — только при открытой смене клуба (shift_closed, decisions №93). Принятие создаёт платёж, задание на чек ККТ (receipt_pending; мост ККТ — M2),
//   событие outbox payment.confirmed и запись журнала reception.accept — в одной транзакции.
// * Отклонить — с кодом причины, журнал reception.decline, pending снимается.
// * Экран ресепшена узнаёт о заявках по SSE: событие reception_request в канале club:{id}.

import { afterCommit } from '../lib/store.mjs';
import { enterClub, enterObjectClub, isUuid, requireIdempotencyKey, requireStaff, requireUser } from '../payments/context.mjs';
import { MoneyError, checkNeighborResult, fromNeighbor } from '../payments/errors.mjs';
import { receiptItems } from '../payments/receipt.mjs';
import { confirmedPayload, insertReceipt, sessionIdOf } from '../payments/records.mjs';
import { loadPaymentSettings } from '../payments/settings.mjs';

export const STAFF_ROLES = Object.freeze(['reception', 'manager', 'owner']);
/** Коды отклонения заявки (контракт §14). */
export const DECLINE_REASONS = Object.freeze(['guest_left', 'guest_cancelled', 'payment_failed', 'table_problem', 'other']);

/** Ответ гостю на «Оплачу на ресепшене». */
export function receptionResponse(r) {
  return { reception_request_id: r.id, status: r.status === 'waiting' ? 'waiting_reception' : r.status };
}

async function maskedPhone(db, userId) {
  try {
    const { rows } = await db.query('select phone_masked from bl.user_brief($1)', [userId]);
    return rows[0]?.phone_masked ?? null;
  } catch {
    return null;
  }
}

/** Заявка для экрана ресепшена (без телефона целиком). */
function staffView(r, { resourceNumber, phoneMasked }) {
  return {
    id: r.id,
    status: r.status,
    resource_id: r.resource_id,
    resource_number: resourceNumber,
    kind: r.kind,
    minutes: r.minutes,
    amount_kopecks: Number(r.amount_kopecks),
    created_at: new Date(r.created_at).toISOString(),
    expires_at: new Date(r.expires_at).toISOString(),
    guest_masked_phone: phoneMasked,
  };
}

/** SSE после коммита: откат не оставит на экране ресепшена заявку, которой нет. */
async function publish(db, deps, r, data) {
  await afterCommit(db, () => {
    try {
      deps.sse.publish(`club:${r.club_id}`, 'reception_request', data);
      deps.sse.publish(`user:${r.user_id}`, 'reception_request', { id: r.id, status: data.status });
    } catch (err) {
      deps.log?.warn?.('sse_publish_failed', { error: err.message });
    }
  });
}

/** Создать заявку по котировке (из POST /api/quotes/{id}/pay, method reception). */
export async function createReceptionRequest(db, deps, { quote, plan, settings, resourceNumber, userId, key, now }) {
  const expiresAt = new Date(now.getTime() + settings.reception_request_minutes * 60_000);
  if (quote.kind === 'start') {
    try {
      checkNeighborResult(await deps.sessions.holdPending(db, { resourceId: quote.resource_id, userId, until: expiresAt }));
    } catch (err) {
      throw fromNeighbor(err);
    }
  }
  const { rows } = await db.query(
    `insert into bl.reception_requests (club_id, quote_id, resource_id, user_id, kind, session_id, minutes, amount_kopecks,
                                        status, request_key, expires_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'waiting', $9, $10, $11)
     returning *`,
    [quote.club_id, quote.id, quote.resource_id, userId, quote.kind, quote.session_id, plan.minutes, plan.amount, key, expiresAt, now],
  );
  const r = rows[0];
  await publish(db, deps, r, staffView(r, { resourceNumber, phoneMasked: await maskedPhone(db, userId) }));
  deps.log?.info?.('reception_request_created', { request_id: r.id, club_id: r.club_id, amount_kopecks: plan.amount });
  return r;
}

/** GET /api/clubs/{club}/reception/requests — заявки, которые ждут. */
export async function listRequests(db, deps, info) {
  const clubId = info.params.club ?? info.params.club_id ?? info.clubId;
  if (!isUuid(clubId)) throw new MoneyError('not_found', 'club');
  await enterClub(db, clubId);
  await requireStaff(db, info, clubId, STAFF_ROLES);
  const now = deps.clock.now();
  const { rows } = await db.query(
    `select rr.*, r.number as resource_number
       from bl.reception_requests rr join bl.resources r on r.id = rr.resource_id
      where rr.club_id = $1 and rr.status = 'waiting' and rr.expires_at > $2
      order by rr.created_at`,
    [clubId, now],
  );
  const out = [];
  for (const r of rows) out.push(staffView(r, { resourceNumber: r.resource_number, phoneMasked: await maskedPhone(db, r.user_id) }));
  return out;
}

async function lockRequest(db, id) {
  const { rows } = await db.query('select * from bl.reception_requests where id = $1 for update', [id]);
  return rows[0] ?? null;
}

function acceptResponse(payment, sessionId) {
  return { payment_id: payment.id, change_kopecks: Number(payment.change_kopecks ?? 0), session_id: sessionId };
}

/** POST /api/reception/requests/{id}/accept. */
export async function acceptRequest(db, deps, info) {
  const id = info.params.id;
  if (!isUuid(id)) throw new MoneyError('not_found', 'request');
  const key = requireIdempotencyKey(info);
  const clubId = await enterObjectClub(db, 'reception_request', id);
  await requireStaff(db, info, clubId, STAFF_ROLES);
  const staffId = info.userId;
  const { method, received_kopecks: received } = info.body ?? {};
  if (method !== 'cash' && method !== 'card_terminal') throw new MoneyError('bad_request', 'method');

  const prev = await db.query('select * from bl.payments where club_id = $1 and request_key = $2', [clubId, key]);
  const r = await lockRequest(db, id);
  if (!r) throw new MoneyError('not_found', 'request');
  if (prev.rowCount > 0) {
    const p = prev.rows[0];
    if (p.id !== r.payment_id || p.method !== method) throw new MoneyError('idempotency_conflict');
    return acceptResponse(p, await sessionIdOf(db, p));
  }
  const now = deps.clock.now();
  if (r.status === 'accepted') throw new MoneyError('quote_used', 'заявка уже принята');
  if (r.status !== 'waiting' || new Date(r.expires_at).getTime() <= now.getTime()) throw new MoneyError('quote_expired', 'заявка сгорела или отклонена');

  const amount = Number(r.amount_kopecks);
  let receivedKopecks = null;
  let change = 0;
  if (method === 'cash') {
    if (!Number.isSafeInteger(received) || received < amount || received > amount + 10_000_000) throw new MoneyError('bad_request', 'received_kopecks');
    receivedKopecks = received;
    change = received - amount;
  } else if (received !== undefined && received !== null && received !== amount) {
    throw new MoneyError('bad_request', 'received_kopecks для терминала');
  }

  // Деньги на ресепшене — только в открытую смену (decisions №83, №93): иначе наличные не
  // попадут ни в одну смену и сверка разойдётся. Строка смены блокируется до коммита, чтобы
  // смена не закрылась между проверкой и записью платежа.
  const shift = await deps.shifts.currentShift(db, clubId, { forUpdate: true });
  if (!shift) throw new MoneyError('shift_closed');

  const settings = await loadPaymentSettings(db, clubId);
  const { rows: res } = await db.query('select number from bl.resources where id = $1', [r.resource_id]);
  const number = res[0]?.number;
  const { rows: pay } = await db.query(
    `insert into bl.payments (club_id, resource_id, user_id, quote_id, session_id, kind, provider, method, idempotence_key,
                              request_key, status, amount_kopecks, capture, minutes, unlimited, received_kopecks, change_kopecks,
                              accepted_by, confirmed_at, captured_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, 'reception', $7, $8, $9, 'succeeded', $10, true, $11, false, $12, $13, $14, $15, $15, $15, $15)
     returning *`,
    [clubId, r.resource_id, r.user_id, r.quote_id, r.session_id, r.kind, method, `rr-${r.id}`, key, amount, r.minutes, receivedKopecks, change, staffId, now],
  );
  const p = pay[0];
  await db.query(
    `update bl.reception_requests set status = 'accepted', decided_at = $2, decided_by = $3, payment_id = $4 where id = $1`,
    [r.id, now, staffId, p.id],
  );
  // Задание на чек ККТ клуба: пробьёт мост ККТ (M2); до этого — receipt_pending.
  await insertReceipt(db, {
    clubId,
    paymentId: p.id,
    channel: 'kkt',
    status: 'receipt_pending',
    amountKopecks: amount,
    items: receiptItems({ resourceNumber: number, minutes: r.minutes, amountKopecks: amount, vatCode: settings.vat_code }),
    taxSystemCode: settings.tax_system_code,
    userId: r.user_id,
    now,
  });
  await deps.audit.appendAudit(db, {
    action: 'reception.accept',
    objectType: 'reception_request',
    objectId: r.id,
    data: { request_id: r.id, payment_id: p.id, method, amount_kopecks: amount, received_kopecks: receivedKopecks, change_kopecks: change },
    actorType: 'user',
    actorId: staffId,
  });
  await deps.outbox.enqueue(db, 'payment.confirmed', confirmedPayload(p));
  await publish(db, deps, r, { id: r.id, status: 'accepted', resource_number: number });
  deps.log?.info?.('reception_accepted', { request_id: r.id, payment_id: p.id, club_id: clubId, method });
  return acceptResponse(p, r.session_id ?? null);
}

/** POST /api/reception/requests/{id}/decline. */
export async function declineRequest(db, deps, info) {
  const id = info.params.id;
  if (!isUuid(id)) throw new MoneyError('not_found', 'request');
  const clubId = await enterObjectClub(db, 'reception_request', id);
  await requireStaff(db, info, clubId, STAFF_ROLES);
  const reasonCode = info.body?.reason_code;
  if (reasonCode === undefined || reasonCode === null || reasonCode === '') throw new MoneyError('reason_required');
  if (typeof reasonCode !== 'string' || !DECLINE_REASONS.includes(reasonCode)) throw new MoneyError('bad_request', 'reason_code');
  const r = await lockRequest(db, id);
  if (!r) throw new MoneyError('not_found', 'request');
  if (r.status === 'declined' && r.decline_reason_code === reasonCode) return { ok: true };
  const now = deps.clock.now();
  if (r.status === 'accepted') throw new MoneyError('quote_used', 'заявка уже принята');
  if (r.status !== 'waiting') throw new MoneyError('quote_expired');
  await db.query(
    `update bl.reception_requests set status = 'declined', decided_at = $2, decided_by = $3, decline_reason_code = $4 where id = $1`,
    [r.id, now, info.userId, reasonCode],
  );
  await releasePending(db, deps, r);
  await deps.audit.appendAudit(db, {
    action: 'reception.decline',
    objectType: 'reception_request',
    objectId: r.id,
    data: { request_id: r.id, method: null, amount_kopecks: Number(r.amount_kopecks), reason_code: reasonCode },
    actorType: 'user',
    actorId: info.userId,
  });
  await publish(db, deps, r, { id: r.id, status: 'declined' });
  return { ok: true };
}

async function releasePending(db, deps, r) {
  if (r.kind !== 'start') return;
  try {
    await deps.sessions.releasePending(db, { resourceId: r.resource_id, userId: r.user_id });
  } catch (err) {
    deps.log?.warn?.('release_pending_failed', { request_id: r.id, error: fromNeighbor(err).message });
  }
}

/** Сжечь заявку, если её время вышло (планировщик). db — в контексте клуба заявки. */
export async function expireRequest(db, deps, id) {
  const now = deps.clock.now();
  const { rows } = await db.query(
    `update bl.reception_requests set status = 'expired', decided_at = $2
      where id = $1 and status = 'waiting' and expires_at <= $2 returning *`,
    [id, now],
  );
  if (rows.length === 0) return false;
  await releasePending(db, deps, rows[0]);
  await publish(db, deps, rows[0], { id, status: 'expired' });
  deps.log?.info?.('reception_request_expired', { request_id: id, club_id: rows[0].club_id });
  return true;
}

/** GET /api/reception/requests/{id} — статус заявки для гостя (её автора). */
export async function guestRequestStatus(db, deps, info) {
  const id = info.params.id;
  if (!isUuid(id)) throw new MoneyError('not_found', 'request');
  const userId = requireUser(info);
  await enterObjectClub(db, 'reception_request', id);
  const { rows } = await db.query('select * from bl.reception_requests where id = $1', [id]);
  const r = rows[0];
  if (!r || r.user_id !== userId) throw new MoneyError('not_found', 'request');
  const now = deps.clock.now();
  const status = r.status === 'waiting' && new Date(r.expires_at).getTime() <= now.getTime() ? 'expired' : r.status;
  let sessionId = r.session_id ?? null;
  if (status === 'accepted' && r.payment_id && !sessionId) sessionId = await sessionIdOf(db, { id: r.payment_id, session_id: null });
  return {
    id: r.id,
    status,
    kind: r.kind,
    minutes: r.minutes,
    amount_kopecks: Number(r.amount_kopecks),
    created_at: new Date(r.created_at).toISOString(),
    expires_at: new Date(r.expires_at).toISOString(),
    payment_id: r.payment_id ?? null,
    session_id: sessionId,
    reason_code: status === 'declined' ? r.decline_reason_code : null,
  };
}

/**
 * POST /api/reception/deposits — депозит наличными для «Без лимита» (M3, №112):
 * { resource_id, amount_kopecks, received_kopecks?, user_id? }. Только в открытую смену.
 * В одной транзакции: light начинает сессию (startFromDeposit, paid_until — сколько покрывает
 * депозит), затем деньги (takeDeposit: платёж, чек ККТ предоплаты, журнал).
 */
export async function createDeposit(db, deps, info) {
  const b = info.body ?? {};
  if (!isUuid(b.resource_id)) throw new MoneyError('bad_request', 'resource_id');
  if (!Number.isSafeInteger(b.amount_kopecks) || b.amount_kopecks <= 0) throw new MoneyError('bad_request', 'amount_kopecks');
  if (b.user_id !== undefined && b.user_id !== null && !isUuid(b.user_id)) throw new MoneyError('bad_request', 'user_id');
  const key = requireIdempotencyKey(info);
  const { rows } = await db.query('select bl.resource_club($1) as club_id', [b.resource_id]);
  if (!rows[0].club_id) throw new MoneyError('not_found', 'стол');
  const clubId = await enterClub(db, rows[0].club_id);
  await requireStaff(db, info, clubId, STAFF_ROLES);
  const prev = (await db.query('select * from bl.payments where club_id = $1 and request_key = $2 and deposit', [clubId, key])).rows[0];
  if (prev) {
    if (prev.resource_id !== b.resource_id || Number(prev.amount_kopecks) !== b.amount_kopecks) throw new MoneyError('idempotency_conflict');
    return { session_id: prev.session_id, payment_id: prev.id, change_kopecks: Number(prev.change_kopecks ?? 0) };
  }
  if (!(await deps.shifts.currentShift(db, clubId))) throw new MoneyError('shift_closed');
  if (typeof deps.sessions.startFromDeposit !== 'function') throw new Error('light: нет startFromDeposit');
  let started;
  try {
    started = await deps.sessions.startFromDeposit(db, { resourceId: b.resource_id, userId: b.user_id ?? null, staffId: info.userId, depositKopecks: b.amount_kopecks });
  } catch (err) {
    throw fromNeighbor(err);
  }
  const { takeDeposit } = await import('../payments/deposits.mjs');
  const r = await takeDeposit(db, deps, {
    clubId,
    sessionId: started.session_id,
    amountKopecks: b.amount_kopecks,
    staffId: info.userId,
    receivedKopecks: b.received_kopecks ?? null,
    requestKey: key,
  });
  return { status: 201, json: { ...r, paid_until: started.paid_until, minutes: started.minutes } };
}
