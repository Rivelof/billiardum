// Сеть клуба из контекста (M5.5 №191) для модулей клуба: тарифы (server/setup/tariffs.mjs) и меню
// (server/catalog/service.mjs) спрашивают, задан ли шаблон сети и «жёсткий» ли он.
// Без импортов модулей клуба: setup и catalog импортируют этот файл.
//
// db — транзакция в контексте клуба: RLS отдаёт только строку этого клуба и его сеть.

/** Поля товара, которые задаёт шаблон меню сети (остальное — стоп-лист, склад, фото, порядок — клуб ведёт сам). */
export const MENU_TEMPLATE_FIELDS = Object.freeze(['category_id', 'name', 'description', 'sku', 'price_kopecks', 'unit', 'is_alcohol', 'vat_code', 'payment_subject', 'active']);

/**
 * Сеть клуба: { network_id, name, tariffs_mode, menu_mode, tariffs_template, menu_template, tariffs_override,
 *   tariffs_version (применённая), menu_version (применённая), network_tariffs_version, network_menu_version } или null.
 */
export async function clubNetwork(db, clubId) {
  const { rows } = await db.query(
    `select c.network_id, n.name, n.tariffs_mode, n.menu_mode, n.tariffs_template, n.menu_template, c.tariffs_override,
            c.tariffs_version, c.menu_version, n.tariffs_version as network_tariffs_version, n.menu_version as network_menu_version
       from bl.network_clubs c join bl.networks n on n.id = c.network_id
      where c.club_id = $1 and c.active and n.archived_at is null`,
    [clubId],
  );
  return rows[0] ?? null;
}

/** Отметить переопределение тарифов сети клубом (мягкий шаблон) или снять его. */
export async function markTariffsOverride(db, clubId, on, now) {
  await db.query('update bl.network_clubs set tariffs_override = $2, updated_at = $3 where club_id = $1 and active', [clubId, on, now]);
}
