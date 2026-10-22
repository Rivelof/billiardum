// Маршруты входа (контракт M1 §4). Вход для разработки регистрируется только при
// NODE_ENV ≠ production и ALLOW_DEV_LOGIN=1; MAX — 501 not_configured до документации.

import { randomBytes } from 'node:crypto';
import {
  auditStaffLogin,
  clearSessionCookie,
  completeLogin,
  issueToken,
  LINK_COOKIE,
  LINK_COOKIE_PATH,
  maskPhone,
  myMemberships,
  newToken,
  PIN_TTL_MS,
  sessionCookie,
  STAFF_ROLES,
  TERMINAL_TTL_MS,
  tokenHash,
  userJson,
} from '../../server/auth/index.mjs';
import { createLink, handleTelegramUpdate, newDeviceNotice, NONCE, NONCE_TTL_MS, pollLink, secretMatches } from '../../server/auth/botlink.mjs';
import { checkStaffPin, hashPin, PIN, PIN_SWITCH_ROLES } from '../../server/auth/pin.mjs';
import { InitDataError, verifyInitData } from '../../server/auth/telegram.mjs';
import { HttpError } from '../../server/http/errors.mjs';
import { parseCookies, serializeCookie } from '../../server/http/request.mjs';
import { appendAudit } from '../../server/lib/audit.mjs';
import { isUuid, setContext } from '../../server/lib/store.mjs';

const PHONE = /^\+[1-9][0-9]{7,14}$/;
const MINUTE = 60_000;
/** PIN владельца и управляющего — 6 цифр. */
export const LONG_PIN = 6;
export const LONG_PIN_ROLES = ['owner', 'manager'];
/** Общий счётчик неверных PIN на терминал: столько за окно — блокировка терминала. */
export const TERMINAL_PIN_FAILURES = 10;
export const TERMINAL_PIN_WINDOW_MS = 3600_000;

/** Вход для разработки возможен: не прод и явный флаг. */
export function devLoginEnabled(config) {
  return config.nodeEnv !== 'production' && config.allowDevLogin === true;
}

function telegramReady(config) {
  return Boolean(config.telegram?.botToken && config.telegram?.botUsername && config.telegram?.webhookSecret);
}

async function devLogin(ctx, req) {
  if (!devLoginEnabled(ctx.config)) throw new HttpError(404, 'not_found');
  const phone = req.body.phone;
  if (typeof phone !== 'string' || !PHONE.test(phone)) throw new HttpError(400, 'bad_request');
  const userId = (await ctx.db.query("select bl.auth_user_for('phone', $1) as id", [phone])).rows[0].id;
  const out = await completeLogin(ctx, userId, { via: 'dev' });
  return { status: 200, json: { token: out.token, user: out.user } };
}

async function telegramLogin(ctx, req) {
  const token = ctx.config.telegram?.botToken;
  if (!token) throw new HttpError(501, 'not_configured');
  let verified;
  try {
    verified = verifyInitData(req.body.init_data, token, { now: ctx.clock.now() });
  } catch (err) {
    if (err instanceof InitDataError) throw new HttpError(401, 'unauthorized', { detail: `init_data ${err.reason}` });
    throw err;
  }
  const userId = (await ctx.db.query("select bl.auth_user_for('telegram', $1) as id", [String(verified.user.id)])).rows[0].id;
  const out = await completeLogin(ctx, userId, { via: 'telegram' });
  return { status: 200, json: { token: out.token, user: out.user, needs_phone: out.needs_phone } };
}

async function botLinkCreate(ctx, req) {
  const channel = req.body.channel;
  if (channel !== 'telegram' && channel !== 'max') throw new HttpError(400, 'bad_request');
  if (channel === 'max' || !telegramReady(ctx.config)) throw new HttpError(501, 'not_configured');
  const browserSecret = randomBytes(32).toString('base64url');
  const now = ctx.clock.now();
  const { nonce, code, expiresAt } = await createLink(ctx.db, { channel, browserSecret, now });
  ctx.setCookie(serializeCookie(LINK_COOKIE, browserSecret, { path: LINK_COOKIE_PATH, maxAgeSec: NONCE_TTL_MS / 1000 }));
  return {
    status: 200,
    json: {
      nonce,
      deep_link: `https://t.me/${ctx.config.telegram.botUsername}?start=${nonce}`,
      // Код подтверждения: показать на экране, гость вводит его в боте (ревью входа п. 2).
      code,
      expires_at: expiresAt.toISOString(),
    },
  };
}

async function botLinkPoll(ctx, req) {
  const { nonce } = req.params;
  if (!NONCE.test(nonce)) throw new HttpError(404, 'not_found');
  const browserSecret = parseCookies(req.headers.cookie)[LINK_COOKIE];
  const now = ctx.clock.now();
  const state = await pollLink(ctx.db, { nonce, browserSecret, now });
  if (!state) throw new HttpError(404, 'not_found');
  if (state.status === 'pending') return { status: 200, json: { status: 'pending' } };
  if (state.status === 'expired') return { status: 200, json: { status: 'expired' } };
  if (state.status === 'consumed') return { status: 200, json: { status: 'done' } };
  const out = await completeLogin(ctx, state.userId, { via: 'bot_link' });
  ctx.setCookie(serializeCookie(LINK_COOKIE, '', { path: LINK_COOKIE_PATH, maxAgeSec: 0 }));
  // В бот: вход выполнен на новом устройстве, кнопка «Выйти везде».
  const bot = ctx.telegram;
  if (state.channel === 'telegram' && state.externalUserId && bot?.configured) {
    const notice = newDeviceNotice(state.externalUserId);
    ctx.afterCommit(async () => {
      try {
        await bot.call('sendMessage', notice);
      } catch (err) {
        ctx.log.warn('telegram_reply_failed', { code: err.code });
      }
    });
  }
  return { status: 200, json: { status: 'done', token: out.token, user: out.user } };
}

async function telegramWebhook(ctx, req) {
  const secret = ctx.config.telegram?.webhookSecret;
  if (!ctx.config.telegram?.botToken || !secret) throw new HttpError(404, 'not_found');
  if (!secretMatches(req.headers['x-telegram-bot-api-secret-token'], secret)) throw new HttpError(401, 'unauthorized');
  const { replies, event } = await handleTelegramUpdate(ctx.db, req.body, { now: ctx.clock.now() });
  ctx.log.info('telegram_update', { event, update_id: Number.isSafeInteger(req.body.update_id) ? req.body.update_id : null });
  const bot = ctx.telegram;
  if (replies.length > 0 && bot?.configured) {
    ctx.afterCommit(async () => {
      for (const { method = 'sendMessage', ...params } of replies) {
        try {
          await bot.call(method, params);
        } catch (err) {
          ctx.log.warn('telegram_reply_failed', { code: err.code });
        }
      }
    });
  } else if (replies.length > 0) {
    ctx.log.info('notify_skipped', { channel: 'telegram', kind: 'bot_reply', code: 'not_configured' });
  }
  return { status: 200, json: { ok: true } };
}

async function consent(ctx, req) {
  const version = req.body.version;
  if (version !== ctx.config.consentVersion) throw new HttpError(400, 'bad_request', { detail: 'consent version' });
  await ctx.db.query(
    'insert into bl.consents (user_id, version, accepted_at) values ($1, $2, $3) on conflict (user_id, version) do nothing',
    [ctx.user.id, version, ctx.clock.now()],
  );
  return { status: 200, json: { ok: true } };
}

async function logout(ctx) {
  const p = ctx.principal;
  if (p.kind === 'terminal') {
    await ctx.db.query('update bl.staff_terminals set revoked_at = $2 where id = $1 and revoked_at is null', [p.terminalId, ctx.clock.now()]);
  } else {
    await ctx.db.query('update bl.auth_tokens set revoked_at = $2 where id = $1 and revoked_at is null', [p.tokenId, ctx.clock.now()]);
  }
  ctx.setCookie(clearSessionCookie());
  return { status: 200, json: { ok: true } };
}

async function me(ctx) {
  const userId = ctx.user.id;
  await setContext(ctx.db, { clubId: null });
  const user = await userJson(ctx.db, userId, { consentVersion: ctx.config.consentVersion, configured: ctx.notify?.configured?.() ?? null });
  let clubs = (await myMemberships(ctx.db, userId)).map((m) => ({ club_id: m.club_id, role: m.role, name: m.club_name, timezone: m.timezone }));
  // Токен PIN действует только в клубе терминала.
  if (ctx.principal.kind === 'pin') clubs = clubs.filter((c) => c.club_id === ctx.principal.clubId);
  return {
    status: 200,
    json: {
      user,
      clubs,
      session: { kind: ctx.principal.kind, terminal_id: ctx.principal.terminalId ?? null, expires_at: new Date(ctx.principal.expiresAt).toISOString() },
    },
  };
}

const NAME_RE = /^[^\p{Cc}]{1,100}$/u;

/** PATCH /api/me {name?, notify_channel?} — своё имя (для персонала) и основной канал уведомлений. */
async function updateMe(ctx, req) {
  const { name, notify_channel: channel, channels_order: order } = req.body;
  if (name === undefined && channel === undefined && order === undefined) throw new HttpError(400, 'bad_request');
  const sets = [];
  const params = [ctx.user.id];
  if (name !== undefined) {
    const v = name === null ? null : typeof name === 'string' ? name.trim() : undefined;
    if (v === undefined || (v !== null && !NAME_RE.test(v)) || v === '') throw new HttpError(400, 'bad_request');
    params.push(v);
    sets.push(`name = $${params.length}`);
  }
  // Только каналы, настроенные на сервере (channels_available, №126, №130).
  const conf = ctx.notify?.configured?.() ?? { max: true, telegram: true, webpush: true };
  const offered = ['max', 'telegram', 'webpush'].filter((c) => conf[c]);
  if (channel !== undefined) {
    if (channel !== null && !offered.includes(channel)) throw new HttpError(400, 'bad_request');
    params.push(channel);
    sets.push(`notify_channel = $${params.length}`);
  }
  if (order !== undefined) {
    // Порядок каналов (M3 §4): 1–3 разных из настроенных max, telegram, webpush; null — по умолчанию.
    const ok = order === null || (Array.isArray(order) && order.length >= 1 && order.length <= 3 && new Set(order).size === order.length
      && order.every((c) => offered.includes(c)));
    if (!ok) throw new HttpError(400, 'bad_request');
    params.push(order);
    sets.push(`channels_order = $${params.length}::text[]`);
  }
  params.push(ctx.clock.now());
  sets.push(`updated_at = $${params.length}`);
  await setContext(ctx.db, { clubId: null });
  await ctx.db.query(`update bl.users set ${sets.join(', ')} where id = $1`, params);
  return { status: 200, json: { user: await userJson(ctx.db, ctx.user.id, { consentVersion: ctx.config.consentVersion, configured: ctx.notify?.configured?.() ?? null }) } };
}

async function registerTerminal(ctx, req) {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 100) throw new HttpError(400, 'bad_request');
  if (ctx.principal.kind !== 'session') throw new HttpError(403, 'forbidden', { detail: 'personal login required' });
  const token = newToken();
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + TERMINAL_TTL_MS);
  const { rows } = await ctx.db.query(
    `insert into bl.staff_terminals (club_id, name, token_hash, created_by, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [ctx.club, name, tokenHash(token), ctx.user.id, now, expiresAt],
  );
  const terminalId = rows[0].id;
  await appendAudit(ctx.db, {
    action: 'auth.terminal_register',
    objectType: 'staff_terminal',
    objectId: terminalId,
    actorType: 'user',
    actorId: ctx.user.id,
    data: { terminal_id: terminalId },
  });
  return { status: 200, json: { terminal_token: token, terminal_id: terminalId, expires_at: expiresAt.toISOString() } };
}

async function terminalInfo(ctx) {
  const t = await ctx.db.query('select id, club_id, name from bl.staff_terminals where id = $1', [ctx.principal.terminalId]);
  const { rows } = await ctx.db.query(
    `select m.user_id, m.role, m.pin_hash is not null as pin_set, u.phone, u.name
       from bl.club_members m join bl.users u on u.id = m.user_id
      where m.club_id = $1 and m.active and m.role = any($2::text[])
      order by m.role, m.user_id`,
    [ctx.club, PIN_SWITCH_ROLES],
  );
  return {
    status: 200,
    json: {
      terminal: { id: t.rows[0].id, club_id: t.rows[0].club_id, name: t.rows[0].name },
      staff: rows.map((r) => ({ user_id: r.user_id, name: r.name, role: r.role, phone_masked: maskPhone(r.phone), pin_set: r.pin_set })),
    },
  };
}

/**
 * Неверный PIN на терминале (своя транзакция — счёт не откатывается): 10 за час — терминал
 * блокируется для входа по PIN до разблокировки владельцем, тревога terminal_locked.
 */
async function terminalPinFailure(ctx, terminalId, now) {
  const windowStart = new Date(now.getTime() - TERMINAL_PIN_WINDOW_MS);
  return ctx.withContext(ctx.pool, { clubId: ctx.club, actorType: 'system' }, async (db) => {
    const { rows } = await db.query(
      `update bl.staff_terminals
          set pin_failed_count = case when pin_window_started_at is null or pin_window_started_at < $2 then 1 else pin_failed_count + 1 end,
              pin_window_started_at = case when pin_window_started_at is null or pin_window_started_at < $2 then $3 else pin_window_started_at end
        where id = $1
        returning pin_failed_count, locked_at, name`,
      [terminalId, windowStart, now],
    );
    const t = rows[0];
    if (!t || t.locked_at || t.pin_failed_count < TERMINAL_PIN_FAILURES) return false;
    await db.query('update bl.staff_terminals set locked_at = $2 where id = $1', [terminalId, now]);
    await appendAudit(db, { action: 'auth.terminal_locked', objectType: 'staff_terminal', objectId: terminalId, actorType: 'system', data: { terminal_id: terminalId, failures: t.pin_failed_count } });
    await ctx.alarms.raise(db, ctx.club, { type: 'terminal_locked', data: { terminal_id: terminalId, failures: t.pin_failed_count } });
    return true;
  });
}

async function pinSwitch(ctx, req) {
  const { user_id: userId, pin } = req.body;
  if (!isUuid(userId) || typeof pin !== 'string' || !PIN.test(pin)) throw new HttpError(400, 'bad_request');
  const terminalId = ctx.principal.terminalId;
  const now = ctx.clock.now();
  const term = await ctx.db.query('select locked_at from bl.staff_terminals where id = $1', [terminalId]);
  if (term.rows[0]?.locked_at) {
    ctx.log.warn('pin_terminal_locked', { terminal_id: terminalId });
    return { status: 429, json: { error: 'rate_limited' } };
  }
  // Проверка и счётчик ошибок — в своей транзакции (общая блокировка PIN, checkStaffPin).
  const check = await checkStaffPin({
    pool: ctx.pool,
    withContext: ctx.withContext,
    clubId: ctx.club,
    userId,
    pin,
    roles: PIN_SWITCH_ROLES,
    pepper: ctx.config.pinPepper,
    now,
  });
  if (!check.ok) {
    ctx.log.warn(check.locked ? 'pin_locked' : 'pin_rejected', { terminal_id: terminalId, user_id: userId, code: check.code });
    if (check.code === 'unauthorized' || check.code === 'forbidden' || check.code === 'rate_limited') {
      if (await terminalPinFailure(ctx, terminalId, now)) ctx.log.error('terminal_locked', { terminal_id: terminalId });
    }
    if (check.code === 'rate_limited') {
      return { status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': String(check.retryAfterSec) } };
    }
    // Роль без входа по PIN — как неверный PIN: терминал не узнаёт, чья учётка есть.
    return { status: 401, json: { error: 'unauthorized' } };
  }
  const m = { role: check.role };
  // Предыдущий сотрудник на этом терминале выходит.
  await ctx.db.query(
    "update bl.auth_tokens set revoked_at = $2 where terminal_id = $1 and kind = 'pin' and revoked_at is null",
    [terminalId, now],
  );
  await setContext(ctx.db, { userId, actorType: 'user' });
  const issued = await issueToken(ctx.db, { userId, kind: 'pin', clubId: ctx.club, terminalId, now, ttlMs: PIN_TTL_MS });
  await appendAudit(ctx.db, {
    action: 'auth.pin_switch',
    objectType: 'user',
    objectId: userId,
    actorType: 'user',
    actorId: userId,
    data: { terminal_id: terminalId },
  });
  ctx.setCookie(sessionCookie(issued.token, issued.expiresAt, now));
  ctx.log.info('pin_switch', { terminal_id: terminalId, user_id: userId });
  // Короткий PIN у владельца или управляющего — попросить сменить на 6 цифр (ревью входа п. 5).
  const pinChange = pin.length < LONG_PIN && LONG_PIN_ROLES.includes(m.role);
  return {
    status: 200,
    json: { token: issued.token, user_id: userId, role: m.role, expires_at: issued.expiresAt.toISOString(), ...(pinChange ? { pin_change_required: true } : {}) },
  };
}

async function pinSet(ctx, req) {
  const pin = req.body.pin;
  if (typeof pin !== 'string' || !PIN.test(pin)) throw new HttpError(400, 'bad_request');
  if (ctx.principal.kind !== 'session') throw new HttpError(403, 'forbidden', { detail: 'personal login required' });
  // Владелец и управляющий — PIN из 6 цифр (ревью входа п. 5).
  if (pin.length < LONG_PIN && ctx.roles.some((r) => LONG_PIN_ROLES.includes(r))) throw new HttpError(400, 'bad_request', { detail: 'pin 6 digits' });
  const hash = await hashPin(pin, ctx.config.pinPepper);
  const { rowCount } = await ctx.db.query(
    `update bl.club_members set pin_hash = $3, pin_failed_count = 0, pin_locked_until = null, pin_set_at = $4
      where club_id = $1 and user_id = $2 and active`,
    [ctx.club, ctx.user.id, hash, ctx.clock.now()],
  );
  if (rowCount === 0) throw new HttpError(403, 'forbidden');
  await appendAudit(ctx.db, { action: 'auth.pin_set', objectType: 'user', objectId: ctx.user.id, actorType: 'user', actorId: ctx.user.id, data: {} });
  return { status: 200, json: { ok: true } };
}

const isoOrNull = (v) => (v ? new Date(v).toISOString() : null);

/** GET /api/clubs/{club}/terminals — терминалы клуба (владелец). */
async function listTerminals(ctx) {
  const { rows } = await ctx.db.query(
    `select s.id, s.name, s.created_by, u.name as created_by_name, s.created_at, s.expires_at, s.last_used_at, s.revoked_at,
            s.locked_at, s.pin_failed_count
       from bl.staff_terminals s left join bl.users u on u.id = s.created_by
      order by s.revoked_at is not null, s.created_at desc`,
  );
  return {
    status: 200,
    json: rows.map((r) => ({
      id: r.id,
      name: r.name,
      created_by: { user_id: r.created_by, name: r.created_by_name ?? null },
      created_at: isoOrNull(r.created_at),
      expires_at: isoOrNull(r.expires_at),
      last_used_at: isoOrNull(r.last_used_at),
      revoked_at: isoOrNull(r.revoked_at),
      locked_at: isoOrNull(r.locked_at),
    })),
  };
}

/** DELETE /api/clubs/{club}/terminals/{id} — отозвать терминал; PIN-токены на нём гаснут. */
async function revokeTerminal(ctx, req) {
  const id = req.params.id;
  if (!isUuid(id)) throw new HttpError(404, 'not_found');
  const now = ctx.clock.now();
  const { rowCount } = await ctx.db.query('update bl.staff_terminals set revoked_at = coalesce(revoked_at, $2) where id = $1', [id, now]);
  if (rowCount === 0) throw new HttpError(404, 'not_found');
  await ctx.db.query("update bl.auth_tokens set revoked_at = $2 where terminal_id = $1 and kind = 'pin' and revoked_at is null", [id, now]);
  await appendAudit(ctx.db, { action: 'auth.terminal_revoke', objectType: 'staff_terminal', objectId: id, actorType: 'user', actorId: ctx.user.id, data: { terminal_id: id } });
  return { status: 200, json: { ok: true } };
}

/** POST /api/clubs/{club}/terminals/{id}/unlock — снять блокировку входа по PIN. */
async function unlockTerminal(ctx, req) {
  const id = req.params.id;
  if (!isUuid(id)) throw new HttpError(404, 'not_found');
  const { rowCount } = await ctx.db.query(
    'update bl.staff_terminals set locked_at = null, pin_failed_count = 0, pin_window_started_at = null where id = $1 and revoked_at is null',
    [id],
  );
  if (rowCount === 0) throw new HttpError(404, 'not_found');
  await appendAudit(ctx.db, { action: 'auth.terminal_unlock', objectType: 'staff_terminal', objectId: id, actorType: 'user', actorId: ctx.user.id, data: { terminal_id: id } });
  return { status: 200, json: { ok: true } };
}

async function notConfigured() {
  throw new HttpError(501, 'not_configured');
}

export const routes = [
  {
    method: 'POST',
    path: '/api/auth/dev',
    auth: 'none',
    enabled: devLoginEnabled,
    rateLimit: { max: 30, windowMs: MINUTE },
    handler: devLogin,
  },
  { method: 'POST', path: '/api/auth/telegram', auth: 'none', rateLimit: { max: 30, windowMs: MINUTE }, handler: telegramLogin },
  { method: 'POST', path: '/api/auth/max', auth: 'none', rateLimit: { max: 30, windowMs: MINUTE }, handler: notConfigured },
  { method: 'POST', path: '/api/auth/bot-link', auth: 'none', actor: 'system', rateLimit: { max: 10, windowMs: MINUTE }, handler: botLinkCreate },
  { method: 'GET', path: '/api/auth/bot-link/{nonce}', auth: 'none', actor: 'system', rateLimit: { max: 120, windowMs: MINUTE }, handler: botLinkPoll },
  { method: 'POST', path: '/api/bots/telegram/webhook', auth: 'none', actor: 'system', rateLimit: { max: 600, windowMs: MINUTE }, handler: telegramWebhook },
  { method: 'POST', path: '/api/bots/max/webhook', auth: 'none', rateLimit: { max: 60, windowMs: MINUTE }, handler: notConfigured },
  { method: 'POST', path: '/api/auth/consent', auth: 'guest', handler: consent },
  { method: 'POST', path: '/api/auth/logout', auth: 'any', handler: logout },
  { method: 'GET', path: '/api/me', auth: 'guest', handler: me },
  { method: 'PATCH', path: '/api/me', auth: 'guest', rateLimit: { max: 30, windowMs: MINUTE }, handler: updateMe },
  { method: 'POST', path: '/api/staff/terminal', auth: 'staff', roles: ['owner', 'manager'], clubFromBody: true, handler: registerTerminal },
  { method: 'GET', path: '/api/clubs/{club}/terminals', auth: 'staff', roles: ['owner'], handler: listTerminals },
  { method: 'DELETE', path: '/api/clubs/{club}/terminals/{id}', auth: 'staff', roles: ['owner'], handler: revokeTerminal },
  { method: 'POST', path: '/api/clubs/{club}/terminals/{id}/unlock', auth: 'staff', roles: ['owner'], handler: unlockTerminal },
  { method: 'GET', path: '/api/staff/terminal', auth: 'terminal', handler: terminalInfo },
  { method: 'POST', path: '/api/staff/pin', auth: 'terminal', rateLimit: { max: 20, windowMs: MINUTE }, handler: pinSwitch },
  { method: 'PUT', path: '/api/staff/pin', auth: 'staff', roles: PIN_SWITCH_ROLES, clubFromBody: true, rateLimit: { max: 10, windowMs: MINUTE }, handler: pinSet },
];

// Для тестов и документации.
export { auditStaffLogin, STAFF_ROLES };
