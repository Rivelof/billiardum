// Подключение клуба без выезда (M5.1 №152, №153, №160): создание клуба, мастер (шаги и
// чек-лист), переход в боевой режим, приостановка платформой, карточка каталога.
//
// Все функции — в транзакции запроса (withContext): контекст клуба, личный или платформы — как
// указано у функции. Режим клуба меняют только узкие функции базы (1000): bl.create_club,
// bl.club_go_live, bl.club_suspend, bl.club_resume.

import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { setContext } from '../lib/store.mjs';
import { isValidTimeZone } from '../lib/timezone.mjs';
import { send as notifySend, sendToClubStaff } from '../notify/index.mjs';
import { enqueue } from '../outbox.mjs';
import { decryptShopSecret } from '../payments/settings.mjs';
import { slugify, uniqueSlug } from '../directory/slug.mjs';
import { generalJson, isLiveClub, lastChecks, shopJson, verifyPair } from './shops.mjs';

export const CHECKLIST_IDS = Object.freeze(['tables', 'devices', 'tariffs', 'shop_live', 'kkt', 'stickers', 'offer']);
export const STEP_IDS = Object.freeze(['club', 'hall', 'tariffs', 'menu', 'staff', 'payments', 'devices', 'stickers', 'test', 'go_live']);
/** Контроллер и мост ККТ «на связи», если были на связи не раньше стольких миллисекунд назад (№160). */
export const ONLINE_WINDOW_MS = 10 * 60_000;
export const TEST_CLUBS_LIMIT = 3;
export const WENT_LIVE_TOPIC = 'club.went_live';
/** Версия оферты для клубов по умолчанию (CLUB_OFFER_VERSION). */
export const DEFAULT_OFFER_VERSION = '2026-10-23';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));
const WEEKDAYS = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const KIND_WORD = { pyramid: 'пирамида', pool: 'пул', snooker: 'снукер', mixed: 'смешанный' };
const DISCIPLINE_OF_TYPE = { billiard_pyramid: 'pyramid', billiard_pool: 'pool', billiard_snooker: 'snooker' };

function text(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= max && !/\p{Cc}/u.test(t) ? t : null;
}

const numbers = (list) => list.map((n) => `№${n}`).join(', ');

// Создание клуба (№152) ------------------------------------------------------------------------

/**
 * POST /api/clubs {name, city_id | city_name, timezone, listing_id?} → {club_id, mode: 'test'}.
 * Личный контекст вошедшего пользователя (телефон обязателен — проверяет роутер).
 */
export async function createClub(db, deps, { userId, body }) {
  const name = text(body?.name, 200);
  if (!name) throw new HttpError(400, 'bad_request', { detail: 'name' });
  const cityId = body?.city_id ?? null;
  if (cityId !== null && !isUuid(cityId)) throw new HttpError(400, 'bad_request', { detail: 'city_id' });
  const cityName = cityId ? null : text(body?.city_name ?? body?.city, 100);
  if (!cityId && !cityName) throw new HttpError(400, 'bad_request', { detail: 'city' });
  const timezone = body?.timezone ?? null;
  if (timezone !== null && !isValidTimeZone(timezone)) throw new HttpError(400, 'bad_request', { detail: 'timezone' });
  if (!cityId && timezone === null) throw new HttpError(400, 'bad_request', { detail: 'timezone' });
  const listingId = body?.listing_id ?? null;
  if (listingId !== null && !isUuid(listingId)) throw new HttpError(400, 'bad_request', { detail: 'listing_id' });

  let clubId;
  await db.query('savepoint bl_create_club');
  try {
    const { rows } = await db.query('select bl.create_club($1, $2, $3, $4, $5) as id', [name, cityName, cityId, timezone, listingId]);
    clubId = rows[0].id;
    await db.query('release savepoint bl_create_club');
  } catch (err) {
    await db.query('rollback to savepoint bl_create_club');
    if (err.code === 'BLC01') throw new HttpError(409, 'clubs_limit', { detail: `не больше ${TEST_CLUBS_LIMIT} тестовых клубов` });
    if (err.code === 'BLC02') throw new HttpError(404, 'not_found', { detail: 'listing' });
    if (err.code === '22023') throw new HttpError(400, 'bad_request', { detail: err.message });
    if (err.code === 'BLC04') throw new HttpError(403, 'phone_required', { detail: err.message });
    if (err.code === '42501') throw new HttpError(403, 'forbidden', { detail: err.message });
    throw err;
  }
  await setContext(db, { clubId });
  const { rows: c } = await db.query('select name, city, city_id, timezone from bl.clubs where id = $1', [clubId]);
  await appendAudit(db, {
    action: 'club.create',
    objectType: 'club',
    objectId: clubId,
    actorType: 'user',
    actorId: userId,
    data: { club_id: clubId, mode: 'test', city: c[0].city, city_id: c[0].city_id, timezone: c[0].timezone, listing_id: listingId },
  });
  await notifyPlatform(db, ['platform_operator'], {
    kind: 'platform.club_created',
    text: `Новый клуб в тестовом режиме: «${c[0].name}», ${c[0].city}.`,
    data: { club_id: clubId },
  });
  deps.log?.info?.('club_created', { club_id: clubId, user_id: userId });
  return { club_id: clubId, mode: 'test' };
}

/**
 * GET /api/clubs/claimable-listings — карточки каталога, на которые у пользователя одобрена заявка
 * «Подтвердить клуб» или «Добавить клуб» и которые ещё не связаны с клубом: мастер предлагает
 * связать новый клуб с одной из них (listing_id в POST /api/clubs). Личный контекст.
 */
export async function claimableListings(db, { userId }) {
  const { rows } = await db.query(
    `select distinct on (p.id) p.id, p.name, p.address, c.name as city, c.id as city_id, c.timezone
       from bl.directory_claims dc
       join bl.club_public p on p.id = dc.card_id
       join bl.cities c on c.id = p.city_id
      where dc.user_id = $1 and dc.status = 'approved' and dc.kind in ('claim', 'add') and p.club_id is null
      order by p.id`,
    [userId],
  );
  const { rows: used } = await db.query(
    'select listing_id from bl.clubs where listing_id = any($1::uuid[])',
    [rows.map((r) => r.id)],
  );
  const taken = new Set(used.map((r) => r.listing_id));
  return {
    items: rows
      .filter((r) => !taken.has(r.id))
      .map((r) => ({ listing_id: r.id, name: r.name, address: r.address ?? null, city: r.city, city_id: r.city_id, timezone: r.timezone })),
  };
}

/** Уведомление платформе: получатели ролей без повторов (администратор — и за оператора, если операторов нет). */
async function notifyPlatform(db, roles, msg) {
  const ids = new Set();
  for (const role of roles) {
    const { rows } = await db.query('select r as user_id from bl.platform_recipients($1) r', [role]);
    for (const r of rows) ids.add(r.user_id);
  }
  for (const id of [...ids].sort()) await notifySend(db, id, { level: 'info', ...msg });
  return ids.size;
}

// Чек-лист запуска (№160) ------------------------------------------------------------------------

async function clubRow(db, clubId) {
  const { rows } = await db.query(
    `select id, name, city, city_id, timezone, address, settings, mode, mode_before_suspend, went_live_at, listing_id, created_by,
            offer_version, offer_accepted_at, suspended_at, suspended_reason
       from bl.clubs where id = $1`,
    [clubId],
  );
  return rows[0] ?? null;
}

async function paymentRow(db, clubId) {
  const { rows } = await db.query('select * from bl.club_payment_settings where club_id = $1', [clubId]);
  return rows[0] ? { ...rows[0], club_id: clubId } : { club_id: clubId };
}

/** Пункт 2: у каждого стола в работе — контроллер, на связи за 10 минут. */
async function devicesItem(db, clubId, now) {
  const { rows } = await db.query(
    `select r.number, d.id as device_id, d.last_seen_at
       from bl.resources r left join bl.devices d on d.club_id = r.club_id and d.resource_id = r.id
      where r.club_id = $1 and r.active
      order by r.number`,
    [clubId],
  );
  if (rows.length === 0) return { id: 'devices', ok: false, detail: 'Нет столов в работе' };
  const since = now.getTime() - ONLINE_WINDOW_MS;
  const missing = rows.filter((r) => !r.device_id).map((r) => r.number);
  const offline = rows.filter((r) => r.device_id && !(r.last_seen_at && new Date(r.last_seen_at).getTime() >= since)).map((r) => r.number);
  if (missing.length === 0 && offline.length === 0) return { id: 'devices', ok: true, detail: null };
  const parts = [];
  if (missing.length) parts.push(`без контроллера столы ${numbers(missing)}`);
  if (offline.length) parts.push(`не на связи столы ${numbers(offline)}`);
  return { id: 'devices', ok: false, detail: `${parts.join('; ')}`.replace(/^./, (x) => x.toUpperCase()).slice(0, 200) };
}

/** Пункт 5: касса ресепшена включена — мост ККТ на связи за 10 минут и ККТ фискальная. */
async function kktItem(db, clubId, pay, now) {
  if (pay.reception_enabled === false) return { id: 'kkt', ok: true, detail: 'Касса ресепшена выключена' };
  const { rows } = await db.query(
    `select last_seen_at, last_status from bl.kkt_bridges where club_id = $1 and revoked_at is null order by last_seen_at desc nulls last`,
    [clubId],
  );
  if (rows.length === 0) return { id: 'kkt', ok: false, detail: 'Мост ККТ не подключён' };
  const since = now.getTime() - ONLINE_WINDOW_MS;
  const fresh = rows.filter((b) => b.last_seen_at && new Date(b.last_seen_at).getTime() >= since);
  if (fresh.length === 0) return { id: 'kkt', ok: false, detail: 'Мост ККТ не был на связи 10 минут' };
  if (!fresh.some((b) => b.last_status?.fiscal === true)) return { id: 'kkt', ok: false, detail: 'ККТ не фискальная или не ответила' };
  return { id: 'kkt', ok: true, detail: null };
}

/**
 * Пункт 4: боевой магазин. verify — перепроверить GET /v3/me сейчас (переход в live); иначе —
 * по сохранённой проверке.
 */
async function shopLiveItem(db, clubId, pay, { verify, config, now, fetch }) {
  if (!pay.shop_id || !pay.secret_key_enc) return { id: 'shop_live', ok: false, detail: 'Боевой магазин ЮKassa не подключён' };
  if (!verify) {
    const me = pay.live_me ?? null;
    if (!pay.live_verified_at || !me) return { id: 'shop_live', ok: false, detail: 'Боевой магазин не проверен' };
    if (me.test !== false) return { id: 'shop_live', ok: false, detail: 'Магазин тестовый, нужен боевой' };
    if (me.fiscalization_enabled !== true) return { id: 'shop_live', ok: false, detail: 'В магазине не включены чеки по 54-ФЗ' };
    return { id: 'shop_live', ok: true, detail: null };
  }
  try {
    const secret = decryptShopSecret(pay.secret_key_enc, config.encKey, clubId, 'live');
    const me = await verifyPair({ shopId: pay.shop_id, secret, mode: 'live', config, fetch });
    await db.query('update bl.club_payment_settings set live_verified_at = $2, live_me = $3, updated_at = $2 where club_id = $1', [clubId, now, JSON.stringify(me)]);
    return { id: 'shop_live', ok: true, detail: null };
  } catch (err) {
    const detail = {
      shop_mode_mismatch: 'Магазин тестовый, нужен боевой',
      fiscalization_off: 'В магазине не включены чеки по 54-ФЗ',
      yookassa_unavailable: 'ЮKassa не ответила, попробуйте позже',
      shop_invalid: 'ЮKassa не приняла идентификатор магазина или ключ',
    }[err?.code];
    if (!detail) throw err;
    return { id: 'shop_live', ok: false, detail };
  }
}

/**
 * Чек-лист запуска клуба (контракт §3): { items: [{id, ok, detail}], ready }.
 * @param {{ clubId: string, now: Date, neighbors: object, config?: object, acceptOffer?: boolean, verify?: boolean, fetch?: Function }} args
 */
export async function checklist(db, { clubId, now, neighbors, config = {}, acceptOffer = false, verify = false, fetch }) {
  const club = await clubRow(db, clubId);
  if (!club) throw new HttpError(404, 'not_found');
  const pay = await paymentRow(db, clubId);
  const items = [];
  const active = Number(await neighbors.resources.activeCount(db, clubId));
  items.push({ id: 'tables', ok: active > 0, detail: active > 0 ? `Столов в работе: ${active}` : 'Нет столов в работе' });
  items.push(await devicesItem(db, clubId, now));
  const cover = await neighbors.tariffs.coversWeek(db, clubId);
  const covered = cover === true || cover?.ok === true;
  let tariffDetail = null;
  if (!covered) {
    const g = cover?.gap;
    tariffDetail = g && Number.isInteger(g.weekday)
      ? `Нет тарифа: ${WEEKDAYS[g.weekday] ?? g.weekday} ${g.from ?? ''}–${g.to ?? ''}${g.kind ? `, ${KIND_WORD[g.kind] ?? g.kind}` : ''}`.slice(0, 200)
      : 'Тарифы не покрывают неделю';
  }
  items.push({ id: 'tariffs', ok: covered, detail: tariffDetail });
  items.push(await shopLiveItem(db, clubId, pay, { verify, config, now, fetch }));
  items.push(await kktItem(db, clubId, pay, now));
  const printedAt = await neighbors.qr.printedAt(db, clubId);
  items.push({ id: 'stickers', ok: Boolean(printedAt), detail: printedAt ? null : 'Наклейки ещё не печатали' });
  const offer = Boolean(club.offer_accepted_at) || acceptOffer === true;
  items.push({ id: 'offer', ok: offer, detail: offer ? null : 'Оферта не принята' });
  return { items, ready: items.every((i) => i.ok) };
}

// Мастер (GET …/onboarding) --------------------------------------------------------------------

async function exists(db, sql, params) {
  const { rows } = await db.query(`select exists (${sql}) as ok`, params);
  return rows[0].ok;
}

/**
 * GET /api/clubs/{club}/onboarding — контекст клуба (владелец, управляющий).
 * @returns {{ club, mode, steps, checklist, payment_checks, shops, payment_settings, kkt_enabled, webhook_url, offer, hall }}
 */
export async function onboarding(db, { clubId, now, neighbors, config = {}, publicHost, owner = true }) {
  const club = await clubRow(db, clubId);
  if (!club) throw new HttpError(404, 'not_found');
  const list = await checklist(db, { clubId, now, neighbors, config });
  const ok = Object.fromEntries(list.items.map((i) => [i.id, i.ok]));
  const pay = await paymentRow(db, clubId);
  const checks = await lastChecks(db, clubId);
  const testShop = shopJson(pay, 'test', config.encKey);
  const steps = {
    club: true,
    hall: ok.tables,
    tariffs: ok.tariffs,
    menu: await exists(db, 'select 1 from bl.products where club_id = $1', [clubId]),
    staff: await exists(
      db,
      `select 1 from bl.club_members where club_id = $1 and role <> 'owner' and active
       union all select 1 from bl.staff_invites where club_id = $1 and revoked_at is null`,
      [clubId],
    ),
    // В test проверочный платёж обязателен: тестовый магазин проверен, платёж прошёл, вебхук пришёл.
    payments: Boolean(testShop.verified_at && testShop.test === true && checks.test?.status === 'succeeded' && checks.test?.webhook_at),
    devices: ok.devices,
    stickers: ok.stickers,
    test: await exists(db, 'select 1 from bl.sessions where club_id = $1 and is_test', [clubId]),
    go_live: isLiveClub(club.mode, club.mode_before_suspend),
  };
  const plan = club.settings?.plan;
  return {
    club: {
      id: club.id,
      name: club.name,
      city: club.city,
      city_id: club.city_id,
      timezone: club.timezone,
      mode: club.mode,
      went_live_at: iso(club.went_live_at),
      suspended_at: iso(club.suspended_at),
      listing_id: club.listing_id,
    },
    mode: club.mode,
    steps: STEP_IDS.map((id) => ({ id, done: Boolean(steps[id]) })),
    checklist: list,
    payment_checks: checks,
    // Магазины (маска ключа) — только владельцу; управляющий видит шаги и чек-лист.
    shops: owner ? { test: testShop, live: shopJson(pay, 'live', config.encKey) } : null,
    payment_settings: generalJson(pay),
    kkt_enabled: pay.reception_enabled !== false,
    webhook_url: `https://${publicHost}/api/webhooks/yookassa/${clubId}`,
    offer: { version: config.offerVersion ?? DEFAULT_OFFER_VERSION, accepted_at: iso(club.offer_accepted_at), accepted_version: club.offer_version ?? null },
    // Начало рабочих суток клуба (№43) — мастеру тарифов; по умолчанию 06:00.
    day_start_local: typeof club.settings?.day_start_local === 'string' ? club.settings.day_start_local : '06:00',
    hall: plan && Number.isInteger(plan.width_cm) && Number.isInteger(plan.height_cm) ? { width: plan.width_cm, height: plan.height_cm } : null,
  };
}

// Переход в боевой режим (№160) -------------------------------------------------------------------

/**
 * POST /api/clubs/{club}/go-live {accept_offer: true} → {mode: 'live', went_live_at}.
 * Контекст клуба, владелец. Пункт не выполнен — 409 checklist_incomplete {failed: [...]}.
 */
export async function goLive(db, deps, { clubId, userId, body, now, neighbors, config, fetch }) {
  const club = await clubRow(db, clubId);
  if (!club) throw new HttpError(404, 'not_found');
  if (club.mode === 'live') return { mode: 'live', went_live_at: iso(club.went_live_at) };
  if (club.mode === 'suspended') throw new HttpError(409, 'club_suspended');
  const list = await checklist(db, { clubId, now, neighbors, config, acceptOffer: body?.accept_offer === true, verify: true, fetch });
  const failed = list.items.filter((i) => !i.ok).map((i) => i.id);
  if (failed.length > 0) {
    throw new HttpError(409, 'checklist_incomplete', { data: { failed }, detail: failed.join(',') });
  }
  const version = config.offerVersion ?? DEFAULT_OFFER_VERSION;
  const { rows } = await db.query('select bl.club_go_live($1, $2) as at', [clubId, version]);
  const at = rows[0].at;
  await appendAudit(db, {
    action: 'club.go_live',
    objectType: 'club',
    objectId: clubId,
    actorType: 'user',
    actorId: userId,
    data: { club_id: clubId, offer_version: version, checklist: list.items.map((i) => i.id) },
  });
  await enqueue(db, WENT_LIVE_TOPIC, { club_id: clubId });
  await notifyPlatform(db, ['platform_admin', 'platform_operator'], {
    kind: 'platform.club_live',
    level: 'important',
    text: `Клуб «${club.name}», ${club.city}, перешёл в боевой режим.`,
    data: { club_id: clubId },
  });
  deps.log?.info?.('club_went_live', { club_id: clubId });
  return { mode: 'live', went_live_at: iso(at) };
}

// Приостановка платформой (№160) -------------------------------------------------------------------

function platformReason(body) {
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw new HttpError(400, 'reason_required');
  if (reason.length > 2000) throw new HttpError(400, 'bad_request', { detail: 'reason' });
  return reason;
}

async function platformModeCall(db, sql, params) {
  await db.query('savepoint bl_club_mode');
  try {
    const { rows } = await db.query(sql, params);
    await db.query('release savepoint bl_club_mode');
    return { value: rows[0].v, conflict: false };
  } catch (err) {
    await db.query('rollback to savepoint bl_club_mode');
    if (err.code === 'BLC03') return { value: null, conflict: true };
    if (err.code === '42501') throw new HttpError(403, 'forbidden');
    if (err.code === '22023') throw new HttpError(400, 'bad_request', { detail: err.message });
    throw err;
  }
}

/**
 * POST /api/platform/clubs/{club}/suspend {reason} и …/resume {reason, mode?} — platform_admin.
 * Контекст платформы (роутер ставит app.platform_role); запись журнала — в цепочку клуба,
 * уведомление владельцам клуба. Повтор (уже приостановлен / не приостановлен) — 200 с текущим режимом.
 * @returns {{ club_id, mode }}
 */
export async function setSuspended(db, deps, { clubId, suspend, body }) {
  const reason = platformReason(body);
  const mode = suspend ? null : body?.mode ?? null;
  if (mode !== null && mode !== 'test' && mode !== 'live') throw new HttpError(400, 'bad_request', { detail: 'mode' });
  const call = suspend
    ? await platformModeCall(db, 'select bl.club_suspend($1, $2) as v', [clubId, reason])
    : await platformModeCall(db, 'select bl.club_resume($1, $2) as v', [clubId, mode]);
  const current = (await db.query('select bl.club_mode($1) as m', [clubId])).rows[0].m;
  if (current === null) throw new HttpError(404, 'not_found');
  if (call.conflict) return { club_id: clubId, mode: current, changed: false };
  // Журнал и уведомление — в клубе (сотрудник платформы: actor support).
  await setContext(db, { clubId });
  await appendAudit(db, {
    action: suspend ? 'club.suspend' : 'club.resume',
    objectType: 'club',
    objectId: clubId,
    reason,
    data: suspend ? { club_id: clubId, mode_before: call.value } : { club_id: clubId, mode: call.value },
  });
  await sendToClubStaff(db, clubId, ['owner'], {
    kind: suspend ? 'club.suspended' : 'club.resumed',
    level: 'critical',
    text: suspend
      ? `Платформа Бильярдума приостановила клуб: новые игры не начинаются, оплаченные доигрываются. Причина: ${reason}`
      : `Платформа Бильярдума возобновила работу клуба (${current === 'live' ? 'боевой режим' : 'тестовый режим'}). Причина: ${reason}`,
    data: { club_id: clubId, url: '/club/' },
  });
  await setContext(db, { clubId: null });
  deps.log?.info?.(suspend ? 'club_suspended' : 'club_resumed', { club_id: clubId, mode: current });
  return { club_id: clubId, mode: current, changed: true };
}

/** Новая игра в клубе запрещена, если он приостановлен (оплаченная игра доигрывает — инвариант 3). */
export async function assertCanStartGame(db, clubId, makeError = () => new HttpError(409, 'club_suspended')) {
  const { rows } = await db.query('select bl.club_mode($1) as m', [clubId]);
  if (rows[0]?.m === 'suspended') throw makeError();
}

// Карточка каталога при переходе в live (№160) --------------------------------------------------

/**
 * Обработчик outbox club.went_live: карточка каталога связывается с клубом (status platform);
 * нет карточки — создаётся; города нет в справочнике — уведомление оператору (city_required, как M4).
 * Работает в контексте платформы (system) и возвращается в контекст клуба. Идемпотентен.
 * @returns {Promise<{ result: 'linked'|'created'|'already'|'city_required'|'skipped', listing_id?: string }>}
 */
export async function linkCatalogCard(db, deps, payload) {
  const clubId = payload?.club_id;
  if (!isUuid(clubId)) return { result: 'skipped' };
  await setContext(db, { clubId });
  const club = await clubRow(db, clubId);
  if (!club || !isLiveClub(club.mode, club.mode_before_suspend)) return { result: 'skipped' };
  const { rows: res } = await db.query('select type, count(*)::int as n from bl.resources where club_id = $1 and active group by type', [clubId]);
  const tables = res.reduce((a, r) => a + r.n, 0);
  const disciplines = [...new Set(res.map((r) => DISCIPLINE_OF_TYPE[r.type]).filter(Boolean))];
  const now = deps.clock.now();

  // Контекст платформы: карточки и города меняет только платформа (club_public_guard).
  await setContext(db, { clubId: null, userId: null, actorType: 'system' });
  let out;
  try {
    const { rows: mine } = await db.query('select id, status from bl.club_public where club_id = $1', [clubId]);
    if (mine[0]) {
      if (mine[0].status !== 'platform') await db.query("update bl.club_public set status = 'platform', updated_at = $2 where id = $1", [mine[0].id, now]);
      out = { result: mine[0].status === 'platform' ? 'already' : 'linked', listing_id: mine[0].id };
    } else {
      let card = null;
      if (club.listing_id) {
        const { rows } = await db.query('select id, club_id from bl.club_public where id = $1 for update', [club.listing_id]);
        if (rows[0] && rows[0].club_id === null) card = rows[0];
      }
      if (card) {
        await db.query(
          `update bl.club_public set status = 'platform', club_id = $2, contact_user_id = coalesce(contact_user_id, $3),
                  tables_count = coalesce($4, tables_count), updated_at = $5 where id = $1`,
          [card.id, clubId, club.created_by, tables > 0 ? Math.min(tables, 200) : null, now],
        );
        out = { result: 'linked', listing_id: card.id };
      } else {
        let cityId = club.city_id;
        if (!cityId) {
          const { rows } = await db.query('select id from bl.cities where active and lower(name) = lower($1) order by name limit 1', [club.city]);
          cityId = rows[0]?.id ?? null;
        }
        if (!cityId) {
          out = { result: 'city_required' };
        } else {
          const slug = await uniqueSlug(club.name, async (s) => (await db.query('select 1 from bl.club_public where city_id = $1 and slug = $2', [cityId, s])).rowCount > 0);
          const { rows } = await db.query(
            `insert into bl.club_public (city_id, slug, name, status, club_id, address, disciplines, tables_count, contact_user_id, created_by, created_at, updated_at)
             values ($1, $2, $3, 'platform', $4, $5, $6::text[], $7, $8, $8, $9, $9) returning id`,
            [cityId, slug || slugify('klub'), club.name, clubId, club.address ?? null, disciplines, tables > 0 ? Math.min(tables, 200) : null, club.created_by, now],
          );
          out = { result: 'created', listing_id: rows[0].id };
        }
      }
    }
    if (out.result === 'city_required') {
      await notifyPlatform(db, ['platform_operator'], {
        kind: 'platform.club_city_required',
        level: 'important',
        text: `Клуб «${club.name}» перешёл в боевой режим, но города «${club.city}» нет в справочнике: добавьте город и карточку клуба.`,
        data: { club_id: clubId },
      });
    }
  } finally {
    await setContext(db, { clubId, actorType: 'system' });
  }
  if (out.result !== 'already') {
    await appendAudit(db, {
      action: out.result === 'city_required' ? 'club.card_city_required' : 'club.card_linked',
      objectType: 'club',
      objectId: clubId,
      actorType: 'system',
      actorId: null,
      data: { club_id: clubId, result: out.result, listing_id: out.listing_id ?? null },
    });
  }
  deps.log?.info?.('club_card', { club_id: clubId, result: out.result });
  return out;
}
