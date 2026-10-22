// Минимальный разбор TrueType для встраивания шрифта в PDF: метрики, ширины глифов,
// таблица cmap (Unicode → глиф, форматы 4 и 12).

export class TtfError extends Error {}

export function parseTtf(buf) {
  if (buf.length < 12) throw new TtfError('ttf: короткий файл');
  const version = buf.readUInt32BE(0);
  if (version !== 0x00010000 && version !== 0x74727565) throw new TtfError('ttf: не TrueType');
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i += 1) {
    const o = 12 + i * 16;
    tables[buf.toString('latin1', o, o + 4)] = { offset: buf.readUInt32BE(o + 8), length: buf.readUInt32BE(o + 12) };
  }
  for (const t of ['head', 'hhea', 'hmtx', 'maxp', 'cmap', 'glyf']) if (!tables[t]) throw new TtfError(`ttf: нет таблицы ${t}`);

  const head = tables.head.offset;
  const unitsPerEm = buf.readUInt16BE(head + 18);
  const bbox = [buf.readInt16BE(head + 36), buf.readInt16BE(head + 38), buf.readInt16BE(head + 40), buf.readInt16BE(head + 42)];
  const hhea = tables.hhea.offset;
  const ascent = buf.readInt16BE(hhea + 4);
  const descent = buf.readInt16BE(hhea + 6);
  const numberOfHMetrics = buf.readUInt16BE(hhea + 34);
  const numGlyphs = buf.readUInt16BE(tables.maxp.offset + 4);
  let capHeight = ascent;
  if (tables['OS/2'] && tables['OS/2'].length >= 90 && buf.readUInt16BE(tables['OS/2'].offset) >= 2) {
    capHeight = buf.readInt16BE(tables['OS/2'].offset + 88);
  }
  let italicAngle = 0;
  if (tables.post) italicAngle = buf.readInt32BE(tables.post.offset + 4) / 65536;

  const hmtx = tables.hmtx.offset;
  const lastAdvance = buf.readUInt16BE(hmtx + (numberOfHMetrics - 1) * 4);
  function advance(gid) {
    if (gid < numberOfHMetrics) return buf.readUInt16BE(hmtx + gid * 4);
    return lastAdvance;
  }

  const cmap = parseCmap(buf, tables.cmap.offset);
  return {
    unitsPerEm,
    bbox,
    ascent,
    descent,
    capHeight,
    italicAngle,
    numGlyphs,
    /** Глиф символа (кодовая точка) или 0 (.notdef). */
    glyph(cp) {
      const g = cmap.get(cp);
      return g === undefined || g >= numGlyphs ? 0 : g;
    },
    advance,
  };
}

function parseCmap(buf, base) {
  const count = buf.readUInt16BE(base + 2);
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const o = base + 4 + i * 8;
    const platform = buf.readUInt16BE(o);
    const encoding = buf.readUInt16BE(o + 2);
    const offset = base + buf.readUInt32BE(o + 4);
    const format = buf.readUInt16BE(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12 && (!best || best.format !== 12)) best = { format, offset };
    else if (format === 4 && !best) best = { format, offset };
  }
  if (!best) throw new TtfError('ttf: нет cmap Unicode формата 4 или 12');
  const map = new Map();
  if (best.format === 12) {
    const groups = buf.readUInt32BE(best.offset + 12);
    for (let g = 0; g < groups; g += 1) {
      const o = best.offset + 16 + g * 12;
      const start = buf.readUInt32BE(o);
      const end = buf.readUInt32BE(o + 4);
      const glyph = buf.readUInt32BE(o + 8);
      for (let cp = start; cp <= end && cp - start < 0x10000; cp += 1) map.set(cp, glyph + (cp - start));
    }
    return map;
  }
  const o = best.offset;
  const segX2 = buf.readUInt16BE(o + 6);
  const ends = o + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  for (let s = 0; s < segX2 / 2; s += 1) {
    const end = buf.readUInt16BE(ends + s * 2);
    const start = buf.readUInt16BE(starts + s * 2);
    const delta = buf.readInt16BE(deltas + s * 2);
    const rangeOffset = buf.readUInt16BE(ranges + s * 2);
    for (let cp = start; cp <= end && cp !== 0xffff; cp += 1) {
      let g;
      if (rangeOffset === 0) g = (cp + delta) & 0xffff;
      else {
        const at = ranges + s * 2 + rangeOffset + (cp - start) * 2;
        g = buf.readUInt16BE(at);
        if (g !== 0) g = (g + delta) & 0xffff;
      }
      if (g !== 0) map.set(cp, g);
    }
  }
  return map;
}
