// Минимальный генератор PDF 1.7: страницы с векторной графикой и текстом шрифтом
// TrueType, встроенным целиком (Type0 / CIDFontType2, Identity-H) с ToUnicode — текст
// на кириллице печатается и копируется. Без внешних пакетов.

import { deflateSync } from 'node:zlib';
import { parseTtf } from './ttf.mjs';

const enc = (s) => Buffer.from(s, 'latin1');

/** Число для PDF: до 3 знаков после точки, без экспоненты. */
export function num(n) {
  if (!Number.isFinite(n)) throw new Error('pdf: число');
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Строка PDF в UTF-16BE с BOM (hex) — для метаданных на кириллице. */
export function textString(s) {
  const buf = Buffer.from(`\uFEFF${s}`, 'utf16le').swap16();
  return `<${buf.toString('hex').toUpperCase()}>`;
}

export function createPdf() {
  const objects = [null]; // объект n → Buffer тела
  const pages = [];
  const fonts = [];
  const pagesId = alloc();

  function alloc() {
    objects.push(null);
    return objects.length - 1;
  }

  function set(id, body) {
    objects[id] = Buffer.isBuffer(body) ? body : enc(body);
  }

  function stream(dict, data, { compress = true } = {}) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    const payload = compress ? deflateSync(raw) : raw;
    const d = `<< ${dict}${dict ? ' ' : ''}/Length ${payload.length}${compress ? ' /Filter /FlateDecode' : ''} >>`;
    return Buffer.concat([enc(`${d}\nstream\n`), payload, enc('\nendstream')]);
  }

  /**
   * Встроить шрифт TrueType. Возвращает { name, encode(text) → '<hex>', width(text, size) }.
   * Учитываются использованные глифы: по ним пишутся ширины (W) и ToUnicode.
   */
  function addFont(ttfBuffer, baseName) {
    const ttf = parseTtf(ttfBuffer);
    const scale = 1000 / ttf.unitsPerEm;
    const used = new Map(); // gid → кодовая точка
    const font = {
      name: `F${fonts.length + 1}`,
      id: alloc(),
      ttf,
      baseName: baseName.replace(/[^A-Za-z0-9-]/g, ''),
      encode(text) {
        let hex = '';
        for (const ch of text) {
          const cp = ch.codePointAt(0);
          const gid = ttf.glyph(cp);
          if (!used.has(gid)) used.set(gid, cp);
          hex += gid.toString(16).padStart(4, '0');
        }
        return `<${hex.toUpperCase()}>`;
      },
      width(text, size) {
        let w = 0;
        for (const ch of text) w += ttf.advance(ttf.glyph(ch.codePointAt(0)));
        return (w * size) / ttf.unitsPerEm;
      },
      finish() {
        const descendant = alloc();
        const descriptor = alloc();
        const file = alloc();
        const toUnicode = alloc();
        const gids = [...used.keys()].sort((a, b) => a - b);
        const w = gids.map((g) => `${g} [${Math.round(ttf.advance(g) * scale)}]`).join(' ');
        set(font.id, `<< /Type /Font /Subtype /Type0 /BaseFont /${font.baseName} /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
        set(
          descendant,
          `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.baseName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap /Identity /DW ${Math.round(ttf.advance(0) * scale)} /W [${w}] >>`,
        );
        const bbox = ttf.bbox.map((v) => Math.round(v * scale)).join(' ');
        set(
          descriptor,
          `<< /Type /FontDescriptor /FontName /${font.baseName} /Flags 32 /FontBBox [${bbox}] /ItalicAngle ${num(ttf.italicAngle)} /Ascent ${Math.round(ttf.ascent * scale)} /Descent ${Math.round(ttf.descent * scale)} /CapHeight ${Math.round(ttf.capHeight * scale)} /StemV 120 /FontFile2 ${file} 0 R >>`,
        );
        set(file, stream(`/Length1 ${ttfBuffer.length}`, ttfBuffer));
        const entries = gids.filter((g) => g !== 0).map((g) => `<${g.toString(16).padStart(4, '0')}> <${utf16hex(used.get(g))}>`);
        let cmap =
          '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
          '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
          '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
          '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
        for (let i = 0; i < entries.length; i += 100) {
          const chunk = entries.slice(i, i + 100);
          cmap += `${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar\n`;
        }
        cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
        set(toUnicode, stream('', cmap));
      },
    };
    fonts.push(font);
    return font;
  }

  return {
    addFont,
    /** Страница A4 (по умолчанию) с содержимым content (операторы PDF). */
    addPage(content, { width = 595.28, height = 841.89 } = {}) {
      const id = alloc();
      const contents = alloc();
      set(contents, stream('', content));
      pages.push({ id, contents, width, height });
      return id;
    },
    /** Собрать файл. */
    build({ title = '', producer = 'Bilyardum' } = {}) {
      for (const f of fonts) f.finish();
      const fontRes = fonts.map((f) => `/${f.name} ${f.id} 0 R`).join(' ');
      for (const p of pages) {
        set(
          p.id,
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}] /Resources << /Font << ${fontRes} >> /ProcSet [/PDF /Text] >> /Contents ${p.contents} 0 R >>`,
        );
      }
      set(pagesId, `<< /Type /Pages /Kids [${pages.map((p) => `${p.id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
      const catalog = alloc();
      set(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
      const info = alloc();
      set(info, `<< /Title ${textString(title)} /Producer (${producer.replace(/[()\\]/g, '')}) >>`);

      const chunks = [enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
      let offset = chunks[0].length;
      const offsets = [0];
      for (let i = 1; i < objects.length; i += 1) {
        if (!objects[i]) throw new Error(`pdf: объект ${i} не задан`);
        const part = Buffer.concat([enc(`${i} 0 obj\n`), objects[i], enc('\nendobj\n')]);
        offsets.push(offset);
        chunks.push(part);
        offset += part.length;
      }
      let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
      for (let i = 1; i < objects.length; i += 1) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
      xref += `trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
      chunks.push(enc(xref));
      return Buffer.concat(chunks);
    },
  };
}

function utf16hex(cp) {
  return Buffer.from(String.fromCodePoint(cp), 'utf16le').swap16().toString('hex').toUpperCase();
}
