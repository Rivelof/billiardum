// Стол и котировка (контракт M1 §5): GET /api/t/{code}, POST /api/quotes.
//
// * Котировка держится 3 минуты и используется один раз (pay или заявка ресепшена).
// * kind start ставит столу pending на 3 минуты за этим гостем (light: holdPending):
//   второй гость получает 409 table_pending.
// * kind extend считает от paid_until сессии; продлить может любой участник (№46).
// * minutes null — «Без лимита»: сумма заморозки за unlimited_hold_minutes (карта) и
//   первый блок sbp_block_minutes (СБП, decisions №26).
// * DEV_ALLOW_ANY_MINUTES=1 (не в проде, №54) — любые минуты от 1, без шага и минимума.

import { amountFor, pricesAround, TariffError } from '../tariffs/index.mjs';
import { enterClub, isUuid, requireGuestReady } from './context.mjs';
import { MoneyError, checkNeighborResult, fromNeighbor } from './errors.mjs';
import { loadPaymentSettings } from './settings.mjs';

export const QUOTE_TTL_MS = 3 * 60_000;
export const FIXED_MINUTES = Object.freeze([30, 60, 120, 180]);
export const OPEN_SESSION = Object.freeze(['active', 'ending', 'grace']);

function tariffFail(err) {
  if (err instanceof TariffError) {
    if (err.code === 'no_tariff') return new MoneyError('no_tariff', err.message);
    if (err.code === 'not_found') return new MoneyError('not_found', err.message);
  }
  return err;
}

/** Строка стола и клуба в контексте клуба. */
async function loadTable(db, resourceId) {
  const { rows } = await db.query(
    `select r.id, r.number, r.type, r.title, r.active, c.id as club_id, c.name as club_name, c.timezone
       from bl.resources r join bl.clubs c on c.id = r.club_id
      where r.id = $1`,
    [resourceId],
  );
  return rows[0] ?? null;
}

const CODE = /^[0-9A-Za-z-]{4,32}$/;

/** GET /api/t/{code}: стол по коду без входа. */
export async function tableByCode(db, deps, { code, userId = null }) {
  if (typeof code !== 'string' || !CODE.test(code)) throw new MoneyError('not_found', 'код');
  let found;
  try {
    found = await deps.sessions.getResourceByCode(db, code);
  } catch (err) {
    throw fromNeighbor(err);
  }
  if (!found?.resource?.id || !found?.club?.id) throw new MoneyError('not_found', 'стол');
  await enterClub(db, found.club.id);
  const t = await loadTable(db, found.resource.id);
  if (!t || !t.active) throw new MoneyError('not_found', 'стол');
  const now = deps.clock.now();
  const status = await deps.sessions.getResourceStatus(db, t.id);
  let prices;
  try {
    prices = await pricesAround(db, { resourceId: t.id, at: now });
  } catch (err) {
    throw tariffFail(err);
  }
  const settings = await loadPaymentSettings(db, t.club_id);
  let mySession = null;
  if (userId && status?.session_id) {
    try {
      const s = await deps.sessions.getSessionForExtend(db, { sessionId: status.session_id, userId });
      if (s?.is_participant) mySession = status.session_id;
    } catch {
      mySession = null;
    }
  }
  const options = [60, 120, 180];
  if (settings.card || settings.sbp) options.push('unlimited');
  return {
    club: { id: t.club_id, name: t.club_name, timezone: t.timezone },
    resource: { id: t.id, number: t.number, type: t.type, title: t.title },
    status: status?.status ?? 'offline',
    busy_until: status?.busy_until ?? null,
    session_id: status?.session_id ?? null,
    price_now: prices.price_now,
    price_next: prices.price_next,
    options,
    my_session_id: mySession,
  };
}

/** Проверка тела POST /api/quotes. */
export function parseQuoteRequest(body, { devAllowAnyMinutes = false } = {}) {
  if (!body || typeof body !== 'object') throw new MoneyError('bad_request', 'тело');
  const { resource_id: resourceId, kind, minutes, session_id: sessionId } = body;
  if (!isUuid(resourceId)) throw new MoneyError('bad_request', 'resource_id');
  if (kind !== 'start' && kind !== 'extend') throw new MoneyError('bad_request', 'kind');
  if (kind === 'extend' && !isUuid(sessionId)) throw new MoneyError('bad_request', 'session_id');
  if (minutes !== null) {
    if (!Number.isInteger(minutes)) throw new MoneyError('bad_request', 'minutes');
    const ok = devAllowAnyMinutes ? minutes >= 1 && minutes <= 1440 : FIXED_MINUTES.includes(minutes);
    if (!ok) throw new MoneyError('bad_request', 'minutes');
  }
  return { resourceId, kind, minutes, sessionId: kind === 'extend' ? sessionId : null, exact: devAllowAnyMinutes && minutes !== null && !FIXED_MINUTES.includes(minutes) };
}

/**
 * POST /api/quotes. db — транзакция запроса; клуб берётся по столу.
 * @returns ответ контракта {quote_id, amount_kopecks, minutes, valid_until, breakdown} и поля «Без лимита»
 */
export async function createQuote(db, deps, info, config) {
  const req = parseQuoteRequest(info.body, { devAllowAnyMinutes: config.devAllowAnyMinutes });
  const { rows } = await db.query('select bl.resource_club($1) as club_id', [req.resourceId]);
  const clubId = rows[0].club_id;
  if (!clubId) throw new MoneyError('not_found', 'стол');
  await enterClub(db, clubId);
  const { userId } = await requireGuestReady(db, info);
  const table = await loadTable(db, req.resourceId);
  if (!table || !table.active) throw new MoneyError('not_found', 'стол');
  const now = deps.clock.now();
  const validUntil = new Date(now.getTime() + QUOTE_TTL_MS);
  const settings = await loadPaymentSettings(db, clubId);

  let from = now;
  if (req.kind === 'extend') {
    let session;
    try {
      session = await deps.sessions.getSessionForExtend(db, { sessionId: req.sessionId, userId });
    } catch (err) {
      throw fromNeighbor(err);
    }
    if (!session || session.resource_id !== req.resourceId) throw new MoneyError('not_found', 'сессия');
    if (!session.is_participant) throw new MoneyError('forbidden', 'не участник');
    if (!OPEN_SESSION.includes(session.status)) throw new MoneyError('session_not_active');
    // Новая заморозка («Без лимита» по карте) — только у сессии «Без лимита».
    if (req.minutes === null && !session.unlimited) throw new MoneyError('bad_request', 'unlimited extend');
    from = new Date(session.paid_until);
  }

  // Цена до удержания стола: если тарифа нет, стол не держим.
  let priced;
  let block = null;
  const unlimited = req.minutes === null;
  try {
    if (unlimited) {
      priced = await amountFor(db, { resourceId: req.resourceId, from, minutes: settings.unlimited_hold_minutes, minimum: req.kind === 'start' });
      block = await amountFor(db, { resourceId: req.resourceId, from, minutes: settings.sbp_block_minutes, minimum: req.kind === 'start' });
    } else {
      priced = await amountFor(db, { resourceId: req.resourceId, from, minutes: req.minutes, minimum: req.kind === 'start', exact: req.exact });
    }
  } catch (err) {
    throw tariffFail(err);
  }

  if (req.kind === 'start') {
    try {
      checkNeighborResult(await deps.sessions.holdPending(db, { resourceId: req.resourceId, userId, until: validUntil }));
    } catch (err) {
      throw fromNeighbor(err);
    }
  }

  const ins = await db.query(
    `insert into bl.quotes (club_id, resource_id, user_id, kind, session_id, unlimited, minutes, from_at, amount_kopecks,
                            breakdown, hold_minutes, block_minutes, block_amount_kopecks, created_at, valid_until)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
     returning id`,
    [
      clubId,
      req.resourceId,
      userId,
      req.kind,
      req.sessionId,
      unlimited,
      unlimited ? null : priced.minutes,
      from,
      priced.amount_kopecks,
      JSON.stringify(priced.breakdown),
      unlimited ? priced.minutes : null,
      unlimited ? block.minutes : null,
      unlimited ? block.amount_kopecks : null,
      now,
      validUntil,
    ],
  );
  const out = {
    quote_id: ins.rows[0].id,
    amount_kopecks: priced.amount_kopecks,
    minutes: unlimited ? null : priced.minutes,
    valid_until: validUntil.toISOString(),
    breakdown: priced.breakdown.map(({ from: f, to, price_per_hour_kopecks: p, amount_kopecks: a }) => ({ from: f, to, price_per_hour_kopecks: p, amount_kopecks: a })),
  };
  if (unlimited) {
    out.unlimited = {
      hold_minutes: priced.minutes,
      hold_amount_kopecks: priced.amount_kopecks,
      sbp_block_minutes: block.minutes,
      sbp_block_amount_kopecks: block.amount_kopecks,
    };
  }
  return out;
}
