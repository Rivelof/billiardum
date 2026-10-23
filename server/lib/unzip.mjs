// Чтение zip-архива в памяти без зависимостей (M5.1 №157: .xlsx — это zip с XML).
//
// Только то, что нужно для офисных файлов: центральный каталог, методы stored (0) и deflate (8).
// Защита от испорченных файлов и zip-бомб:
//   * архив целиком в памяти и не больше maxArchiveBytes (проверяет вызывающий — тело запроса);
//   * записей не больше maxEntries; zip64, шифрование, многотомные архивы — отказ;
//   * сумма заявленных распакованных размеров всех записей — не больше maxTotalBytes;
//   * каждая запись распаковывается с пределом maxOutputLength = заявленный размер
//     (zlib обрывает распаковку, если данных больше), фактический размер и CRC-32 сверяются;
//   * распакованное суммарно (по фактическим данным) — тоже не больше maxTotalBytes.
// Ошибка — ZipError с кодом (bad_zip, too_large, too_many_entries, unsupported).

import { crc32, inflateRawSync } from 'node:zlib';

export const ZIP_DEFAULTS = Object.freeze({ maxEntries: 2_000, maxTotalBytes: 20 * 1024 * 1024 });

export class ZipError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ZipError';
    this.code = code;
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CDH = 0x02014b50;
const SIG_LFH = 0x04034b50;

function findEocd(buf) {
  // Конец центрального каталога: 22 байта + комментарий до 65 535 байт.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Каталог архива: [{ name, method, flags, compressedSize, size, crc, localOffset }].
 * @param {Buffer} buf
 * @param {{ maxEntries?: number, maxTotalBytes?: number }} [limits]
 */
export function listZip(buf, limits = {}) {
  const { maxEntries, maxTotalBytes } = { ...ZIP_DEFAULTS, ...limits };
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('bad_zip', 'не zip');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipError('bad_zip', 'нет конца каталога');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) throw new ZipError('unsupported', 'многотомный архив');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('unsupported', 'zip64');
  if (count > maxEntries) throw new ZipError('too_many_entries', `записей ${count}`);
  if (cdOffset + cdSize > eocd) throw new ZipError('bad_zip', 'каталог за пределами');
  const entries = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== SIG_CDH) throw new ZipError('bad_zip', 'запись каталога');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > eocd) throw new ZipError('bad_zip', 'имя записи');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('unsupported', 'zip64');
    if (flags & 0x1) throw new ZipError('unsupported', 'шифрование');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    total += size;
    if (total > maxTotalBytes) throw new ZipError('too_large', 'распакованный размер');
    entries.push({ name, method, flags, compressedSize, size, crc, localOffset });
    p = end;
  }
  return entries;
}

/**
 * Данные записи. budget — { left } общий остаток распаковки (байт), уменьшается.
 * @returns {Buffer}
 */
export function readEntry(buf, entry, budget = { left: ZIP_DEFAULTS.maxTotalBytes }) {
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LFH) throw new ZipError('bad_zip', 'локальный заголовок');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new ZipError('bad_zip', 'данные за пределами');
  if (entry.size > budget.left) throw new ZipError('too_large', 'распакованный размер');
  const raw = buf.subarray(start, end);
  let out;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new ZipError('bad_zip', 'размер stored');
    out = raw;
  } else if (entry.method === 8) {
    try {
      // Предел — заявленный размер (+1, чтобы «больше заявленного» отличалось от «ровно»).
      out = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size + 1) });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw new ZipError('too_large', 'распаковка больше заявленного');
      throw new ZipError('bad_zip', 'deflate');
    }
  } else {
    throw new ZipError('unsupported', `метод ${entry.method}`);
  }
  if (out.length !== entry.size) throw new ZipError(out.length > entry.size ? 'too_large' : 'bad_zip', 'размер записи');
  if ((crc32(out) >>> 0) !== entry.crc) throw new ZipError('bad_zip', 'crc');
  budget.left -= out.length;
  return out;
}

/**
 * Прочитать нужные записи архива по именам (без учёта регистра). Остальные не распаковываются.
 * @returns {{ entries: object[], read(name: string): Buffer|null }}
 */
export function openZip(buf, limits = {}) {
  const { maxTotalBytes } = { ...ZIP_DEFAULTS, ...limits };
  const entries = listZip(buf, limits);
  const byName = new Map();
  for (const e of entries) {
    const key = e.name.replace(/^\/+/, '').toLowerCase();
    if (!byName.has(key)) byName.set(key, e);
  }
  const budget = { left: maxTotalBytes };
  return {
    entries,
    has: (name) => byName.has(String(name).replace(/^\/+/, '').toLowerCase()),
    read(name) {
      const e = byName.get(String(name).replace(/^\/+/, '').toLowerCase());
      return e ? readEntry(buf, e, budget) : null;
    },
  };
}
