// Пакеты часов (контракт M3 §1 п. 10, §4; decisions №112).
//
//   GET  /api/clubs/{club}/packages        — активные пакеты клуба (без входа)
//   POST /api/clubs/{club}/packages        — управляющий, владелец: { title, hours, price_kopecks, valid_days, reason }
//   POST /api/packages/{id}/archive        — управляющий, владелец: { reason } (снять с продажи)
//   POST /api/packages/{id}/buy            — гость, Idempotency-Key: { method: sbp | card } → платёж ЮKassa kind package
//   GET  /api/clubs/{club}/balance         — гость: остаток минут в клубе
// Новый пакет и снятие с продажи — изменение тарифа (инвариант 8): причина, журнал, уведомление владельцу.
// Цена и часы пакета не меняются — только новый пакет.

import { createYooKassaPayment, ownReturnUrl, returnUrl } from '../payments/pay.mjs';
import { enterClub, enterObjectClub, isUuid, requireGuestReady, requireIdempotencyKey, requireStaff, requireUser } from '../payments/context.mjs';
import { MoneyError } from '../payments/errors.mjs';
import { receiptPhone } from '../payments/receipt.mjs';
import { stableUuid } from '../payments/records.mjs';
import { loadPaymentSettings } from '../payments/settings.mjs';
import { formatValue } from '../payments/yookassa.mjs';
import { balanceOf } from './balance.mjs';

export const MANAGER_ROLES = Object.freeze(['owner', 'manager']);

export function packageView(p) {
  return {
    id: p.id,
    club_id: p.club_id,
    title: p.title,
    hours: p.minutes / 60,
    minutes: p.minutes,
    price_kopecks: Number(p.price_kopecks),
    valid_days: p.valid_days,
    active: p.active,
  };
}

/** Позиция чека покупки пакета: «предоплата 100 %» услуги (зачёт — при списании минут). */
export function packageItem(p, vatCode) {
  return {
    description: `Пакет «${p.title}»: ${p.minutes / 60} ч на ${p.valid_days} дн.`.slice(0, 128),
    quantity: 1,
    amount: { value: formatValue(Number(p.price_kopecks)), currency: 'RUB' },
    vat_code: vatCode,
    payment_mode: 'full_prepayment',
    payment_subject: 'service',
  };
}

function reasonOf(body) {
  const r = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!r) throw new MoneyError('reason_required');
  if (r.length > 2000) throw new MoneyError('bad_request', 'reason');
  return r;
}

export async function listPackages(db, deps, info) {
  const clubId = info.params.club;
  if (!isUuid(clubId)) throw new MoneyError('not_found', 'club');
  await enterClub(db, clubId);
  const { rows } = await db.query('select * from bl.tariff_packages where club_id = $1 and active order by price_kopecks, created_at', [clubId]);
  return rows.map(packageView);
}

export async function createPackage(db, deps, info) {
  const clubId = info.params.club;
  if (!isUuid(clubId)) throw new MoneyError('not_found', 'club');
  await enterClub(db, clubId);
  await requireStaff(db, info, clubId, MANAGER_ROLES);
  const b = info.body ?? {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (title.length < 1 || title.length > 100) throw new MoneyError('bad_request', 'title');
  if (!Number.isInteger(b.hours) || b.hours < 1 || b.hours > 1000) throw new MoneyError('bad_request', 'hours');
  if (!Number.isSafeInteger(b.price_kopecks) || b.price_kopecks < 100 || b.price_kopecks > 100_000_000) throw new MoneyError('bad_request', 'price_kopecks');
  if (!Number.isInteger(b.valid_days) || b.valid_days < 1 || b.valid_days > 730) throw new MoneyError('bad_request', 'valid_days');
  const reason = reasonOf(b);
  const now = deps.clock.now();
  const { rows } = await db.query(
    `insert into bl.tariff_packages (club_id, title, minutes, price_kopecks, valid_days, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7) returning *`,
    [clubId, title, b.hours * 60, b.price_kopecks, b.valid_days, info.userId, now],
  );
  const p = rows[0];
  await deps.audit.appendAudit(db, {
    action: 'tariff.package_created',
    objectType: 'tariff_package',
    objectId: p.id,
    reason,
    data: { package_id: p.id, title, hours: b.hours, price_kopecks: b.price_kopecks, valid_days: b.valid_days },
    actorType: 'user',
    actorId: info.userId,
  });
  await notifyOwner(db, deps, clubId, `Новый пакет часов «${title}»: ${b.hours} ч за ${formatValue(b.price_kopecks).replace('.', ',')} ₽. Причина: ${reason}`, { package_id: p.id });
  return { status: 201, json: packageView(p) };
}

export async function archivePackage(db, deps, info) {
  const id = info.params.id;
  const clubId = await enterObjectClub(db, 'package', id);
  await requireStaff(db, info, clubId, MANAGER_ROLES);
  const reason = reasonOf(info.body);
  const now = deps.clock.now();
  const { rows } = await db.query('update bl.tariff_packages set active = false, updated_at = $2 where id = $1 and active returning *', [id, now]);
  if (!rows[0]) throw new MoneyError('not_found', 'package');
  await deps.audit.appendAudit(db, {
    action: 'tariff.package_archived',
    objectType: 'tariff_package',
    objectId: id,
    reason,
    data: { package_id: id, title: rows[0].title },
    actorType: 'user',
    actorId: info.userId,
  });
  await notifyOwner(db, deps, clubId, `Пакет «${rows[0].title}» снят с продажи. Причина: ${reason}`, { package_id: id });
  return { ok: true };
}

async function notifyOwner(db, deps, clubId, text, data) {
  try {
    await deps.notify.sendToClubStaff(db, clubId, ['owner'], { kind: 'manual_action', text, data });
  } catch (err) {
    deps.log?.warn?.('package_notify_failed', { club_id: clubId, error: err.message });
  }
}

export async function buyPackage(db, deps, config, info) {
  const id = info.params.id;
  if (!isUuid(id)) throw new MoneyError('not_found', 'package');
  const method = info.body?.method;
  if (method !== 'sbp' && method !== 'card') throw new MoneyError('bad_request', 'method');
  // return_url — только путь своего сайта («/app/…»), как у предоплаты брони; хост — наш.
  const ownUrl = ownReturnUrl(config, info.body?.return_url);
  const key = requireIdempotencyKey(info);
  requireUser(info);
  const clubId = await enterObjectClub(db, 'package', id);
  const { userId, phone } = await requireGuestReady(db, info);
  const { rows } = await db.query('select * from bl.tariff_packages where id = $1 and active', [id]);
  const pkg = rows[0];
  if (!pkg) throw new MoneyError('not_found', 'package');
  const settings = await loadPaymentSettings(db, clubId);
  if (method === 'sbp' && !settings.sbp) throw new MoneyError('bad_request', 'СБП недоступна');
  if (method === 'card' && !settings.card) throw new MoneyError('bad_request', 'карта недоступна');
  const paymentId = stableUuid(`bl.payment/package/${userId}/${key}`);
  const items = [packageItem(pkg, settings.vat_code)];
  const { payment, confirmation } = await createYooKassaPayment(db, deps, config, {
    settings,
    clubId,
    paymentId,
    idempotenceKey: `pk-${key}`,
    requestKey: key,
    kind: 'package',
    method,
    amountKopecks: Number(pkg.price_kopecks),
    capture: true,
    receipt: { customer: { phone: receiptPhone(phone) }, items, ...(settings.tax_system_code != null ? { tax_system_code: settings.tax_system_code } : {}) },
    confirmation: { type: 'redirect', returnUrl: ownUrl ?? returnUrl(config, paymentId) },
    description: `Пакет часов «${pkg.title}»`,
    metadata: { package_id: pkg.id },
    packageId: pkg.id,
    userId,
    phone,
    now: deps.clock.now(),
  });
  if (payment.package_id !== pkg.id || payment.user_id !== userId) throw new MoneyError('idempotency_conflict');
  return { payment_id: payment.id, status: payment.status, ...(confirmation ? { confirmation } : {}) };
}

export async function myBalance(db, deps, info) {
  const clubId = info.params.club;
  if (!isUuid(clubId)) throw new MoneyError('not_found', 'club');
  const userId = requireUser(info);
  await enterClub(db, clubId);
  return balanceOf(db, { clubId, userId, now: deps.clock.now() });
}

/** POST /api/packages/lots/{id}/refund — управляющий и выше, причина (№118): возврат пакета из приложения. */
export async function refundLot(db, deps, config, info) {
  const id = info.params.id;
  if (!isUuid(id)) throw new MoneyError('not_found', 'lot');
  const clubId = await enterObjectClub(db, 'lot', id);
  await requireStaff(db, info, clubId, MANAGER_ROLES);
  const reason = reasonOf(info.body);
  const { revokePackageLot } = await import('../payments/api.mjs');
  return revokePackageLot(db, { lotId: id, reason, staffId: info.userId }, { deps, config });
}
