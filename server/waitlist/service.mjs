// Лист ожидания (контракт M3 §1 п. 6, §4; PRODUCT §3, §6; решение №109).
//
// Гость на занятом столе нажимает «Сообщить, когда освободится» → запись waiting. Стол
// освободился (outbox session.closed от light, booking.expired и booking.canceled) — первому
// в очереди предложение на 5 минут (offered: уведомление с кнопкой «Занять стол», SSE
// user:{id} waitlist, outbox waitlist.offered). Принял — стол удерживается за ним (holdPending
// light, 3 минуты, как котировка) и гость переходит к оплате обычной котировкой; outbox
// waitlist.accepted. Не ответил за 5 минут — expired, предложение следующему.
// Предложение держит стол (№122): setReserved light до конца предложения за этим гостем — гость
// «с улицы» стол не займёт; отказ, истечение, принятие — clearReserved (у принятия свой pending).
// Ресепшн может снять удержание с причиной: POST /api/waitlist/offers/{id}/release (ручное действие).
// Стол не предлагается, если до ближайшей брони меньше 30 минут.

import { afterCommit } from '../lib/store.mjs';
import { fail } from '../bookings/errors.mjs';
import { isUuid, loadClub, lockResource, resourceClub, tableFree, useClub } from '../bookings/queries.mjs';
import { ACCEPT_HOLD_MS, OFFER_MIN_FREE_MS, OFFER_MS, WAITLIST_MAX_PER_GUEST, WAITLIST_STALE_MS } from '../bookings/settings.mjs';

const iso = (d) => (d ? new Date(d).toISOString() : null);
const ACTIVE = ['waiting', 'offered'];

/**
 * @param {{ deps: { light, notify, outbox, sse }, log: object, clock: { now(): Date },
 *           nextBookingStart: (db, { resourceId, after }) => Promise<Date|null> }} opts
 */
export function createWaitlistService({ deps, log, clock, nextBookingStart }) {
  const now = () => clock.now();

  async function load(db, id, { lock = false } = {}) {
    if (!isUuid(id)) return null;
    const { rows } = await db.query(
      `select w.*, r.number as resource_number, r.title as resource_title from bl.waitlist w
         join bl.resources r on r.id = w.resource_id
        where w.id = $1 ${lock ? 'for update of w' : ''}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async function position(db, w) {
    if (!ACTIVE.includes(w.status)) return null;
    const { rows } = await db.query(
      `select count(*)::int as n from bl.waitlist
        where resource_id = $1 and status = any($2::text[]) and seq < $3`,
      [w.resource_id, ACTIVE, w.seq],
    );
    return rows[0].n + 1;
  }

  async function view(db, w) {
    return {
      id: w.id,
      club_id: w.club_id,
      resource: { id: w.resource_id, number: w.resource_number, title: w.resource_title },
      status: w.status,
      position: await position(db, w),
      offer_until: w.status === 'offered' ? iso(w.offer_until) : null,
      hold_until: w.status === 'accepted' ? iso(w.hold_until) : null,
      created_at: iso(w.created_at),
    };
  }

  /**
   * Событие гостю в SSE user:{id} (№120): имя события SSE — waitlist, вид — в поле type:
   * waitlist.offered {offer_id, resource, expires_at}, waitlist.accepted {offer_id, resource, hold_until},
   * waitlist.updated (очередь, истекло, отменено) — с видом записи. Кода стола нет (№119).
   */
  async function publish(db, w, type = 'waitlist.updated') {
    const v = await view(db, w);
    const resource = { id: w.resource_id, number: w.resource_number, title: w.resource_title };
    let data;
    if (type === 'waitlist.offered') data = { type, offer_id: w.id, resource, expires_at: iso(w.offer_until) };
    else if (type === 'waitlist.accepted') data = { type, offer_id: w.id, resource, hold_until: iso(w.hold_until) };
    else data = { type, ...v };
    await afterCommit(db, async () => deps.sse.publish(`user:${w.user_id}`, 'waitlist', data));
    return v;
  }

  async function own(db, id, userId, { lock = false } = {}) {
    if (!isUuid(id) || !isUuid(userId)) fail('not_found', 'waitlist');
    const { rows } = await db.query('select club_id from bl.waitlist where id = $1 and user_id = $2', [id, userId]);
    if (!rows[0]) fail('not_found', 'waitlist');
    await useClub(db, rows[0].club_id);
    return load(db, id, { lock });
  }

  async function set(db, id, fields) {
    const keys = Object.keys(fields);
    await db.query(`update bl.waitlist set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [id, ...keys.map((k) => fields[k])]);
  }

  /** POST /api/waitlist {resource_id} — встать в очередь на занятый стол. Повтор — та же запись. */
  async function join(db, { userId, body }) {
    const resourceId = body?.resource_id;
    if (!isUuid(resourceId)) fail('bad_request', 'resource_id');
    const clubId = await resourceClub(db, resourceId);
    if (!clubId) fail('not_found', 'resource');
    await useClub(db, clubId);
    const t = now();
    const res = await lockResource(db, resourceId);
    if (!res || !res.active) fail('not_found', 'resource');
    const { rows: existing } = await db.query(
      'select id from bl.waitlist where resource_id = $1 and user_id = $2 and status = any($3::text[])',
      [resourceId, userId, ACTIVE],
    );
    if (existing[0]) return view(db, await load(db, existing[0].id));
    if (await tableFree(db, resourceId, t)) fail('table_free');
    const { rows: mine } = await db.query(
      'select count(*)::int as n from bl.waitlist where club_id = $1 and user_id = $2 and status = any($3::text[])',
      [clubId, userId, ACTIVE],
    );
    if (mine[0].n >= WAITLIST_MAX_PER_GUEST) fail('limit_exceeded', 'очередей гостя');
    const { rows } = await db.query(
      `insert into bl.waitlist (club_id, resource_id, user_id, status, created_at, updated_at)
       values ($1, $2, $3, 'waiting', $4, $4) returning id`,
      [clubId, resourceId, userId, t],
    );
    log.info('waitlist_joined', { waitlist_id: rows[0].id, resource_id: resourceId });
    return view(db, await load(db, rows[0].id));
  }

  /** DELETE /api/waitlist/{id} — выйти из очереди (или отказаться от предложения). */
  async function leave(db, { userId, id }) {
    const w = await own(db, id, userId, { lock: true });
    const t = now();
    if (w.status === 'accepted' && w.hold_until && new Date(w.hold_until) > t) {
      await deps.light.releasePending(db, { resourceId: w.resource_id, userId });
    }
    if (!['waiting', 'offered', 'accepted'].includes(w.status)) return view(db, w);
    await set(db, w.id, { status: 'canceled', closed_at: t, close_reason: 'guest', updated_at: t });
    if (w.status === 'offered') await deps.light.clearReserved(db, { resourceId: w.resource_id });
    if (w.status !== 'waiting') await offerNext(db, w.resource_id);
    return publish(db, await load(db, w.id));
  }

  /**
   * POST /api/waitlist/{id}/accept — принять предложение: стол удерживается за гостем
   * (holdPending light, 3 минуты), дальше обычная котировка POST /api/quotes. Стол успели
   * занять — запись возвращается в очередь на своё место, ответ 409 table_busy
   * (без отката: состояние очереди сохраняется).
   * @returns {{ status: number, json: object }}
   */
  async function accept(db, { userId, id }) {
    const w0 = await own(db, id, userId);
    const t = now();
    await lockResource(db, w0.resource_id);
    const w = await load(db, id, { lock: true });
    if (w.status === 'accepted' && w.hold_until && new Date(w.hold_until) > t) return { status: 200, json: await acceptedView(db, w) };
    if (w.status !== 'offered' || new Date(w.offer_until) <= t) fail('offer_expired');
    const until = new Date(t.getTime() + ACCEPT_HOLD_MS);
    await db.query('savepoint bl_waitlist_hold');
    try {
      await deps.light.holdPending(db, { resourceId: w.resource_id, userId, until });
      await db.query('release savepoint bl_waitlist_hold');
    } catch (err) {
      await db.query('rollback to savepoint bl_waitlist_hold');
      if (!(Number.isInteger(err?.status) && err.status === 409 && typeof err.code === 'string')) throw err;
      await set(db, w.id, { status: 'waiting', offered_at: null, offer_until: null, missed: Math.min(100, w.missed + 1), updated_at: t });
      await deps.light.clearReserved(db, { resourceId: w.resource_id });
      await publish(db, await load(db, w.id));
      log.info('waitlist_accept_missed', { waitlist_id: w.id, code: err.code });
      return { status: 409, json: { error: err.code } };
    }
    await set(db, w.id, { status: 'accepted', accepted_at: t, hold_until: until, closed_at: t, close_reason: 'accepted', updated_at: t });
    const nw = await load(db, w.id);
    await deps.outbox.enqueue(db, 'waitlist.accepted', {
      waitlist_id: w.id, club_id: w.club_id, resource_id: w.resource_id, user_id: userId, hold_until: until.toISOString(),
    });
    await publish(db, nw, 'waitlist.accepted');
    log.info('waitlist_accepted', { waitlist_id: w.id, resource_id: w.resource_id });
    return { status: 200, json: await acceptedView(db, nw) };
  }

  async function acceptedView(db, w) {
    return { ...(await view(db, w)), resource_id: w.resource_id, hold_until: iso(w.hold_until) };
  }

  /** GET /api/me/waitlist — свои живые записи (и принятые за последний час). */
  async function listMine(db, { userId }) {
    const { rows } = await db.query(
      `select id, club_id from bl.waitlist
        where user_id = $1 and (status = any($2::text[]) or updated_at > $3)
        order by created_at desc limit 20`,
      [userId, ACTIVE, new Date(now().getTime() - 3600_000)],
    );
    const out = [];
    for (const r of rows) {
      await useClub(db, r.club_id);
      out.push(await view(db, await load(db, r.id)));
    }
    return out;
  }

  /**
   * Предложить стол первому в очереди. Вызывается в контексте клуба стола. Ничего не делает,
   * если предложение уже идёт, стол не свободен или до брони меньше 30 минут.
   */
  async function offerNext(db, resourceId) {
    const t = now();
    const res = await lockResource(db, resourceId);
    if (!res || !res.active) return null;
    const { rows: live } = await db.query(
      "select id from bl.waitlist where resource_id = $1 and status = 'offered' and offer_until > $2 limit 1",
      [resourceId, t],
    );
    if (live[0]) return null;
    const { rows: first } = await db.query(
      "select id from bl.waitlist where resource_id = $1 and status = 'waiting' order by seq limit 1 for update",
      [resourceId],
    );
    if (!first[0]) return null;
    if (!(await tableFree(db, resourceId, t))) return null;
    const next = await nextBookingStart(db, { resourceId, after: t });
    if (next && new Date(next).getTime() - t.getTime() < OFFER_MIN_FREE_MS) return null;
    const until = new Date(t.getTime() + OFFER_MS);
    await set(db, first[0].id, { status: 'offered', offered_at: t, offer_until: until, updated_at: t });
    const w = await load(db, first[0].id);
    // Стол за предложенным гостем до конца предложения (№122).
    await deps.light.setReserved(db, { resourceId, until, userId: w.user_id, source: 'waitlist' });
    try {
      await deps.notify.send(db, w.user_id, {
        kind: 'waitlist.offer',
        level: 'important',
        text: `Стол ${w.resource_number} свободен — он ваш на 5 минут. Нажмите «Занять стол».`,
        data: { waitlist_id: w.id, resource_id: w.resource_id, offer_until: until.toISOString() },
        actions: [{ id: 'accept', title: 'Занять стол', url: `/app/waitlist/${w.id}` }],
      });
    } catch (err) {
      log.warn('waitlist_notify_failed', { waitlist_id: w.id, error: err.message });
    }
    await deps.outbox.enqueue(db, 'waitlist.offered', {
      waitlist_id: w.id, club_id: w.club_id, resource_id: w.resource_id, user_id: w.user_id, offer_until: until.toISOString(),
    });
    await publish(db, w, 'waitlist.offered');
    log.info('waitlist_offered', { waitlist_id: w.id, resource_id: resourceId });
    return w.id;
  }

  /**
   * POST /api/waitlist/offers/{id}/release — ресепшн и выше: снять удержание стола предложением
   * (№122). Ручное действие: причина обязательна, журнал manual.waitlist_release, тревога владельцу.
   * Следующему в очереди стол сразу не предлагается — его забирает гость у стойки.
   */
  async function release(db, { id, clubId, reason }) {
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (!why || why.length > 2000) fail('reason_required');
    const w = await load(db, id, { lock: true });
    if (!w || w.club_id !== clubId) fail('not_found', 'waitlist');
    const t = now();
    if (w.status !== 'offered' || new Date(w.offer_until) <= t) fail('offer_expired');
    await set(db, w.id, { status: 'expired', closed_at: t, close_reason: 'released', updated_at: t });
    await deps.light.clearReserved(db, { resourceId: w.resource_id });
    await deps.audit.appendAudit(db, {
      action: 'manual.waitlist_release',
      objectType: 'waitlist',
      objectId: w.id,
      reason: why,
      data: { waitlist_id: w.id, resource_id: w.resource_id, offer_until: iso(w.offer_until) },
    });
    await deps.alarms.raise(db, w.club_id, {
      type: 'manual_action',
      manual: true,
      resourceId: w.resource_id,
      data: { action: 'waitlist_release', waitlist_id: w.id },
      text: `Снято удержание стола ${w.resource_number} для гостя из очереди: ${why}`,
    });
    try {
      await deps.notify.send(db, w.user_id, {
        kind: 'waitlist.released',
        level: 'important',
        text: `Предложение стола ${w.resource_number} снято клубом. Вы можете встать в очередь снова.`,
        data: { waitlist_id: w.id, resource_id: w.resource_id },
      });
    } catch (err) {
      log.warn('waitlist_notify_failed', { waitlist_id: w.id, error: err.message });
    }
    const nw = await load(db, w.id);
    await publish(db, nw);
    log.info('waitlist_released', { waitlist_id: w.id, resource_id: w.resource_id });
    return view(db, nw);
  }

  /** Шаг планировщика: истёкшее предложение — следующему; запись старше 6 часов — закрыть. */
  async function step(db, id) {
    const w = await load(db, id, { lock: true });
    if (!w) return null;
    const t = now();
    if (w.status === 'offered' && new Date(w.offer_until) <= t) {
      await set(db, w.id, { status: 'expired', closed_at: t, close_reason: 'no_answer', updated_at: t });
      await deps.light.clearReserved(db, { resourceId: w.resource_id });
      await publish(db, await load(db, w.id));
      await offerNext(db, w.resource_id);
      return 'expired';
    }
    if (w.status === 'waiting' && t.getTime() - new Date(w.created_at).getTime() >= WAITLIST_STALE_MS) {
      await set(db, w.id, { status: 'expired', closed_at: t, close_reason: 'stale', updated_at: t });
      await publish(db, await load(db, w.id));
      return 'expired';
    }
    return null;
  }

  /** outbox session.closed, booking.expired, booking.canceled: стол мог освободиться. */
  async function onFreed(db, ev) {
    if (!ev || !isUuid(ev.resource_id)) return { result: 'ignored' };
    const offered = await offerNext(db, ev.resource_id);
    return { result: offered ? 'offered' : 'none' };
  }

  return { join, leave, accept, release, listMine, offerNext, step, onFreed, view, load, loadClub };
}
