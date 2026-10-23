// QR-наклейки столов в мастере (M5.1 №159, §16 п. 8, backend-B).
//
//   GET /api/clubs/{club}/qr-stickers.pdf[?resources=id,id] — PDF A4 (server/qr/stickers.mjs) по выбранным
//   столам в работе (без параметра — по всем). Выгрузка отмечается: resources.sticker_printed_at = сейчас
//   и запись журнала qr.stickers_printed. printedAt — пункт 6 чек-листа запуска (№160).

import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { isUuid } from '../lib/store.mjs';
import { stickersPdf } from '../qr/stickers.mjs';

export const MAX_SELECTED = 200;

/** ?resources=id,id → массив UUID (без повторов) или null (параметра нет). */
export function parseResourceList(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > MAX_SELECTED * 37) throw new HttpError(400, 'bad_request', { detail: 'resources' });
  const ids = [...new Set(value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_SELECTED || !ids.every(isUuid)) throw new HttpError(400, 'bad_request', { detail: 'resources' });
  return ids;
}

/**
 * PDF наклеек и отметка печати.
 * @param {import('pg').ClientBase} db транзакция в контексте клуба
 * @param {{ clubId: string, userId: string|null, publicHost: string, resources?: string, now: Date }} p
 * @returns {Promise<Buffer>}
 */
export async function printStickers(db, { clubId, userId, publicHost, resources, now }) {
  const ids = parseResourceList(resources);
  const club = (await db.query('select name from bl.clubs where id = $1', [clubId])).rows[0];
  if (!club) throw new HttpError(404, 'not_found');
  const { rows } = await db.query(
    `select id, number, code from bl.resources
      where club_id = $1 and active and code is not null and ($2::uuid[] is null or id = any($2::uuid[]))
      order by number`,
    [clubId, ids],
  );
  if (ids && rows.length !== ids.length) throw new HttpError(404, 'not_found', { detail: 'resources' });
  if (rows.length === 0) throw new HttpError(404, 'not_found');
  const pdf = stickersPdf({ clubName: club.name, publicHost, resources: rows });
  const printed = rows.map((r) => r.id);
  await db.query('update bl.resources set sticker_printed_at = $2 where id = any($1::uuid[])', [printed, now]);
  await appendAudit(db, {
    action: 'qr.stickers_printed',
    objectType: 'club',
    objectId: clubId,
    actorType: 'user',
    actorId: userId,
    data: { count: printed.length, resource_ids: printed, selected: ids !== null },
  });
  return pdf;
}

/** Когда наклейки последний раз выгружались (любого стола клуба); null — ни разу. db — в контексте клуба. */
export async function printedAt(db, clubId) {
  const { rows } = await db.query('select max(sticker_printed_at) as at from bl.resources where club_id = $1', [clubId]);
  return rows[0].at ?? null;
}

/** Подробно: столов в работе, из них с выгруженной наклейкой, и последняя выгрузка. */
export async function printStatus(db, clubId) {
  const { rows } = await db.query(
    `select count(*) filter (where active)::int as active,
            count(*) filter (where active and sticker_printed_at is not null)::int as printed,
            max(sticker_printed_at) as last
       from bl.resources where club_id = $1`,
    [clubId],
  );
  const r = rows[0];
  return { active: r.active, printed: r.printed, printed_at: r.last ? r.last.toISOString() : null };
}
