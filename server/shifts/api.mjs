// Интерфейс смен для соседей (контракт M2 §5): касса проверяет открытую смену.
//
//   currentShift(db, clubId) → { id, club_id, number, opened_at, opened_by, opened_by_name, float_kopecks } | null
//
// db — транзакция вызывающего в контексте клуба clubId. Одна открытая смена на клуб (№83);
// без неё касса не принимает наличные (shift_closed).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function shiftBrief(s) {
  return {
    id: s.id,
    club_id: s.club_id,
    number: s.number,
    opened_at: new Date(s.opened_at).toISOString(),
    opened_by: s.opened_by,
    opened_by_name: s.opened_by_name ?? null,
    float_kopecks: Number(s.float_kopecks),
  };
}

/**
 * Открытая смена клуба или null.
 * @param {import('pg').ClientBase} db
 * @param {string} clubId
 * @param {{ forUpdate?: boolean }} [options] forUpdate — заблокировать строку смены до конца транзакции
 */
export async function currentShift(db, clubId, { forUpdate = false } = {}) {
  if (typeof clubId !== 'string' || !UUID.test(clubId)) throw new Error('currentShift: clubId');
  const { rows } = await db.query(
    `select s.*, (select u.name from bl.users u where u.id = s.opened_by) as opened_by_name
       from bl.shifts s where s.club_id = $1 and s.closed_at is null ${forUpdate ? 'for update of s' : ''}`,
    [clubId],
  );
  return rows[0] ? shiftBrief(rows[0]) : null;
}
