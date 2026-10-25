// Бронь столов (контракт M3 §1 п. 1–5, §3, §4; PRODUCT §6; решения №104–108).
//
// Все функции принимают db — клиента транзакции (запрос, outbox или планировщик). Свет и
// сессии — только через light (startFromBooking, setReserved, clearReserved), деньги — через
// money (createPrepayment, createBookingQuote, settlePrepayment, forfeitPrepayment, refund).
// Пересечения броней стола запрещает база (exclude using gist), гонки — блокировка строки
// стола (SELECT … FOR UPDATE) до проверки и вставки.

import { isSlotType, noun, resourceName } from '../lib/resource-kinds.mjs';
import { formatDate, formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { afterCommit } from '../lib/store.mjs';
import { BookingError, fail, isConflict } from './errors.mjs';
import {
  activeHolds,
  forfeitPercentOf,
  isUuid,
  LIVE,
  loadBooking,
  loadClub,
  lockResource,
  maskPhone,
  normalizeCode,
  OPEN,
  openSession,
  overlapping,
  ownBookingClub,
  resourceClub,
  safely,
  useClub,
  workdayAt,
  workdayWindow,
} from './queries.mjs';
import { bookingSettings, EXTEND_GAP_MS, holdFor, prepaymentFor, refundFor, REMIND_BEFORE_MS, RESERVE_BEFORE_MS } from './settings.mjs';

const MIN = 60_000;
const iso = (d) => (d ? new Date(d).toISOString() : null);
const ms = (d) => new Date(d).getTime();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
export const STAFF_ROLES = Object.freeze(['owner', 'manager', 'reception']);
export const CANCEL_ROLES = Object.freeze(['owner', 'manager']);

function parseTime(v, what) {
  if (typeof v !== 'string' || v.length > 40) fail('bad_request', what);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) fail('bad_request', what);
  return d;
}

/** Путь своего сайта для return_url (как действия уведомлений core): «/app/…», без хоста и схемы. */
export function localPath(v) {
  return typeof v === 'string' && v.length <= 300 && /^\/[^/\\]/.test(v) && !/[\s<>"\\]/.test(v) && !v.includes('..') ? v : null;
}

/**
 * Может ли персонал с ролями roles отменить бронь (№115): владелец и управляющий — любую живую;
 * ресепшн — брони по телефону и персонала без предоплаты.
 */
export function staffCanCancel(b, roles = []) {
  if (!OPEN.includes(b.status)) return false;
  if (roles.some((r) => CANCEL_ROLES.includes(r))) return true;
  if (roles.includes('reception')) return ['phone', 'staff'].includes(b.source) && b.prepaid_kopecks === 0 && !b.prepayment_id;
  return false;
}

function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

/**
 * @param {{ deps: object, log: object, clock: { now(): Date }, config?: object }} opts
 */
export function createBookingService({ deps, log, clock, config = {} }) {
  const now = () => clock.now();

  // Вид брони ------------------------------------------------------------------------------

  function cancelInfo(b, settings, percent, t) {
    const allowed = OPEN.includes(b.status);
    const paid = b.prepaid_kopecks;
    const freeUntil = new Date(ms(b.starts_at) - settings.freeCancelMinutes * MIN);
    const p = t <= freeUntil ? 0 : percent;
    return { allowed, refund_kopecks: allowed ? refundFor(paid, p) : 0, free_until: paid > 0 ? iso(freeUntil) : null };
  }

  /**
   * Бронь для ответа. staff — с гостем (имя брони по телефону и маска телефона), иначе без ПДн чужих.
   */
  async function view(db, b, { staff = false, roles = [], t = now(), viewer = null } = {}) {
    const club = await loadClub(db, b.club_id);
    const settings = bookingSettings(club?.settings);
    const percent = club ? await forfeitPercentOf(db, club) : 100;
    const out = {
      id: b.id,
      club: { id: b.club_id, name: b.club_name ?? club?.name ?? null, timezone: b.club_timezone ?? club?.timezone ?? null },
      resource: { id: b.resource_id, number: b.resource_number, title: b.resource_title, type: b.resource_type },
      status: b.status,
      source: b.source,
      starts_at: iso(b.starts_at),
      ends_at: iso(b.ends_at),
      minutes: Math.round((ms(b.ends_at) - ms(b.starts_at)) / MIN),
      hold_until: iso(ms(b.starts_at) + b.hold_minutes * MIN),
      amount_kopecks: b.amount_kopecks,
      prepayment_mode: b.prepayment_mode,
      prepayment_kopecks: b.prepayment_kopecks,
      paid_kopecks: b.prepaid_kopecks,
      pay_until: b.status === 'pending_payment' ? iso(b.pay_until) : null,
      payment_id: b.prepayment_id ?? null,
      session_id: b.session_id ?? null,
      expire_reason: b.expire_reason ?? null,
      created_at: iso(b.created_at),
      cancel: cancelInfo(b, settings, percent, t),
      // Бронь на двоих («Сыграем?»): сколько участников кроме владельца и кто смотрит.
      participants_count: (b.participants ?? []).length,
      ...(viewer ? { my_role: viewer === b.user_id ? 'owner' : 'participant' } : {}),
    };
    // Участник не отменяет и не платит — это делает владелец.
    if (viewer && viewer !== b.user_id) out.cancel = { allowed: false, refund_kopecks: 0, free_until: null };
    if (staff) {
      let phoneMasked = maskPhone(b.guest_phone);
      if (!phoneMasked && b.user_id) {
        const { rows } = await db.query('select phone_masked from bl.user_brief($1)', [b.user_id]);
        phoneMasked = rows[0]?.phone_masked ?? null;
      }
      out.guest = { name: b.guest_name ?? null, phone_masked: phoneMasked, user: Boolean(b.user_id) };
      out.created_by = b.created_by ?? null;
      out.cancel_reason = b.cancel_reason ?? null;
      out.can_cancel = staffCanCancel(b, roles);
    }
    return out;
  }

  /** Событие для outbox и SSE клуба: без ПДн. */
  function event(b, extra = {}) {
    return {
      booking_id: b.id,
      club_id: b.club_id,
      resource_id: b.resource_id,
      user_id: b.user_id ?? null,
      status: b.status,
      starts_at: iso(b.starts_at),
      ends_at: iso(b.ends_at),
      ...extra,
    };
  }

  /** События гостю в SSE user:{id} (№120): имя события SSE — booking, вид — в поле type. */
  const GUEST_EVENTS = new Set(['booking.confirmed', 'booking.reserved', 'booking.started', 'booking.expired', 'booking.canceled']);

  async function emit(db, topic, b, extra = {}) {
    const payload = event(b, extra);
    await deps.outbox.enqueue(db, topic, payload);
    const userId = b.user_id;
    const forGuest = userId && GUEST_EVENTS.has(topic)
      ? { type: topic, id: b.id, status: payload.status, starts_at: payload.starts_at, ends_at: payload.ends_at, resource: { id: b.resource_id, number: b.resource_number ?? null } }
      : null;
    await afterCommit(db, async () => {
      deps.sse.publish(`club:${b.club_id}`, 'booking', { type: topic, ...payload });
      if (forGuest) deps.sse.publish(`user:${userId}`, 'booking', forGuest);
    });
  }

  async function audit(db, entry) {
    return deps.audit.appendAudit(db, entry);
  }

  /** Уведомление владельцу брони и участникам («Сыграем?», бронь на двоих). */
  async function notifyGuest(db, b, { kind, text, level = 'info', actions, ownerOnly = false }) {
    if (!b.user_id) return null;
    const to = ownerOnly ? [b.user_id] : [b.user_id, ...(b.participants ?? [])];
    let first = null;
    for (const userId of to) {
      // Уведомление не держит бронь: ошибка — в лог, транзакция цела (точка сохранения).
      const r = await safely(
        db,
        () => deps.notify.send(db, userId, {
          kind,
          text,
          level,
          data: { booking_id: b.id, resource_id: b.resource_id, starts_at: iso(b.starts_at) },
          ...(actions ? { actions } : {}),
        }),
        { log, what: `notify:${kind}` },
      );
      first ??= r;
    }
    return first;
  }

  const when = (b) => `${formatDate(b.starts_at, b.club_timezone)} в ${formatTime(b.starts_at, b.club_timezone)}`;
  const at = (b) => formatTime(b.starts_at, b.club_timezone);
  const bookingUrl = (b) => `/app/bookings/${b.id}`;
  const holdText = (b) => `${b.hold_minutes} ${plural(b.hold_minutes, ['минуту', 'минуты', 'минут'])}`;

  async function updateBooking(db, id, fields) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    await db.query(`update bl.bookings set ${sets.join(', ')} where id = $1`, [id, ...keys.map((k) => (k === 'notified' ? JSON.stringify(fields[k]) : fields[k]))]);
  }

  // Проверки интервала ----------------------------------------------------------------------

  async function checkTable(db, resourceId, from, to, t, { exceptBooking = null, userId = null } = {}) {
    const s = await openSession(db, resourceId);
    // Идёт игра: пересечение с оплаченным временем — table_busy; ближе 5 минут к его концу —
    // booking_conflict (№123: иначе предел продления оказался бы в прошлом).
    if (s && ms(s.paid_until) > ms(from)) fail('table_busy', 'идёт игра');
    if (s && ms(s.paid_until) + EXTEND_GAP_MS > ms(from)) fail('booking_conflict', 'ближе 5 минут к концу игры');
    for (const h of await activeHolds(db, resourceId, t)) {
      if (ms(h.until) <= ms(from)) continue;
      if (h.kind === 'service') fail('table_service');
      if (h.kind === 'pending' && h.user_id !== userId && ms(from) < ms(t) + 5 * MIN) fail('table_pending');
    }
    // M4 №138, №146: окно турнира и удержания его матчей — брони не принимаются; ответ как у QR
    // (409 table_busy {reason: 'tournament', busy_until}), чтобы гость видел «турнир до HH:MM» (Д7).
    const busyUntil = await tournamentBusyUntil(db, resourceId, from, to);
    if (busyUntil) fail('table_busy', 'турнир', 409, { reason: 'tournament', busy_until: new Date(busyUntil).toISOString() });
    const other = await overlapping(db, resourceId, from, to, exceptBooking);
    if (other.length > 0) fail('booking_conflict', 'пересечение с бронью');
    // №129: на столе ждёт оплаты котировка (старт или продление), конец которой заходит в бронь.
    const pending = await pendingPlayUntil(db, resourceId, t);
    if (pending && ms(pending) + EXTEND_GAP_MS > ms(from)) fail('booking_conflict', 'ждёт оплаты котировка');
  }

  /** Интервалы блокировки стола турниром (server/tournaments, необязательная зависимость). */
  async function tournamentHolds(db, resourceId, from, to) {
    if (typeof deps.tournaments?.tournamentHolds !== 'function') return [];
    const list = await deps.tournaments.tournamentHolds(db, { resourceId, from: new Date(from), to: new Date(to) });
    return Array.isArray(list) ? list : [];
  }

  /**
   * Интервал [from, to) задевает турнир: конец занятости (мс) — конец самого позднего из пересекающих
   * интервалов и примыкающих к ним; иначе null.
   */
  async function tournamentBusyUntil(db, resourceId, from, to) {
    // Сутки после интервала — чтобы busy_until дошёл до конца примыкающих интервалов (матч после окна).
    const list = (await tournamentHolds(db, resourceId, from, ms(to) + 24 * 3600_000))
      .map((x) => ({ a: ms(x.from), b: ms(x.to) }))
      .filter((x) => Number.isFinite(x.a) && Number.isFinite(x.b))
      .sort((x, y) => x.a - y.a);
    let until = null;
    for (const x of list) {
      if (until === null) {
        if (x.a < ms(to) && x.b > ms(from)) until = x.b;
      } else if (x.a <= until) {
        until = Math.max(until, x.b);
      }
    }
    return until;
  }

  /**
   * До какого момента может дойти игра по живой котировке стола (money): неиспользованная и
   * не истёкшая или оплаченная, но ещё не подтверждённая (платёж pending, не старше часа).
   * Функция money payments.pendingPlayUntil(db, {resourceId, now}), если есть; иначе — чтение
   * bl.quotes/bl.payments (таблицы money, §13) в точке сохранения.
   */
  async function pendingPlayUntil(db, resourceId, t) {
    if (typeof deps.payments.pendingPlayUntil === 'function') {
      const v = await deps.payments.pendingPlayUntil(db, { resourceId, now: t });
      return v ? new Date(v) : null;
    }
    await db.query('savepoint bl_booking_pending_quotes');
    try {
      const { rows } = await db.query(
        `select max(case when q.kind = 'extend' then q.from_at else greatest(q.valid_until, $2::timestamptz) end
                    + make_interval(mins => coalesce(q.minutes, 120))) as until
           from bl.quotes q
          where q.resource_id = $1 and q.kind in ('start', 'extend')
            and ((q.used_at is null and q.valid_until > $2)
                 or exists (select 1 from bl.payments p
                             where p.quote_id = q.id and p.status in ('pending', 'waiting_for_capture') and p.confirmed_at is null
                               and p.created_at > $2::timestamptz - interval '1 hour'))`,
        [resourceId, t],
      );
      await db.query('release savepoint bl_booking_pending_quotes');
      return rows[0]?.until ? new Date(rows[0].until) : null;
    } catch (err) {
      await db.query('rollback to savepoint bl_booking_pending_quotes');
      log.warn('booking_pending_quotes_failed', { resource_id: resourceId, code: err.code });
      return null;
    }
  }

  /**
   * exact — минуты как есть, без шага и минимума: неполный слот корта по минутам (цена слота
   * пропорционально минутам, одно округление) — ранний приход и опоздание по брони (№113, №44).
   */
  async function priceOf(db, resourceId, from, minutes, minimum = true, exact = false) {
    try {
      const r = await deps.tariffs.amountFor(db, { resourceId, from, minutes, minimum, exact });
      return Number(r.amount_kopecks);
    } catch (err) {
      if (err?.code === 'no_tariff') fail('no_tariff');
      if (isConflict(err)) throw err;
      throw err;
    }
  }

  /**
   * Длина слота ресурса (корт, M5.8 №204) или null (стол — почасово). Корт без тарифа слотов — no_tariff.
   * Вызывается в контексте клуба ресурса.
   */
  async function slotOf(db, resourceId) {
    if (typeof deps.tariffs.resourceBilling !== 'function') return null;
    const b = await deps.tariffs.resourceBilling(db, { resourceId });
    if (b?.billing !== 'slot') return null;
    if (!b.slot_minutes) fail('no_tariff', 'у корта нет тарифа слотов');
    return b.slot_minutes;
  }

  /** Длительность брони корта: 1…N слотов, не длиннее booking_max_minutes (но хотя бы слот). */
  function slotMinutesOk(settings, slot, minutes) {
    const max = Math.max(slot, Math.floor(settings.maxMinutes / slot) * slot);
    return Number.isInteger(minutes) && minutes >= slot && minutes <= max && minutes % slot === 0;
  }

  async function validateSlot(db, club, settings, startsAt, minutes, t, { guest, slot = null }) {
    if (slot !== null) {
      // Корт: бронь блоками слота (M5.8 №204); начало — по сетке брони клуба (booking_step_minutes).
      if (!slotMinutesOk(settings, slot, minutes)) fail('bad_request', 'minutes: slot');
    } else if (!Number.isInteger(minutes) || minutes < settings.minMinutes || minutes > settings.maxMinutes || minutes % settings.stepMinutes !== 0) {
      fail('bad_request', 'minutes');
    }
    if (startsAt.getUTCSeconds() !== 0 || startsAt.getUTCMilliseconds() !== 0) fail('bad_request', 'starts_at: целые минуты');
    const day = await workdayAt(db, club.id, startsAt);
    if (!day || (ms(startsAt) - ms(day.start)) % (settings.stepMinutes * MIN) !== 0) fail('bad_request', 'starts_at: шаг');
    const lead = guest ? settings.leadMinutes : 0;
    if (ms(startsAt) < ms(t) + lead * MIN - (guest ? 0 : settings.stepMinutes * MIN)) fail('bad_request', 'starts_at: слишком рано');
    if (ms(startsAt) > ms(t) + settings.maxDays * 1440 * MIN) fail('bad_request', 'starts_at: слишком далеко');
  }

  async function insertBooking(db, row) {
    await db.query('savepoint bl_booking_insert');
    try {
      const { rows } = await db.query(
        `insert into bl.bookings (club_id, resource_id, user_id, guest_name, guest_phone, source, created_by, starts_at, ends_at,
                                  status, prepayment_mode, amount_kopecks, prepayment_kopecks, pay_until, hold_minutes,
                                  participants, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $17::uuid[], $16, $16) returning id`,
        [
          row.clubId, row.resourceId, row.userId, row.guestName, row.guestPhone, row.source, row.createdBy, row.startsAt, row.endsAt,
          row.status, row.mode, row.amount, row.prepayment, row.payUntil, row.hold, row.t, row.participants ?? [],
        ],
      );
      await db.query('release savepoint bl_booking_insert');
      return rows[0].id;
    } catch (err) {
      await db.query('rollback to savepoint bl_booking_insert');
      // Ограничение exclude: параллельная бронь того же интервала (страховка к блокировке стола).
      if (err.code === '23P01') fail('booking_conflict', 'exclude');
      throw err;
    }
  }

  // Создание ------------------------------------------------------------------------------

  /**
   * POST /api/bookings — гость. { resource_id, starts_at, minutes } → бронь: pending_payment при
   * предоплате (оплата — POST /api/bookings/{id}/pay), иначе confirmed.
   */
  async function create(db, { userId, body, source = 'app', participants = [] }) {
    if (!isUuid(userId)) fail('unauthorized');
    const resourceId = body?.resource_id;
    if (!isUuid(resourceId)) fail('bad_request', 'resource_id');
    const startsAt = parseTime(body.starts_at, 'starts_at');
    const minutes = body.minutes;
    if (body.source !== undefined && !['app', 'site'].includes(body.source)) fail('bad_request', 'source');
    const src = body.source ?? source;
    // Участники брони на двоих — только из модуля Бильярдум+ (createBooking), не из тела запроса.
    if (!Array.isArray(participants) || participants.length > 3 || !participants.every(isUuid) || new Set(participants).size !== participants.length || participants.includes(userId)) {
      fail('bad_request', 'participants');
    }
    const clubId = await resourceClub(db, resourceId);
    if (!clubId) fail('not_found', 'resource');
    await useClub(db, clubId);
    const t = now();
    const club = await loadClub(db, clubId);
    // M5.1 №160: приостановленный платформой клуб новых игр (и броней) не принимает.
    if ((await db.query('select bl.club_mode($1) as m', [clubId])).rows[0].m === 'suspended') fail('club_suspended');
    const settings = bookingSettings(club.settings);
    await validateSlot(db, club, settings, startsAt, minutes, t, { guest: true, slot: await slotOf(db, resourceId) });
    const res = await lockResource(db, resourceId);
    if (!res || !res.active) fail('not_found', 'resource');
    // Лимит живых броней гостя: параллельные брони одного гостя на разные столы — по очереди.
    await db.query("select pg_advisory_xact_lock(hashtextextended('bl.booking.guest:' || $1 || ':' || $2, 0))", [clubId, userId]);
    const { rows: mine } = await db.query(
      'select count(*)::int as n from bl.bookings where club_id = $1 and user_id = $2 and status = any($3::text[])',
      [clubId, userId, ['pending_payment', 'confirmed', 'reserved']],
    );
    if (mine[0].n >= settings.maxOpenPerGuest) fail('limit_exceeded', 'живых броней гостя');
    const endsAt = new Date(ms(startsAt) + minutes * MIN);
    await checkTable(db, resourceId, startsAt, endsAt, t, { userId });
    const amount = await priceOf(db, resourceId, startsAt, minutes);
    const prepayment = prepaymentFor(settings, amount);
    const status = prepayment > 0 ? 'pending_payment' : 'confirmed';
    const payUntil = prepayment > 0 ? new Date(Math.min(ms(t) + settings.payMinutes * MIN, ms(startsAt))) : null;
    const id = await insertBooking(db, {
      clubId, resourceId, userId, guestName: null, guestPhone: null, source: src, createdBy: userId, startsAt, endsAt,
      status, mode: settings.prepayment, amount, prepayment, payUntil, hold: Math.min(holdFor(settings, prepayment), minutes), t, participants,
    });
    const b = await loadBooking(db, id);
    await audit(db, {
      action: 'booking.create',
      objectType: 'booking',
      objectId: id,
      data: { booking_id: id, resource_id: resourceId, starts_at: iso(startsAt), minutes, source: src, status, amount_kopecks: amount, prepayment_kopecks: prepayment },
    });
    await emit(db, 'booking.created', b);
    if (status === 'confirmed') {
      await emit(db, 'booking.confirmed', b);
      await notifyGuest(db, b, { kind: 'booking.confirmed', text: `Бронь подтверждена: ${resourceName(b.resource_type, b.resource_number, { capital: false })}, ${when(b)}.`, actions: [{ id: 'open', title: 'Моя бронь', url: bookingUrl(b) }] });
    }
    log.info('booking_created', { booking_id: id, club_id: clubId, resource_id: resourceId, status, source: src });
    return view(db, b, { t });
  }

  /**
   * POST /api/clubs/{club}/bookings — ресепшн и выше: бронь по телефону. { resource_id, starts_at,
   * minutes, name, phone, source? } → confirmed без предоплаты; телефон в ответе — маской.
   */
  async function createByStaff(db, { clubId, staffId, body, roles = [] }) {
    const resourceId = body?.resource_id;
    if (!isUuid(resourceId)) fail('bad_request', 'resource_id');
    const startsAt = parseTime(body.starts_at, 'starts_at');
    const name = cleanText(body.name, 100);
    if (!name) fail('bad_request', 'name');
    const phone = typeof body.phone === 'string' ? body.phone.replace(/[\s()-]/g, '') : null;
    if (!phone || !PHONE.test(phone)) fail('bad_request', 'phone');
    const source = body.source ?? 'phone';
    if (!['phone', 'staff'].includes(source)) fail('bad_request', 'source');
    const t = now();
    const club = await loadClub(db, clubId);
    if (!club) fail('not_found', 'club');
    if ((await db.query('select bl.club_mode($1) as m', [clubId])).rows[0].m === 'suspended') fail('club_suspended');
    const settings = bookingSettings(club.settings);
    await validateSlot(db, club, settings, startsAt, body.minutes, t, { guest: false, slot: await slotOf(db, resourceId) });
    const res = await lockResource(db, resourceId);
    if (!res || !res.active || res.club_id !== clubId) fail('not_found', 'resource');
    const endsAt = new Date(ms(startsAt) + body.minutes * MIN);
    await checkTable(db, resourceId, startsAt, endsAt, t);
    const amount = await priceOf(db, resourceId, startsAt, body.minutes);
    const id = await insertBooking(db, {
      clubId, resourceId, userId: null, guestName: name, guestPhone: phone, source, createdBy: staffId, startsAt, endsAt,
      status: 'confirmed', mode: 'none', amount, prepayment: 0, payUntil: null, hold: Math.min(settings.holdMinutes, body.minutes), t,
    });
    const b = await loadBooking(db, id);
    await audit(db, {
      action: 'booking.create',
      objectType: 'booking',
      objectId: id,
      data: { booking_id: id, resource_id: resourceId, starts_at: iso(startsAt), minutes: body.minutes, source, status: 'confirmed', amount_kopecks: amount, phone_masked: maskPhone(phone) },
    });
    await emit(db, 'booking.created', b);
    await emit(db, 'booking.confirmed', b);
    log.info('booking_created', { booking_id: id, club_id: clubId, resource_id: resourceId, status: 'confirmed', source });
    return view(db, b, { staff: true, roles, t });
  }

  // Доступ к брони --------------------------------------------------------------------------

  /** Своя бронь гостя: переводит транзакцию в клуб брони. */
  async function own(db, bookingId, userId, { lock = false, participant = false } = {}) {
    const clubId = await ownBookingClub(db, bookingId, userId, { participant });
    if (!clubId) fail('not_found', 'booking');
    await useClub(db, clubId);
    return loadBooking(db, bookingId, { lock });
  }

  /**
   * Бронь для гостя-владельца или персонала клуба запроса (ctx.club, роли — от роутера).
   * @returns {{ b: object, staff: boolean }}
   */
  async function access(db, { bookingId, userId, club, roles, staffRoles, lock = false, participant = false }) {
    const ownClub = await ownBookingClub(db, bookingId, userId, { participant });
    if (ownClub) {
      await useClub(db, ownClub);
      return { b: await loadBooking(db, bookingId, { lock }), staff: false };
    }
    if (club && roles?.some((r) => staffRoles.includes(r))) {
      const b = await loadBooking(db, bookingId, { lock });
      if (b && b.club_id === club) return { b, staff: true };
    }
    fail('not_found', 'booking');
  }

  async function get(db, { bookingId, userId, club, roles }) {
    const { b, staff } = await access(db, { bookingId, userId, club, roles, staffRoles: STAFF_ROLES, participant: true });
    return view(db, b, { staff, roles: staff ? roles : [], viewer: userId });
  }

  /** GET /api/me/bookings — свои брони во всех клубах (последние 50). */
  async function listMine(db, { userId }) {
    const { rows } = await db.query(
      `select id, club_id from bl.bookings where user_id = $1 or $1 = any (participants) order by starts_at desc limit 50`,
      [userId],
    );
    const out = [];
    for (const r of rows) {
      await useClub(db, r.club_id);
      const b = await loadBooking(db, r.id);
      if (b) out.push(await view(db, b, { viewer: userId }));
    }
    return out;
  }

  /** GET /api/clubs/{club}/bookings?date= — брони рабочих суток клуба (персонал). */
  async function listClub(db, { clubId, date, roles = [] }) {
    const t = now();
    const d = date ?? (await workdayAt(db, clubId, t))?.date;
    if (typeof d !== 'string' || !DATE.test(d)) fail('bad_request', 'date');
    const w = await workdayWindow(db, clubId, d);
    if (!w) fail('not_found', 'club');
    const { rows } = await db.query(
      `select id from bl.bookings where club_id = $1 and period && tstzrange($2, $3, '[)') order by starts_at, id limit 500`,
      [clubId, w.from, w.to],
    );
    const out = [];
    for (const r of rows) out.push(await view(db, await loadBooking(db, r.id), { staff: true, roles, t }));
    return { date: d, from: iso(w.from), to: iso(w.to), bookings: out };
  }

  // Предоплата --------------------------------------------------------------------------------

  /** POST /api/bookings/{id}/pay — гость, Idempotency-Key: платёж ЮKassa (money). */
  async function pay(db, { bookingId, userId, body, requestKey }) {
    const b = await own(db, bookingId, userId, { lock: true });
    const t = now();
    if (b.status !== 'pending_payment') fail(b.status === 'expired' ? 'booking_expired' : 'already_paid');
    if (ms(b.pay_until) <= ms(t)) fail('booking_expired', 'время оплаты вышло');
    const method = body?.method ?? 'sbp';
    if (!['sbp', 'card'].includes(method)) fail('bad_request', 'method');
    const amount = b.prepayment_kopecks - b.prepaid_kopecks;
    // return_url — только путь своего сайта (/app/…); хост — PUBLIC_HOST сервера.
    let path = bookingUrl(b);
    if (body?.return_url !== undefined) {
      path = localPath(body.return_url);
      if (!path) fail('bad_request', 'return_url');
    }
    const host = config.publicHost ? `https://${config.publicHost}` : null;
    const result = await deps.payments.createPrepayment(db, {
      clubId: b.club_id,
      bookingId: b.id,
      resourceId: b.resource_id,
      userId,
      amountKopecks: amount,
      method,
      requestKey: requestKey ?? null,
      ...(host ? { returnUrl: `${host}${path}` } : {}),
      description: `Предоплата брони, ${resourceName(b.resource_type, b.resource_number, { capital: false })}`,
    });
    const paymentId = result?.payment?.id;
    if (!isUuid(paymentId)) throw new Error('createPrepayment: нет payment.id');
    if (b.prepayment_id !== paymentId) await updateBooking(db, b.id, { prepayment_id: paymentId, updated_at: t });
    return { booking: await view(db, await loadBooking(db, b.id), { t }), payment_id: paymentId, confirmation: result.confirmation ?? null };
  }

  /** Бронь платежа: по booking_id события, предоплате или котировке старта. */
  async function bookingOfPayment(db, p) {
    const { rows } = await db.query(
      `select id from bl.bookings
        where ($1::uuid is not null and prepayment_id = $1) or ($2::uuid is not null and start_quote_id = $2)
           or ($3::uuid is not null and id = $3)
        order by (prepayment_id = $1) desc nulls last limit 1`,
      [isUuid(p.payment_id) ? p.payment_id : null, isUuid(p.quote_id) ? p.quote_id : null, isUuid(p.booking_id) ? p.booking_id : null],
    );
    return rows[0] ? loadBooking(db, rows[0].id, { lock: true }) : null;
  }

  /**
   * outbox payment.confirmed (money): предоплата брони (kind booking, любая из попыток оплаты,
   * №116) → confirmed; доплата при старте (kind booking_start, котировка createBookingQuote) →
   * старт. Лишняя оплаченная попытка, поздний платёж за сгоревшую или отменённую бронь —
   * возврат целиком (forfeitPrepayment percent 0). Идемпотентно.
   */
  async function onPaymentConfirmed(db, p) {
    if (!p || typeof p !== 'object' || !isUuid(p.payment_id)) return { result: 'ignored' };
    if (!['booking', 'booking_start'].includes(p.kind) && !isUuid(p.booking_id)) {
      // Платёж не брони (игра, бар, пакет): быстрый выход без запроса, кроме котировки старта.
      if (!isUuid(p.quote_id)) return { result: 'ignored' };
    }
    const b = await bookingOfPayment(db, p);
    if (!b) return { result: 'ignored' };
    const t = now();
    const amount = Number(p.amount_kopecks);
    const isPrepayment = p.kind === 'booking' || (b.prepayment_id === p.payment_id && p.kind !== 'booking_start');
    if (isPrepayment) {
      if (b.status === 'pending_payment') {
        const paid = Math.min(b.prepayment_kopecks, Number.isSafeInteger(amount) ? amount : 0);
        await updateBooking(db, b.id, { status: 'confirmed', prepaid_kopecks: paid, prepayment_id: p.payment_id, pay_until: null, updated_at: t });
        const nb = await loadBooking(db, b.id, { lock: true });
        await audit(db, { action: 'booking.confirm', objectType: 'booking', objectId: b.id, actorType: 'system', data: { booking_id: b.id, payment_id: p.payment_id, amount_kopecks: paid } });
        await emit(db, 'booking.confirmed', nb, { payment_id: p.payment_id });
        await notifyGuest(db, nb, {
          kind: 'booking.confirmed',
          text: `Бронь подтверждена: ${resourceName(nb.resource_type, nb.resource_number, { capital: false })}, ${when(nb)}. Предоплата ${formatMoney(paid)}.`,
          actions: [{ id: 'open', title: 'Моя бронь', url: bookingUrl(nb) }],
        });
        return { result: 'confirmed', booking_id: b.id };
      }
      if (b.prepayment_id === p.payment_id && LIVE.includes(b.status)) return { result: 'duplicate', booking_id: b.id };
      if (b.prepayment_id === p.payment_id && b.status === 'completed') return { result: 'duplicate', booking_id: b.id };
      if (b.status === 'canceled' && b.prepaid_kopecks > 0 && b.prepayment_id === p.payment_id) return { result: 'duplicate', booking_id: b.id };
      // Бронь уже не ждёт этот платёж (вторая оплаченная попытка, сгорела, отменена): вернуть целиком.
      await deps.payments.forfeitPrepayment(db, { paymentId: p.payment_id, percent: 0, reason: 'Бронь уже не действует: предоплата пришла поздно' });
      await audit(db, { action: 'booking.late_payment', objectType: 'booking', objectId: b.id, actorType: 'system', data: { booking_id: b.id, payment_id: p.payment_id, status: b.status, amount_kopecks: amount } });
      await notifyGuest(db, b, { kind: 'booking.refund', text: `Оплата брони ${resourceName(b.resource_type, b.resource_number, { case: 'gen', capital: false })} пришла, когда бронь уже не действовала. Деньги вернутся.` });
      log.warn('booking_late_payment', { booking_id: b.id, payment_id: p.payment_id, status: b.status });
      return { result: 'refunded', booking_id: b.id };
    }
    // Доплата при старте (котировка createBookingQuote).
    if (b.status === 'started') {
      const { rows: linked } = await db.query('select 1 from bl.session_payments where payment_id = $1', [p.payment_id]);
      if (linked.length > 0) return { result: 'duplicate', booking_id: b.id };
      // Лишняя оплаченная доплата (вторая вкладка, повтор): игра уже идёт — вернуть целиком.
      if (Number.isSafeInteger(amount) && amount > 0) {
        await deps.payments.refund(db, { paymentId: p.payment_id, amountKopecks: amount, reason: 'Игра по брони уже идёт: лишняя доплата' });
      }
      await audit(db, { action: 'booking.extra_refund', objectType: 'booking', objectId: b.id, actorType: 'system', data: { booking_id: b.id, payment_id: p.payment_id, amount_kopecks: amount } });
      await notifyGuest(db, b, { kind: 'booking.refund', text: `Игра по брони на ${resourceName(b.resource_type, b.resource_number, { case: 'pre', capital: false })} уже идёт — лишняя оплата ${formatMoney(amount)} вернётся.` });
      log.warn('booking_extra_payment', { booking_id: b.id, payment_id: p.payment_id });
      return { result: 'refunded', booking_id: b.id };
    }
    const ids = [b.prepaid_kopecks > 0 ? b.prepayment_id : null, p.payment_id].filter(isUuid);
    return startPaid(db, b, ids, t, { extraPaymentId: p.payment_id, extraAmount: amount });
  }

  /** Старт после оплаты: стол занят или бронь не действует — доплата возвращается, предоплата остаётся. */
  async function startPaid(db, b, paymentIds, t, { extraPaymentId = null, extraAmount = 0 } = {}) {
    const ok = OPEN.includes(b.status) && b.status !== 'pending_payment' && ms(t) < ms(b.starts_at) + b.hold_minutes * MIN;
    if (ok) {
      await db.query('savepoint bl_booking_start');
      try {
        const sessionId = await doStart(db, b, { userId: b.user_id, paymentIds });
        await db.query('release savepoint bl_booking_start');
        return { result: 'started', booking_id: b.id, session_id: sessionId };
      } catch (err) {
        await db.query('rollback to savepoint bl_booking_start');
        if (!isConflict(err)) throw err;
        log.warn('booking_start_after_payment_failed', { booking_id: b.id, code: err.code });
      }
    }
    // Стол занят или бронь не действует: вернуть доплату, предоплата остаётся за бронью.
    if (extraPaymentId && Number.isSafeInteger(extraAmount) && extraAmount > 0) {
      await deps.payments.refund(db, { paymentId: extraPaymentId, amountKopecks: extraAmount, reason: 'Игра по брони не началась: стол недоступен' });
      await audit(db, { action: 'booking.extra_refund', objectType: 'booking', objectId: b.id, actorType: 'system', data: { booking_id: b.id, payment_id: extraPaymentId, amount_kopecks: extraAmount, status: b.status } });
    }
    await notifyGuest(db, b, { kind: 'booking.start_failed', text: `Не удалось начать игру по брони на ${resourceName(b.resource_type, b.resource_number, { case: 'pre', capital: false })}. Деньги за доплату вернутся.`, level: 'important' });
    return { result: 'refunded', booking_id: b.id };
  }

  // Старт по брони ---------------------------------------------------------------------------

  async function doStart(db, b, { userId, paymentIds }) {
    // Игра кончается ровно в конце брони (№123): light ставит paid_until = paidUntil.
    const sessionId = await deps.light.startFromBooking(db, {
      booking: { id: b.id, club_id: b.club_id, resource_id: b.resource_id, starts_at: iso(b.starts_at), ends_at: iso(b.ends_at) },
      userId,
      paidUntil: iso(b.ends_at),
      paymentIds: [...new Set(paymentIds.filter(isUuid))],
    });
    if (b.prepayment_id && b.prepaid_kopecks > 0) {
      await deps.payments.settlePrepayment(db, { paymentId: b.prepayment_id, sessionId });
    }
    await markStarted(db, { bookingId: b.id, sessionId });
    return sessionId;
  }

  /**
   * Бронь началась (контракт §3): status started, session_id, outbox booking.started. Повтор
   * с той же сессией — без изменений.
   */
  async function markStarted(db, { bookingId, sessionId = null }) {
    const b = await loadBooking(db, bookingId, { lock: true });
    if (!b) fail('not_found', 'booking');
    if (b.status === 'started') {
      if (sessionId && !b.session_id) await updateBooking(db, b.id, { session_id: sessionId, updated_at: now() });
      return { ok: true, already: true };
    }
    if (!['confirmed', 'reserved'].includes(b.status)) fail('booking_not_active', b.status);
    const t = now();
    await updateBooking(db, b.id, { status: 'started', session_id: sessionId, started_at: t, updated_at: t });
    const nb = await loadBooking(db, b.id);
    await audit(db, { action: 'booking.start', objectType: 'booking', objectId: b.id, data: { booking_id: b.id, session_id: sessionId, resource_id: b.resource_id } });
    await emit(db, 'booking.started', nb, { session_id: sessionId });
    return { ok: true, already: false };
  }

  /**
   * POST /api/bookings/{id}/start — гость-владелец у стола ({code} с QR). Без доплаты — игра
   * начинается сразу ({status: 'started', session_id}); нужна доплата (бронь без полной
   * предоплаты, ранний приход) — {status: 'payment_required', quote | confirmation}.
   */
  async function start(db, { bookingId, userId, body }) {
    // Начать игру по брони может владелец или участник брони на двоих — платит начавший.
    const b = await own(db, bookingId, userId, { lock: true, participant: true });
    const t = now();
    const res = await lockResource(db, b.resource_id);
    const code = normalizeCode(body?.code);
    if (!code || !res || code !== res.code) fail('forbidden', 'код стола');
    if (b.status === 'started') return { status: 'started', session_id: b.session_id, booking: await view(db, b, { t }) };
    if (b.status === 'pending_payment') fail('payment_pending');
    if (b.status === 'expired') fail('booking_expired');
    if (!OPEN.includes(b.status)) fail('booking_not_active', b.status);
    const club = await loadClub(db, b.club_id);
    const settings = bookingSettings(club.settings);
    const startMs = ms(b.starts_at);
    if (ms(t) >= startMs + b.hold_minutes * MIN || ms(t) >= ms(b.ends_at)) fail('booking_expired');
    if (ms(t) < startMs - settings.earlyMaxMinutes * MIN) fail('too_early');
    // Стол: чужая игра, сервис, чужой pending; при раннем приходе — чужая бронь до нашей.
    if (await openSession(db, b.resource_id)) fail('table_busy');
    for (const h of await activeHolds(db, b.resource_id, t)) {
      if (h.kind === 'service') fail('table_service');
      if (h.kind === 'pending' && h.user_id !== userId) fail('table_pending');
    }
    const early = ms(t) < startMs - settings.earlyFreeMinutes * MIN;
    let extra = 0;
    if (early) {
      if ((await overlapping(db, b.resource_id, t, b.starts_at, b.id)).length > 0) fail('booking_conflict', 'ранний приход');
      const busyUntil = await tournamentBusyUntil(db, b.resource_id, t, b.starts_at);
      if (busyUntil) fail('table_busy', 'турнир, ранний приход', 409, { reason: 'tournament', busy_until: new Date(busyUntil).toISOString() });
      // Корт: неполный слот — по минутам (находка pentester M5.8 Н-1); бронь и обычный старт — целыми слотами.
      extra = await priceOf(db, b.resource_id, t, Math.max(1, Math.floor((startMs - ms(t)) / MIN)), false, isSlotType(res.type));
    }
    // Опоздал (пришёл после начала) — цена только с прихода до конца брони (№113); иначе цена брони.
    const late = ms(t) > startMs;
    // Минуты — вниз, в пользу гостя (№123, как №73).
    const base = late ? await priceOf(db, b.resource_id, t, Math.max(1, Math.floor((ms(b.ends_at) - ms(t)) / MIN)), false, isSlotType(res.type)) : b.amount_kopecks;
    const due = Math.max(0, base - b.prepaid_kopecks) + extra;
    if (due === 0) {
      const sessionId = await doStart(db, b, { userId, paymentIds: b.prepayment_id && b.prepaid_kopecks > 0 ? [b.prepayment_id] : [] });
      return { status: 'started', session_id: sessionId, booking: await view(db, await loadBooking(db, b.id), { t }) };
    }
    // Доплата (ранний приход, остаток предоплаты, бронь без предоплаты — №113, №116): котировка money,
    // гость платит POST /api/quotes/{id}/pay, старт — по payment.confirmed {kind: 'booking_start'}.
    const paidMinutes = Math.max(1, Math.floor((ms(b.ends_at) - ms(t)) / MIN));
    // Живая неоплаченная котировка этой брони — та же (повтор, вторая вкладка); оплаченная и ещё
    // не подтверждённая — payment_pending: вторую доплату не создаём.
    const live = await liveStartQuote(db, b, t);
    if (live?.paid) fail('payment_pending', 'доплата ждёт подтверждения');
    if (live) {
      return {
        status: 'payment_required',
        amount_kopecks: live.amount_kopecks,
        quote: { quote_id: live.id, amount_kopecks: live.amount_kopecks, minutes: live.minutes, valid_until: iso(live.valid_until) },
        booking: await view(db, b, { t }),
      };
    }
    const quote = await deps.payments.createBookingQuote(db, {
      clubId: b.club_id, bookingId: b.id, resourceId: b.resource_id, userId, from: t, minutes: paidMinutes, amountKopecks: due,
      earlyMinutes: early ? Math.max(1, Math.floor((startMs - ms(t)) / MIN)) : 0,
    });
    const quoteId = quote?.quote_id ?? quote?.id;
    if (!isUuid(quoteId)) throw new Error('createBookingQuote: нет quote_id');
    await updateBooking(db, b.id, { start_quote_id: quoteId, updated_at: t });
    const quoted = Number(quote.amount_kopecks ?? due);
    return {
      status: 'payment_required',
      amount_kopecks: quoted,
      quote: { quote_id: quoteId, amount_kopecks: quoted, minutes: quote.minutes ?? paidMinutes, valid_until: iso(quote.valid_until) },
      booking: await view(db, await loadBooking(db, b.id), { t }),
    };
  }

  /** Котировка старта брони (money, bl.quotes): живая неиспользованная или оплаченная без подтверждения. */
  async function liveStartQuote(db, b, t) {
    if (!b.start_quote_id) return null;
    await db.query('savepoint bl_booking_quote');
    try {
      const { rows } = await db.query(
        `select q.id, q.amount_kopecks, q.minutes, q.valid_until, q.used_at,
                exists (select 1 from bl.payments p where p.quote_id = q.id and p.status in ('pending', 'waiting_for_capture')
                          and p.confirmed_at is null) as paid
           from bl.quotes q where q.id = $1`,
        [b.start_quote_id],
      );
      await db.query('release savepoint bl_booking_quote');
      const q = rows[0];
      if (!q) return null;
      if (q.used_at) return q.paid ? { paid: true } : null;
      if (ms(q.valid_until) <= ms(t)) return null;
      return { id: q.id, amount_kopecks: Number(q.amount_kopecks), minutes: q.minutes, valid_until: q.valid_until, paid: false };
    } catch (err) {
      await db.query('rollback to savepoint bl_booking_quote');
      log.warn('booking_quote_read_failed', { booking_id: b.id, code: err.code });
      return null;
    }
  }

  /**
   * POST /api/bookings/{id}/arrive — ресепшн и выше: гость брони по телефону пришёл. Снимает
   * reserved со стола (ресепшн начинает игру обычной оплатой), бронь — started.
   */
  async function arrive(db, { bookingId, userId, club, roles }) {
    const { b, staff } = await access(db, { bookingId, userId, club, roles, staffRoles: STAFF_ROLES, lock: true });
    if (!staff) fail('forbidden');
    if (b.status === 'started') return view(db, b, { staff: true, roles });
    if (!['confirmed', 'reserved'].includes(b.status)) fail('booking_not_active', b.status);
    // Только бронь по телефону или персонала без предоплаты и только в окне прихода: бронь гостя
    // приложения и предоплата начинаются у стола (старт по брони, чек зачёта).
    if (!['phone', 'staff'].includes(b.source) || b.prepayment_id || b.prepaid_kopecks > 0) fail('forbidden', 'arrive: не бронь по телефону');
    const settings = bookingSettings((await loadClub(db, b.club_id)).settings);
    const t = now();
    if (ms(t) < ms(b.starts_at) - settings.earlyMaxMinutes * MIN || ms(t) >= ms(b.starts_at) + b.hold_minutes * MIN) fail('forbidden', 'arrive: вне окна прихода');
    await deps.light.clearReserved(db, { resourceId: b.resource_id, source: 'booking', refId: b.id });
    await markStarted(db, { bookingId: b.id, sessionId: null });
    await audit(db, { action: 'booking.arrive', objectType: 'booking', objectId: b.id, data: { booking_id: b.id, resource_id: b.resource_id } });
    return view(db, await loadBooking(db, b.id), { staff: true, roles });
  }

  // Отмена ----------------------------------------------------------------------------------

  /**
   * POST /api/bookings/{id}/cancel. Гость — свою: раньше booking_free_cancel_minutes до начала
   * предоплата возвращается целиком, позже — удерживается booking_forfeit_percent (money).
   * Управляющий и владелец — любую бронь клуба, ресепшн — брони по телефону и персонала без
   * предоплаты (№115); всегда с причиной (ручное действие: журнал manual.*, тревога владельцу),
   * предоплата возвращается целиком.
   */
  async function cancel(db, { bookingId, userId, club, roles, reason }) {
    const { b, staff } = await access(db, { bookingId, userId, club, roles, staffRoles: STAFF_ROLES, lock: true });
    const t = now();
    // №115: ресепшн — только брони по телефону и персонала без предоплаты; остальные — управляющий и владелец.
    if (staff && OPEN.includes(b.status) && !staffCanCancel(b, roles)) fail('forbidden', 'отмена брони — управляющий');
    const why = cleanText(reason, 2000);
    if (staff && !why) fail('reason_required');
    if (!OPEN.includes(b.status)) fail(b.status === 'expired' ? 'booking_expired' : 'booking_not_active', b.status);
    const clubRow = await loadClub(db, b.club_id);
    const settings = bookingSettings(clubRow.settings);
    let percent = 0;
    if (!staff && t > new Date(ms(b.starts_at) - settings.freeCancelMinutes * MIN)) percent = await forfeitPercentOf(db, clubRow);
    let money = null;
    if (b.prepaid_kopecks > 0 && b.prepayment_id) {
      money = await deps.payments.forfeitPrepayment(db, {
        paymentId: b.prepayment_id,
        percent,
        reason: staff ? `Бронь отменена клубом: ${why}` : percent === 0 ? 'Бронь отменена гостем вовремя' : 'Бронь отменена гостем поздно',
      });
    }
    if (b.status === 'reserved' || ms(t) >= ms(b.starts_at) - RESERVE_BEFORE_MS) {
      await deps.light.clearReserved(db, { resourceId: b.resource_id, source: 'booking', refId: b.id });
    }
    await updateBooking(db, b.id, {
      status: 'canceled', canceled_at: t, canceled_by: userId, cancel_reason: why, forfeit_percent: b.prepaid_kopecks > 0 ? percent : null, updated_at: t,
    });
    const nb = await loadBooking(db, b.id);
    const refundKopecks = b.prepaid_kopecks > 0 ? refundFor(b.prepaid_kopecks, percent) : 0;
    const data = { booking_id: b.id, resource_id: b.resource_id, starts_at: iso(b.starts_at), prepaid_kopecks: b.prepaid_kopecks, forfeit_percent: percent, refund_kopecks: refundKopecks };
    if (staff) {
      await audit(db, { action: 'manual.booking_cancel', objectType: 'booking', objectId: b.id, reason: why, data });
      await deps.alarms.raise(db, b.club_id, {
        type: 'manual_action',
        manual: true,
        resourceId: b.resource_id,
        data: { action: 'booking_cancel', booking_id: b.id },
        text: `Отмена брони ${resourceName(b.resource_type, b.resource_number, { case: 'gen', capital: false })} на ${when(b)}: ${why}`,
      });
      await notifyGuest(db, nb, {
        kind: 'booking.canceled',
        level: 'important',
        text: `Клуб отменил бронь ${resourceName(b.resource_type, b.resource_number, { case: 'gen', capital: false })} на ${when(b)}.${b.prepaid_kopecks > 0 ? ` Предоплата ${formatMoney(b.prepaid_kopecks)} вернётся.` : ''}`,
      });
    } else {
      await audit(db, { action: 'booking.cancel', objectType: 'booking', objectId: b.id, data });
    }
    await emit(db, 'booking.canceled', nb, { by: staff ? 'staff' : 'guest' });
    log.info('booking_canceled', { booking_id: b.id, by: staff ? 'staff' : 'guest', forfeit_percent: percent });
    return { ...(await view(db, nb, { staff, roles: staff ? roles : [], t })), refund_kopecks: refundKopecks, money: money ? { refunded_kopecks: money.refunded_kopecks ?? null } : null };
  }

  // Планировщик -------------------------------------------------------------------------------

  /**
   * Шаг брони по времени (ctx.clock): неоплаченная — сгорает после pay_until; за час —
   * напоминание; за 15 минут — напоминание и state.reserved (setReserved light); после
   * удержания — сгорание и предоплата по правилам клуба (forfeitPrepayment money); идущая —
   * завершается после конца.
   */
  async function step(db, bookingId) {
    const b = await loadBooking(db, bookingId, { lock: true });
    if (!b) return null;
    const t = now();
    const startMs = ms(b.starts_at);
    const flags = { ...(b.notified ?? {}) };
    if (b.status === 'pending_payment') {
      if (ms(b.pay_until) > ms(t)) return null;
      await expire(db, b, 'unpaid', t);
      return 'expired';
    }
    if (b.status === 'started') {
      if (ms(b.ends_at) > ms(t)) return null;
      if (b.session_id) {
        const { rows } = await db.query('select status from bl.sessions where id = $1', [b.session_id]);
        if (rows[0] && ['active', 'ending', 'grace'].includes(rows[0].status)) return null;
      }
      await complete(db, b, t);
      return 'completed';
    }
    if (!['confirmed', 'reserved'].includes(b.status)) return null;
    if (ms(t) >= startMs + b.hold_minutes * MIN) {
      // №128: удерживаем предоплату, только если стол был доступен гостю всё окно удержания.
      const unavailable = flags.unavailable || (await unavailableInWindow(db, b, startMs, startMs + b.hold_minutes * MIN));
      await expire(db, b, unavailable ? 'table_unavailable' : 'no_show', t);
      return 'expired';
    }
    let changed = false;
    // В окне удержания отмечаем, если стол сейчас недоступен гостю (тик раз в 10 с).
    if (ms(t) >= startMs && !flags.unavailable) {
      const why = await unavailableNow(db, b, t);
      if (why) {
        flags.unavailable = why;
        changed = true;
      }
    }
    if (!flags.h1 && ms(t) >= startMs - REMIND_BEFORE_MS) {
      flags.h1 = true;
      changed = true;
      if (ms(b.created_at) <= startMs - REMIND_BEFORE_MS && ms(t) < startMs - RESERVE_BEFORE_MS) {
        await notifyGuest(db, b, {
          kind: 'booking.reminder',
          text: `Через час бронь: ${resourceName(b.resource_type, b.resource_number, { capital: false })}, ${at(b)}.`,
          actions: [{ id: 'open', title: 'Моя бронь', url: bookingUrl(b) }],
        });
      }
    }
    if (ms(t) >= startMs - RESERVE_BEFORE_MS) {
      if (!flags.m15) {
        flags.m15 = true;
        changed = true;
        if (ms(b.created_at) <= startMs - RESERVE_BEFORE_MS) {
          await notifyGuest(db, b, {
            kind: 'booking.soon',
            text: `Бронь через 15 минут: ${resourceName(b.resource_type, b.resource_number, { capital: false })}, ${at(b)}. Отсканируйте QR на ${noun(b.resource_type, 'pre')} — игра начнётся.`,
            actions: [{ id: 'open', title: 'Моя бронь', url: bookingUrl(b) }],
          });
        }
      }
      if (b.status === 'confirmed' && b.hold_minutes > 0) {
        const until = new Date(startMs + b.hold_minutes * MIN);
        let r;
        await db.query('savepoint bl_booking_reserve');
        try {
          r = await deps.light.setReserved(db, { resourceId: b.resource_id, until, userId: b.user_id ?? null, source: 'booking', refId: b.id });
          await db.query('release savepoint bl_booking_reserve');
        } catch (err) {
          await db.query('rollback to savepoint bl_booking_reserve');
          if (!isConflict(err)) throw err;
          r = { applied: false, reason: err.code };
        }
        // №14 ревью: стол не показал бронь (занят, сервис, pending, нет стола) — reserved не ставим,
        // повторяем на следующих тиках; в окне удержания это и есть «стол недоступен» (№128).
        if (!r?.applied) {
          flags.reserve_tries = (flags.reserve_tries ?? 0) + 1;
          if (ms(t) >= startMs && !flags.unavailable) flags.unavailable = r?.reason ?? 'not_shown';
          await updateBooking(db, b.id, { notified: flags, updated_at: t });
          return null;
        }
        flags.reserved_hold = true;
        await updateBooking(db, b.id, { status: 'reserved', reserved_at: t, notified: flags, updated_at: t });
        const nb = await loadBooking(db, b.id);
        await audit(db, { action: 'booking.reserve', objectType: 'booking', objectId: b.id, actorType: 'system', data: { booking_id: b.id, resource_id: b.resource_id, until: iso(until), shown: r?.applied ?? null } });
        await emit(db, 'booking.reserved', nb, { hold_until: iso(until) });
        return 'reserved';
      }
    }
    if (changed) await updateBooking(db, b.id, { notified: flags, updated_at: t });
    return null;
  }

  /**
   * Почему стол сейчас недоступен гостю брони (или null): игра не этого гостя, сервис, чужой pending,
   * чужое удержание reserved, стол неактивен или без связи (light getResourceStatus).
   */
  async function unavailableNow(db, b, t) {
    const { rows } = await db.query('select active from bl.resources where id = $1', [b.resource_id]);
    if (!rows[0]?.active) return 'inactive';
    const s = await openSession(db, b.resource_id);
    if (s && s.payer_user_id !== b.user_id) return 'busy';
    for (const h of await activeHolds(db, b.resource_id, t)) {
      if (h.kind === 'service') return 'service';
      if (h.kind === 'pending' && h.user_id !== b.user_id) return 'pending';
      if (h.kind === 'reserved' && h.ref_id && h.ref_id !== b.id) return 'reserved_other';
    }
    // Связь со столом и прочее по истории знает light (availabilityDuring); без неё — статус стола.
    const light = await lightAvailability(db, b, t, t);
    if (light?.unavailable) return String(light.reasons?.[0] ?? 'unavailable').slice(0, 32);
    if (!light && typeof deps.light.getResourceStatus === 'function') {
      const st = await safely(db, () => deps.light.getResourceStatus(db, b.resource_id, { userId: b.user_id ?? null }), { log, what: 'light.getResourceStatus' });
      if (st?.status === 'offline') return 'offline';
      if (st?.status === 'service') return 'service';
    }
    return null;
  }

  /**
   * Доступность стола гостю брони за [from, to] по истории light (№128): offline, игра, сервис,
   * неактивен, чужое удержание → { unavailable, reasons, intervals } или null, если функции нет.
   * Своё удержание и игра гостя брони не в счёт — light получает userId, source и refId брони.
   */
  async function lightAvailability(db, b, from, to) {
    if (typeof deps.light.availabilityDuring !== 'function') return null;
    return safely(
      db,
      () => deps.light.availabilityDuring(db, {
        resourceId: b.resource_id, from: new Date(from), to: new Date(to), userId: b.user_id ?? null, source: 'booking', refId: b.id,
      }),
      { log, what: 'light.availabilityDuring' },
    );
  }

  /** Был ли стол недоступен гостю в окне удержания [from, to): чужая игра, сервис, чужие удержания. */
  async function unavailableInWindow(db, b, fromMs, toMs) {
    const from = new Date(fromMs);
    const to = new Date(toMs);
    const light = await lightAvailability(db, b, from, to);
    if (light?.unavailable) return true;
    const { rows: s } = await db.query(
      `select 1 from bl.sessions where resource_id = $1 and started_at < $3 and coalesce(ended_at, paid_until) > $2
          and payer_user_id is distinct from $4 limit 1`,
      [b.resource_id, from, to, b.user_id ?? null],
    );
    if (s.length > 0) return true;
    const { rows: h } = await db.query(
      `select 1 from bl.resource_holds where resource_id = $1 and created_at < $3 and coalesce(released_at, until) > $2
          and (kind = 'service' or (kind = 'pending' and user_id is distinct from $4) or (kind = 'reserved' and ref_id is not null and ref_id <> $5))
        limit 1`,
      [b.resource_id, from, to, b.user_id ?? null, b.id],
    );
    return h.length > 0;
  }

  async function expire(db, b, reason, t) {
    let forfeit = null;
    if (reason === 'no_show' && b.prepaid_kopecks > 0 && b.prepayment_id) {
      // percent не передаётся: money берёт booking_forfeit_percent клуба (по умолчанию 100 %, №108).
      forfeit = await deps.payments.forfeitPrepayment(db, { paymentId: b.prepayment_id, reason: 'Гость не пришёл на бронь' });
    }
    if (reason === 'table_unavailable' && b.prepaid_kopecks > 0 && b.prepayment_id) {
      forfeit = await deps.payments.forfeitPrepayment(db, { paymentId: b.prepayment_id, percent: 0, reason: 'Стол был недоступен в окне удержания брони' });
    }
    if (b.status !== 'pending_payment') await deps.light.clearReserved(db, { resourceId: b.resource_id, source: 'booking', refId: b.id });
    let percent = null;
    if (reason === 'no_show' && b.prepaid_kopecks > 0) percent = await forfeitPercentOf(db, await loadClub(db, b.club_id));
    if (reason === 'table_unavailable' && b.prepaid_kopecks > 0) percent = 0;
    if (reason === 'table_unavailable') {
      await deps.alarms.raise(db, b.club_id, {
        type: 'booking_table_unavailable',
        level: 'important',
        resourceId: b.resource_id,
        data: { booking_id: b.id, why: String(b.notified?.unavailable ?? 'history').slice(0, 32) },
        // Объект тревоги — бронь: вторая бронь того же стола — новая тревога и уведомление владельцу.
        dedupeKey: `booking:${b.id}`,
        text: `Бронь ${resourceName(b.resource_type, b.resource_number, { case: 'gen', capital: false })} на ${at(b)}: ${noun(b.resource_type)} был недоступен гостю, предоплата возвращена`,
      });
    }
    await updateBooking(db, b.id, { status: 'expired', expired_at: t, expire_reason: reason, forfeit_percent: percent, updated_at: t });
    const nb = await loadBooking(db, b.id);
    await audit(db, {
      action: 'booking.expire',
      objectType: 'booking',
      objectId: b.id,
      actorType: 'system',
      data: { booking_id: b.id, resource_id: b.resource_id, reason, prepaid_kopecks: b.prepaid_kopecks, forfeit_percent: percent, kept_kopecks: forfeit?.kept_kopecks ?? null },
    });
    await emit(db, 'booking.expired', nb, { reason });
    if (reason === 'table_unavailable') {
      await notifyGuest(db, nb, {
        kind: 'booking.expired',
        level: 'important',
        text: `Бронь ${resourceName(b.resource_type, b.resource_number, { case: 'gen', capital: false })} на ${at(b)} закрыта: ${noun(b.resource_type)} был недоступен.${b.prepaid_kopecks > 0 ? ` Предоплата ${formatMoney(b.prepaid_kopecks)} вернётся.` : ''}`,
      });
    }
    if (reason === 'no_show') {
      const refund = b.prepaid_kopecks > 0 && percent !== null ? refundFor(b.prepaid_kopecks, percent) : 0;
      await notifyGuest(db, nb, {
        kind: 'booking.expired',
        level: 'important',
        text:
          b.prepaid_kopecks > 0
            ? `Бронь ${resourceName(b.resource_type, b.resource_number, { case: 'gen', capital: false })} на ${at(b)} сгорела: вы не пришли за ${holdText(b)}.${refund > 0 ? ` Вернём ${formatMoney(refund)}.` : ' Предоплата по правилам клуба не возвращается.'}`
            : `Бронь ${resourceName(b.resource_type, b.resource_number, { case: 'gen', capital: false })} на ${at(b)} сгорела: вы не пришли за ${holdText(b)}.`,
      });
    }
    log.info('booking_expired', { booking_id: b.id, reason });
  }

  async function complete(db, b, t) {
    await updateBooking(db, b.id, { status: 'completed', completed_at: t, updated_at: t });
    await audit(db, { action: 'booking.complete', objectType: 'booking', objectId: b.id, actorType: 'system', data: { booking_id: b.id, session_id: b.session_id ?? null } });
  }

  // События light -------------------------------------------------------------------------------

  /** session.closed: бронь этой сессии завершена; стол свободен — его может ждать бронь (reserved). */
  async function onSessionClosed(db, ev) {
    if (!ev || !isUuid(ev.resource_id)) return { result: 'ignored' };
    const t = now();
    if (isUuid(ev.session_id)) {
      const { rows } = await db.query("select id from bl.bookings where session_id = $1 and status = 'started'", [ev.session_id]);
      for (const r of rows) {
        const b = await loadBooking(db, r.id, { lock: true });
        if (b?.status === 'started') await complete(db, b, t);
      }
    }
    const { rows: waiting } = await db.query(
      `select id from bl.bookings where resource_id = $1 and status = 'confirmed' and starts_at <= $2 order by starts_at`,
      [ev.resource_id, new Date(ms(t) + RESERVE_BEFORE_MS)],
    );
    for (const r of waiting) await step(db, r.id);
    return { result: 'ok' };
  }

  /** session.started: бронь «гость пришёл» (arrive) без сессии получает сессию стола. */
  async function onSessionStarted(db, ev) {
    if (!ev || !isUuid(ev.resource_id) || !isUuid(ev.session_id)) return { result: 'ignored' };
    if (isUuid(ev.booking_id)) return { result: 'ignored' };
    const t = now();
    await db.query(
      `update bl.bookings set session_id = $2, updated_at = $3
        where resource_id = $1 and status = 'started' and session_id is null and started_at >= $4`,
      [ev.resource_id, ev.session_id, t, new Date(ms(t) - 30 * MIN)],
    );
    return { result: 'ok' };
  }

  // Интерфейс для других модулей (§3) -----------------------------------------------------------

  /**
   * Ближайшая живая бронь стола (pending_payment, confirmed, reserved), которая не кончилась к after:
   * { id, starts_at, ends_at, source, status } без имени и телефона, или null.
   */
  async function nextBooking(db, { resourceId, after }) {
    if (!isUuid(resourceId)) return null;
    const a = new Date(after ?? now());
    if (Number.isNaN(a.getTime())) return null;
    const { rows } = await db.query(
      `select id, starts_at, ends_at, source, status from bl.bookings
        where resource_id = $1 and status = any($2::text[]) and ends_at > $3
        order by starts_at, id limit 1`,
      [resourceId, OPEN, a],
    );
    const r = rows[0];
    return r ? { id: r.id, starts_at: iso(r.starts_at), ends_at: iso(r.ends_at), source: r.source, status: r.status } : null;
  }

  /** Начало ближайшей живой брони стола (nextBooking), Date или null. */
  async function nextBookingStart(db, { resourceId, after }) {
    const b = await nextBooking(db, { resourceId, after });
    return b ? new Date(b.starts_at) : null;
  }

  /** Бронь гостя на этом столе, которую можно начать сейчас (для экрана стола и light). */
  async function bookingForArrival(db, { resourceId, userId, at: atTime }) {
    if (!isUuid(resourceId) || !isUuid(userId)) return null;
    const t = new Date(atTime ?? now());
    const { rows } = await db.query(
      `select b.id, b.club_id from bl.bookings b
        where b.resource_id = $1 and b.user_id = $2 and b.status in ('confirmed', 'reserved')
          and b.starts_at + make_interval(mins => b.hold_minutes) > $3
        order by b.starts_at limit 1`,
      [resourceId, userId, t],
    );
    if (!rows[0]) return null;
    const b = await loadBooking(db, rows[0].id);
    const club = await loadClub(db, b.club_id);
    const settings = bookingSettings(club?.settings);
    if (ms(t) < ms(b.starts_at) - settings.earlyMaxMinutes * MIN) return null;
    return {
      id: b.id,
      club_id: b.club_id,
      resource_id: b.resource_id,
      user_id: b.user_id,
      status: b.status,
      starts_at: iso(b.starts_at),
      ends_at: iso(b.ends_at),
      hold_until: iso(ms(b.starts_at) + b.hold_minutes * MIN),
      prepaid_kopecks: b.prepaid_kopecks,
      amount_kopecks: b.amount_kopecks,
      prepayment_id: b.prepayment_id,
      early: ms(t) < ms(b.starts_at) - settings.earlyFreeMinutes * MIN,
    };
  }

  return {
    view,
    create,
    createByStaff,
    get,
    listMine,
    listClub,
    pay,
    start,
    arrive,
    cancel,
    step,
    markStarted,
    nextBooking,
    nextBookingStart,
    tournamentHolds,
    bookingForArrival,
    onPaymentConfirmed,
    onSessionClosed,
    onSessionStarted,
    BookingError,
  };
}
