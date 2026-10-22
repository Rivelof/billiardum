// Настройки кассы и бара клуба — ключи pos_* в bl.clubs.settings (как настройки light и money).
//
//   pos_discount_limit_percent  лимит скидки ресепшена, % (по умолчанию 10, decisions №82)
//   pos_stop_at_zero            товар с учётом склада и остатком ≤ 0 — в стоп-листе (по умолчанию false)
//   pos_tab_limit_kopecks       предел счёта стола (заказы «в счёт стола»), null — без предела
//   pos_receipt_email           почта для чека ЮKassa при СБП на кассе, если покупатель не дал телефон
//
// Меняет владелец: PATCH /api/clubs/{club}/pos/settings (api/routes/pos.mjs).

export const POS_DEFAULTS = Object.freeze({
  discount_limit_percent: 10,
  stop_at_zero: false,
  tab_limit_kopecks: null,
  receipt_email: null,
});

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}$/;

/** Значения из settings клуба с проверкой (неверное — по умолчанию). */
export function readPosSettings(settings = {}) {
  const s = settings ?? {};
  const limit = s.pos_discount_limit_percent;
  const tab = s.pos_tab_limit_kopecks;
  const email = s.pos_receipt_email;
  return {
    discount_limit_percent: Number.isInteger(limit) && limit >= 0 && limit <= 100 ? limit : POS_DEFAULTS.discount_limit_percent,
    stop_at_zero: typeof s.pos_stop_at_zero === 'boolean' ? s.pos_stop_at_zero : POS_DEFAULTS.stop_at_zero,
    tab_limit_kopecks: Number.isSafeInteger(tab) && tab > 0 ? tab : null,
    receipt_email: typeof email === 'string' && EMAIL.test(email) ? email : null,
  };
}

/** Проверить изменение настроек от владельца → объект ключей pos_* для слияния с settings. */
export function validatePosSettingsPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out = {};
  const known = ['discount_limit_percent', 'stop_at_zero', 'tab_limit_kopecks', 'receipt_email'];
  for (const k of Object.keys(body)) if (!known.includes(k)) return null;
  if ('discount_limit_percent' in body) {
    const v = body.discount_limit_percent;
    if (!Number.isInteger(v) || v < 0 || v > 100) return null;
    out.pos_discount_limit_percent = v;
  }
  if ('stop_at_zero' in body) {
    if (typeof body.stop_at_zero !== 'boolean') return null;
    out.pos_stop_at_zero = body.stop_at_zero;
  }
  if ('tab_limit_kopecks' in body) {
    const v = body.tab_limit_kopecks;
    if (v !== null && (!Number.isSafeInteger(v) || v < 100 || v > 100_000_000)) return null;
    out.pos_tab_limit_kopecks = v;
  }
  if ('receipt_email' in body) {
    const v = body.receipt_email;
    if (v !== null && (typeof v !== 'string' || !EMAIL.test(v))) return null;
    out.pos_receipt_email = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function loadClub(db, clubId) {
  const { rows } = await db.query('select id, name, timezone, settings from bl.clubs where id = $1', [clubId]);
  return rows[0] ?? null;
}

export async function posSettings(db, clubId) {
  const club = await loadClub(db, clubId);
  return readPosSettings(club?.settings);
}
