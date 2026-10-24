// Курсор страниц API клуба (M5.7): base64url от JSON [время ISO, UUID] — брони (/api/v1/club/bookings)
// и журнал доставок вебхука. Разбор строгий: base64url без мусора, ровно два элемента, время —
// каноническая строка toISOString() (V8 принимает Date.parse("1"), Postgres на ::timestamptz — нет),
// второй — UUID как в роутере. Кривой курсор — 400 bad_request, до запроса в базу.

import { HttpError } from '../http/errors.mjs';
import { isUuid } from '../lib/store.mjs';

const B64URL = /^[A-Za-z0-9_-]{1,512}$/;

/** Курсор для next_cursor: at — Date или строка времени, id — UUID. */
export function encodeCursor(at, id) {
  return Buffer.from(JSON.stringify([new Date(at).toISOString(), id])).toString('base64url');
}

/** Строгое ISO-время: строка, равная своему toISOString(). */
export function isIsoTime(x) {
  if (typeof x !== 'string') return false;
  const d = new Date(x);
  return !Number.isNaN(d.getTime()) && d.toISOString() === x;
}

/** Разобрать курсор: нет (undefined или '') — null, иначе [iso, uuid]; кривой — 400 bad_request. */
export function decodeCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw);
  if (B64URL.test(s)) {
    const buf = Buffer.from(s, 'base64url');
    if (buf.toString('base64url') === s) {
      try {
        const v = JSON.parse(buf.toString('utf8'));
        if (Array.isArray(v) && v.length === 2 && isIsoTime(v[0]) && isUuid(v[1])) return [v[0], v[1]];
      } catch {
        // ниже — 400
      }
    }
  }
  throw new HttpError(400, 'bad_request', { detail: 'cursor' });
}
