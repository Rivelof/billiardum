// Общее для приёмки M5.3 «Подписка клубов» (tests/e2e/m5-3): T31, T32 — только API (экранов подписки нет).
// Магазин платформы на стенде — эмулятор 800010 (README, раздел M5.1/M5.3). Подставные часы — настоящий
// код server/billing внутри контейнера сервера (clock-runner.mjs), только для клуба сценария.
// Состояние между файлами — E2E_M53_DIR (по умолчанию $TMPDIR/bl-e2e-m53, права 0600).

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVER_CONTAINER } from '../m0/helpers.mjs';

export * from '../m5-2/helpers.mjs';

export const STATE_DIR = process.env.E2E_M53_DIR || path.join(os.tmpdir(), 'bl-e2e-m53');
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const STATE = path.join(STATE_DIR, 'state.json');
export const PLATFORM_SHOP = '800010';
export const OWNER_ID = 'a1000000-0000-4000-8000-000000000001';
export const MANAGER_ID = 'a1000000-0000-4000-8000-000000000003';
export const ANDREY = 'af000000-0000-4000-8000-000000000009';

export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}
export function saveState(patch) {
  const s = { ...loadState(), ...patch };
  writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(STATE, 0o600);
  return s;
}

/** Подставные часы подписки: команда clock-runner в контейнере сервера. → JSON */
export function billingAt(cmd, clubId, at) {
  const r = spawnSync('docker', ['exec', SERVER_CONTAINER, 'node', '/repo/tests/e2e/m5-3/clock-runner.mjs', cmd, clubId, new Date(at).toISOString()], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = r.stdout.trim().split('\n').at(-1) ?? '';
  let json;
  try {
    json = JSON.parse(line);
  } catch {
    throw new Error(`clock-runner ${cmd}: ${r.status} ${r.stderr.slice(0, 300)} ${line.slice(0, 300)}`);
  }
  if (!json.ok) throw new Error(`clock-runner ${cmd}: ${json.error} ${JSON.stringify(json.logs ?? []).slice(0, 400)}`);
  return json;
}

/** Секрет магазина платформы из окружения контейнера — только для поиска в ответах (в вывод не попадает). */
export function platformSecret() {
  const r = spawnSync('docker', ['exec', SERVER_CONTAINER, 'printenv', 'PLATFORM_YOOKASSA_SECRET'], { encoding: 'utf8' });
  return r.stdout.trim();
}

export const DAY = 86_400_000;
