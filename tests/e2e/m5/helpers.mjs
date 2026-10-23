// Общее для сценариев приёмки M5.1 «Подключение клуба без выезда» (tests/e2e/m5): T26–T28.
// Работают на поднятом `npm run dev` поверх хелперов M1–M4: API через Caddy, эмулятор ЮKassa —
// `docker exec`, база — только чтение (DATABASE_ADMIN_URL). Новые клубы, пользователи и
// контроллеры создаются через API и `scripts/provision-factory.mjs`; 8 столов сида не трогаются.
//
// Новые контроллеры — отдельный процесс симулятора на хосте в режиме --claim (порт 18081, для
// браузерного сценария — 18082), как в tools/device-sim/README.md «Новый контроллер». Состояние
// между файлами (клуб, телефоны, устройства, коды привязки) — в E2E_M5_DIR (по умолчанию
// $TMPDIR/bl-e2e-m5, права 0600), вне репозитория. Секреты в вывод не попадают (только маска).

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { api, BASE, login, ok, REPO_ROOT, sleep, waitFor } from '../m4/helpers.mjs';
import { CADDY_CONTAINER } from '../m0/helpers.mjs';
export { appClient, attempt } from '../m0/helpers.mjs';

export * from '../m4/helpers.mjs';

export const STATE_DIR = process.env.E2E_M5_DIR || path.join(os.tmpdir(), 'bl-e2e-m5');
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

/** Магазины эмулятора ЮKassa для новых клубов (README «Подключение нового клуба»): не секреты, учётки эмулятора. */
export const SHOPS = Object.freeze({
  test: { shop_id: '800001', secret_key: 'test_emu_800001_dev_only' },
  live: { shop_id: '800002', secret_key: 'live_emu_800002_dev_only' },
  liveNoFiscal: { shop_id: '800003', secret_key: 'live_emu_800003_dev_only' },
});
export const EKB_TZ = 'Asia/Yekaterinburg';
export const ANDREY_ID = 'af000000-0000-4000-8000-000000000009'; // platform_admin сида

// Состояние между файлами ---------------------------------------------------------------------

export function stateFile(name = 'state') {
  return path.join(STATE_DIR, `${name}.json`);
}

export function loadState(name = 'state') {
  try {
    return JSON.parse(readFileSync(stateFile(name), 'utf8'));
  } catch {
    return {};
  }
}

export function saveState(patch, name = 'state') {
  const s = { ...loadState(name), ...patch };
  writeFileSync(stateFile(name), JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(stateFile(name), 0o600);
  return s;
}

/** Синтетический телефон +7998…: владельцы и персонал новых клубов (гости — +7999…). */
let seq = 0;
export function staffPhone() {
  seq += 1;
  const n = (Date.now() % 1_000_000) * 10 + (seq % 10);
  return `+7998${String(n).padStart(7, '0').slice(-7)}`;
}

/** Вход для разработки с паузой при 429 (лимит 30 в минуту). */
export async function loginRetry(phone, opts = {}) {
  for (let i = 0; ; i += 1) {
    try {
      return await login(phone, opts);
    } catch (err) {
      if (!/HTTP 200, пришло 429/.test(err.message) || i >= 4) throw err;
      await sleep(20_000);
    }
  }
}

// HTTP с телом-файлом -----------------------------------------------------------------------

let caPem;
export function caddyCa() {
  if (!caPem) {
    const r = spawnSync('docker', ['exec', CADDY_CONTAINER, 'cat', '/data/caddy/pki/authorities/local/root.crt'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`корень CA Caddy: ${r.stderr.trim()}`);
    caPem = r.stdout;
  }
  return caPem;
}

/** Файл корня CA Caddy в STATE_DIR (для симулятора и моста ККТ на хосте). */
export function caddyCaFile() {
  const f = path.join(STATE_DIR, 'caddy-root.crt');
  if (!existsSync(f)) writeFileSync(f, caddyCa(), { mode: 0o600 });
  return f;
}

/** Запрос с сырым телом (xlsx, PDF). → { status, json, buf, headers } */
export function apiRaw(method, pathname, { token, body, contentType, headers = {}, timeoutMs = 20_000 } = {}) {
  const url = new URL(pathname, BASE);
  const h = { accept: '*/*', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body) {
    h['content-type'] = contentType;
    h['content-length'] = String(body.length);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: h, ca: caddyCa(), timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json, buf, headers: res.headers, text: buf.toString('utf8').slice(0, 2000) });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${pathname}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Запрос сотрудника в контексте клуба (X-Club-Id). */
export function capi(method, pathname, { token, club, body, idem, headers = {} } = {}) {
  return api(method, pathname, { token, body, idem, headers: { ...headers, ...(club ? { 'x-club-id': club } : {}) } });
}

// .xlsx без зависимостей: zip «stored» + XML первого листа --------------------------------------

function zipStored(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 имена
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (i) => String.fromCharCode(65 + i);

/**
 * Книга Excel из строк: строки — в общих строках (sharedStrings), числа — числом, объект
 * { f, v } — формула с сохранённым значением (сервер берёт <v>).
 */
export function makeXlsx(rows) {
  const shared = [];
  const sIdx = (s) => {
    let i = shared.indexOf(s);
    if (i < 0) i = shared.push(s) - 1;
    return i;
  };
  const sheetRows = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${col(ci)}${ri + 1}`;
          if (v === null || v === undefined || v === '') return '';
          if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
          if (typeof v === 'object') return `<c r="${ref}"><f>${esc(v.f)}</f><v>${v.v}</v></c>`;
          return `<c r="${ref}" t="s"><v>${sIdx(String(v))}</v></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  const files = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Меню" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    ],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
  ];
  files.push([
    'xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`,
  ]);
  return zipStored(files);
}

/** Меню сценария: 3 позиции (число, строка с запятой, формула) и алкоголь (не в QR-меню). */
export const MENU_ROWS = [
  ['категория', 'название', 'цена', 'ед', 'алкоголь'],
  ['Напитки', 'Вода e2e', 120, 'шт', 'нет'],
  ['Напитки', 'Чай e2e', '150,50', 'порц', ''],
  ['Закуски', 'Орешки e2e', { f: 'B1*0+90', v: 90 }, 'шт', 'нет'],
  ['Бар', 'Пиво e2e', 250, 'шт', 'да'],
];

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Заводские контроллеры и симулятор --claim ----------------------------------------------------

/**
 * scripts/provision-factory.mjs --count n: PDF и команды factory — в STATE_DIR.
 * → [{ device_id, claim_code, qr }] (коды — только в файлах 0600 вне репозитория).
 */
export function provisionFactory(n, tag) {
  const pdf = path.join(STATE_DIR, `factory-${tag}.pdf`);
  const cmds = path.join(STATE_DIR, `factory-${tag}.txt`);
  const r = spawnSync(process.execPath, ['scripts/provision-factory.mjs', '--count', String(n), '--batch', `E2E-M5-${tag}`, '--out', pdf, '--commands-out', cmds], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`provision-factory: ${r.stderr.trim()}`);
  const devices = readFileSync(cmds, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [, deviceId, code] = line.split(' ');
      return { device_id: deviceId, claim_code: code, qr: `BLD1:${deviceId}:${code}` };
    });
  return { devices, pdf, cmds, stderr: r.stderr.trim() };
}

/** Запустить симулятор новых контроллеров отдельным процессом (detached). → { pid, log } */
export function startClaimSim({ qrs, port, tag }) {
  const logFile = path.join(STATE_DIR, `sim-${tag}.log`);
  const claimDir = path.join(STATE_DIR, `claim-${tag}`);
  mkdirSync(claimDir, { recursive: true, mode: 0o700 });
  const fd = openSync(logFile, 'a', 0o600);
  const args = ['tools/device-sim/index.mjs'];
  for (const q of qrs) args.push('--claim', q);
  const env = { ...process.env };
  for (const k of ['SIM_DEVICES_FILE', 'SIM_TABLES', 'SIM_FAULTS', 'SIM_NVS_DIR', 'SIM_CLAIM']) delete env[k];
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: {
      ...env,
      SIM_API_URL: BASE,
      SIM_API_CA_FILE: caddyCaFile(),
      MQTT_URL: 'mqtts://localhost:8883',
      MQTT_CA_FILE: path.join(REPO_ROOT, 'deploy/dev/certs/ca.crt'),
      SIM_CONTROL_PORT: String(port),
      SIM_CLAIM_DIR: claimDir,
    },
  });
  child.unref();
  closeSync(fd);
  return { pid: child.pid, log: logFile };
}

export function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopProcess(pid) {
  if (processAlive(pid)) process.kill(pid, 'SIGTERM');
}

export function simLog(tag) {
  const f = path.join(STATE_DIR, `sim-${tag}.log`);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function claimSim(port, n = null) {
  const r = await fetch(`http://127.0.0.1:${port}/sim/tables${n ? `/${n}` : ''}`);
  return r.json();
}

/** Номер стола симулятора (101, 102…) по device_id. */
export async function simNumberOf(port, deviceId) {
  const list = await claimSim(port);
  return list.find((t) => t.device_id === deviceId)?.table ?? null;
}

export async function waitClaimSim(port, n, pred, { timeoutMs = 60_000, what } = {}) {
  return waitFor(
    async () => {
      const t = await claimSim(port, n).catch(() => null);
      return t && pred(t) ? t : null;
    },
    { timeoutMs, intervalMs: 200, what: what ?? `симулятор ${port} стол ${n}` },
  );
}

// Мост ККТ клуба на хосте (эмулятор АТОЛ на своём порту) -----------------------------------------

export function startHostKkt({ token, port, tag }) {
  const dir = path.join(STATE_DIR, `kkt-${tag}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'token.txt'), token, { mode: 0o600 });
  writeFileSync(
    path.join(dir, 'kkt-bridge.json'),
    JSON.stringify({ server_url: `wss://localhost:8443/api/kkt/ws`, token_file: 'token.txt', atol_url: `http://127.0.0.1:${port}`, atol_api: 'v2', name: `Ресепшн e2e ${tag}`, data_dir: 'data' }),
    { mode: 0o600 },
  );
  const out = [];
  for (const [name, args, env] of [
    ['emu', ['tools/kkt-bridge/emu/index.mjs'], { ATOL_EMU_PORT: String(port), ATOL_EMU_HOST: '127.0.0.1' }],
    ['bridge', ['tools/kkt-bridge/index.mjs', '--config', path.join(dir, 'kkt-bridge.json')], { NODE_EXTRA_CA_CERTS: caddyCaFile() }],
  ]) {
    const fd = openSync(path.join(dir, `${name}.log`), 'a', 0o600);
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
    child.unref();
    closeSync(fd);
    out.push(child.pid);
  }
  return { emuPid: out[0], bridgePid: out[1], dir };
}

export async function hostKkt(port, pathname, body) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
}

// База -----------------------------------------------------------------------------------------

/** Журнал клуба: действия с момента since. */
export async function clubAudit(db, clubId, { actions, since } = {}) {
  const { rows } = await db.query(
    `select seq, action, object_type, object_id, reason, actor_type, actor_id, data, created_at from bl.audit_log
      where club_id = $1 and ($2::text[] is null or action = any($2::text[])) and ($3::timestamptz is null or created_at >= $3)
      order by seq`,
    [clubId, actions ? [].concat(actions) : null, since ? new Date(since) : null],
  );
  return rows;
}

/** Команды устройств клуба за окно и их записи device.cmd. → { cmds, missing } */
export async function clubCmdsWithAudit(db, clubId, deviceIds, since) {
  const { rows: cmds } = await db.query(
    `select id, device_id, type, status, created_at, acked_at from bl.device_commands where device_id = any($1::uuid[]) and created_at >= $2 order by created_at`,
    [deviceIds, new Date(since)],
  );
  const ids = cmds.map((c) => c.id);
  const { rows: au } = ids.length
    ? await db.query("select data->>'cmd_id' as cmd_id from bl.audit_log where club_id = $1 and action = 'device.cmd' and data->>'cmd_id' = any($2::text[])", [clubId, ids])
    : { rows: [] };
  const have = new Set(au.map((r) => r.cmd_id));
  return { cmds, missing: cmds.filter((c) => !have.has(c.id) && !['skipped', 'queued', 'cancelled', 'superseded'].includes(c.status)) };
}

export async function alarmsOf(db, clubId, { since, type } = {}) {
  const { rows } = await db.query(
    'select id, type, level, resource_id, data, count, state, raised_at from bl.alarms where club_id = $1 and ($2::timestamptz is null or raised_at >= $2) and ($3::text is null or type = $3) order by raised_at',
    [clubId, since ? new Date(since) : null, type ?? null],
  );
  return rows;
}

/** Ответ строкой без телефонов — для диагностики. */
export function short(r) {
  return `${r.status} ${String(r.text ?? '').slice(0, 300).replace(/\+7\d{10}/g, '+7***')}`;
}

export { ok, api, login, waitFor, sleep };
