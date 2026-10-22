// QR-наклейки без базы: PDF структурно корректен (таблица xref указывает на объекты),
// число страниц по 4 наклейки на A4, шрифт встроен с ToUnicode, QR читается (jsQR).
// Если в системе есть pdftoppm (poppler), страница рендерится и QR распознаётся с картинки.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import jsQR from 'jsqr';
import { formatCode, qrMatrix, stickersPdf, tableUrl } from '../qr/stickers.mjs';

const tables = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1, code: `TEST0000${String(i + 1).padStart(2, '0')}` }));

/** Разбор PDF: xref, объекты, число страниц. Бросает при нарушении структуры. */
function parsePdf(buf) {
  const text = buf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.7\n'), 'заголовок');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'конец файла');
  const sx = /startxref\n(\d+)\n%%EOF\s*$/.exec(text);
  assert.ok(sx, 'startxref');
  const xrefAt = Number(sx[1]);
  assert.equal(text.slice(xrefAt, xrefAt + 4), 'xref', 'startxref указывает на xref');
  const head = /^xref\n0 (\d+)\n/.exec(text.slice(xrefAt));
  const count = Number(head[1]);
  const entries = text.slice(xrefAt + head[0].length).split('\n').slice(0, count);
  assert.equal(entries[0], '0000000000 65535 f ');
  const objects = new Map();
  for (let i = 1; i < count; i += 1) {
    const m = /^(\d{10}) 00000 n $/.exec(entries[i]);
    assert.ok(m, `запись xref ${i}`);
    const off = Number(m[1]);
    assert.equal(text.slice(off, off + `${i} 0 obj\n`.length), `${i} 0 obj\n`, `объект ${i} по смещению`);
    const end = text.indexOf('\nendobj\n', off);
    objects.set(i, { off, body: text.slice(off + `${i} 0 obj\n`.length, end) });
  }
  const trailer = /trailer\n<< \/Size (\d+) \/Root (\d+) 0 R/.exec(text);
  assert.equal(Number(trailer[1]), count);
  const pagesObj = [...objects.values()].find((o) => o.body.startsWith('<< /Type /Pages'));
  const pages = Number(/\/Count (\d+)/.exec(pagesObj.body)[1]);
  const kids = /\/Kids \[([^\]]*)\]/.exec(pagesObj.body)[1].match(/\d+ 0 R/g);
  assert.equal(kids.length, pages);
  for (const o of objects.values()) {
    const s = /\/Length (\d+)/.exec(o.body);
    if (s && o.body.includes('stream\n')) {
      const start = o.body.indexOf('stream\n') + 7;
      const raw = Buffer.from(o.body.slice(start, o.body.lastIndexOf('\nendstream')), 'latin1');
      assert.equal(raw.length, Number(s[1]), 'длина потока');
      if (o.body.includes('/FlateDecode')) inflateSync(raw);
    }
  }
  return { text, objects, pages };
}

describe('QR-наклейки', () => {
  it('8 столов — 2 страницы A4, 9 — 3, 1 — 1; структура PDF корректна', () => {
    for (const [n, pages] of [
      [8, 2],
      [9, 3],
      [1, 1],
    ]) {
      const pdf = stickersPdf({ clubName: 'Тестовый клуб', publicHost: 'bl.example.ru', resources: tables(n) });
      const parsed = parsePdf(pdf);
      assert.equal(parsed.pages, pages, `${n} столов`);
      assert.match(parsed.text, /\/MediaBox \[0 0 595\.28 841\.89\]/);
    }
  });

  it('шрифт с кириллицей встроен (FontFile2, Identity-H) с ToUnicode; внешних ресурсов нет', () => {
    const pdf = stickersPdf({ clubName: 'Клуб «Шар»', publicHost: 'bl.example.ru', resources: tables(2) });
    const { text, objects } = parsePdf(pdf);
    assert.match(text, /\/Subtype \/Type0 \/BaseFont \/JetBrainsMono-Bold \/Encoding \/Identity-H/);
    assert.match(text, /\/FontFile2 \d+ 0 R/);
    assert.doesNotMatch(text, /\/URI|\/Launch|\/JavaScript|http:\/\//);
    const cmap = [...objects.values()].find((o) => o.body.includes('/Length') && o.body.length < 20000 && (() => {
      try {
        const start = o.body.indexOf('stream\n') + 7;
        return inflateSync(Buffer.from(o.body.slice(start, o.body.lastIndexOf('\nendstream')), 'latin1')).toString('latin1').includes('beginbfchar');
      } catch {
        return false;
      }
    })());
    assert.ok(cmap, 'ToUnicode');
    const start = cmap.body.indexOf('stream\n') + 7;
    const cmapText = inflateSync(Buffer.from(cmap.body.slice(start, cmap.body.lastIndexOf('\nendstream')), 'latin1')).toString('latin1');
    // «С» (U+0421) и «Т» (U+0422) из «СТОЛ».
    assert.match(cmapText, /<0421>/);
    assert.match(cmapText, /<0422>/);
  });

  it('QR читается и ведёт на https://{PUBLIC_HOST}/t/{code}', () => {
    const url = tableUrl('bl.example.ru', 'TEST000004');
    assert.equal(url, 'https://bl.example.ru/t/TEST000004');
    const m = qrMatrix(url);
    const scale = 6;
    const quiet = 4;
    const size = (m.length + quiet * 2) * scale;
    const data = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < m.length; y += 1) {
      for (let x = 0; x < m.length; x += 1) {
        if (!m[y][x]) continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
        }
      }
    }
    assert.equal(jsQR(data, size, size)?.data, url);
    assert.equal(formatCode('TEST000004'), 'TEST0 00004');
  });

  it('неверный код стола или PUBLIC_HOST — ошибка', () => {
    assert.throws(() => stickersPdf({ clubName: 'К', publicHost: 'bl.example.ru', resources: [{ number: 1, code: 'test000001' }] }));
    assert.throws(() => stickersPdf({ clubName: 'К', publicHost: 'https://bl.example.ru', resources: tables(1) }));
  });

  const poppler = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' });
  it('страница рендерится poppler, все 4 QR распознаются с картинки', { skip: poppler.error ? 'нет pdftoppm' : false }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bl-qr-'));
    try {
      const file = path.join(dir, 'q.pdf');
      writeFileSync(file, stickersPdf({ clubName: 'Тестовый клуб', publicHost: 'bl.example.ru', resources: tables(4) }));
      const r = spawnSync('pdftoppm', ['-r', '150', '-gray', '-f', '1', '-l', '1', file, path.join(dir, 'p')]);
      assert.equal(r.status, 0);
      const img = readFileSync(path.join(dir, 'p-1.pgm'));
      const hdr = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(img.toString('latin1', 0, 40));
      const [W, H, off] = [Number(hdr[1]), Number(hdr[2]), hdr[0].length];
      const cw = Math.floor(W / 2);
      const ch = Math.floor(H / 2);
      for (let i = 0; i < 4; i += 1) {
        const x0 = (i % 2) * cw;
        const y0 = Math.floor(i / 2) * ch;
        const d = new Uint8ClampedArray(cw * ch * 4);
        for (let y = 0; y < ch; y += 1) {
          for (let x = 0; x < cw; x += 1) {
            const v = img[off + (y0 + y) * W + x0 + x];
            const j = (y * cw + x) * 4;
            d[j] = d[j + 1] = d[j + 2] = v;
            d[j + 3] = 255;
          }
        }
        assert.equal(jsQR(d, cw, ch)?.data, `https://bl.example.ru/t/TEST0000${String(i + 1).padStart(2, '0')}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
