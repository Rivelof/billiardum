// Тело команды по типу — docs/protocol.md §3.3, шаг 4 проверки.
// Неизвестный тип → `unknown_type`; тело не подходит типу (нет поля, не тот тип значения,
// значение вне диапазона) → `bad_body`. Неизвестные поля тела игнорируются.
//
// Диапазоны — §3.3 v1 («Диапазоны полей тела»). Та же таблица — в прошивке
// (firmware/lib/logic/src/bl_body.cpp), расхождение — дефект.

import { isUuid } from './command.mjs';

export const DAY_MS = 86_400_000;
export const DEFAULT_WARN_MS = Object.freeze([300_000, 60_000]);
export const DEFAULT_GRACE_MS = 120_000;

// Диапазоны §3.3 (включительно).
export const RANGES = Object.freeze({
  remaining_ms: [1, DAY_MS],
  warn_ms_item: [1, 3_600_000],
  grace_ms: [0, 600_000],
  duration_ms: [1, DAY_MS], // service.start, identify
  until_ms: [1, DAY_MS], // state.pending, state.reserved
  led_brightness: [0, 255],
  current_on_ma: [1, 100_000],
  current_confirm_ms: [1, 600_000],
  grace_dim: [0, 100],
  grace_blink_s: [1, 3600],
});

// reason_code — 1…32 символа [a-z0-9_] (§3.3).
export const REASON_CODE = /^[a-z0-9_]{1,32}$/;

const int = ([min, max]) => (v) => Number.isSafeInteger(v) && v >= min && v <= max;
const bool = (v) => typeof v === 'boolean';
const uuid = (v) => isUuid(v);
const text = (v) => typeof v === 'string' && v.length > 0;
const reasonCode = (v) => typeof v === 'string' && REASON_CODE.test(v);
const https = (v) => typeof v === 'string' && /^https:\/\/[^/\s]+(?:\/\S*)?$/.test(v);
const sha256 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const warnMs = (v) => Array.isArray(v) && v.length === 2 && v.every(int(RANGES.warn_ms_item)) && v[0] > v[1];

const req = (check) => ({ check, required: true });
const opt = (check, fallback) => ({ check, required: false, fallback });

const SESSION_START = {
  session_id: req(uuid),
  remaining_ms: req(int(RANGES.remaining_ms)),
  warn_ms: opt(warnMs, DEFAULT_WARN_MS),
  grace_ms: opt(int(RANGES.grace_ms), DEFAULT_GRACE_MS),
  buzzer: req(bool),
};

export const BODY_SPECS = Object.freeze({
  'session.start': SESSION_START,
  'session.resume': SESSION_START,
  'session.extend': { session_id: req(uuid), remaining_ms: req(int(RANGES.remaining_ms)), buzzer: req(bool) },
  'session.stop': { session_id: req(uuid), reason_code: req(reasonCode) },
  'service.start': { duration_ms: req(int(RANGES.duration_ms)), reason_code: req(reasonCode) },
  'service.stop': {},
  'state.reserved': { until_ms: req(int(RANGES.until_ms)) },
  'state.pending': { until_ms: req(int(RANGES.until_ms)) },
  'state.free': {},
  identify: { duration_ms: req(int(RANGES.duration_ms)) },
  // Частичное обновление: отсутствующее поле не меняется.
  'config.set': {
    led_brightness: opt(int(RANGES.led_brightness)),
    current_on_ma: opt(int(RANGES.current_on_ma)),
    current_confirm_ms: opt(int(RANGES.current_confirm_ms)),
    grace_dim: opt(int(RANGES.grace_dim)),
    grace_blink_s: opt(int(RANGES.grace_blink_s)),
  },
  'ota.start': { url: req(https), version: req(text), sha256: req(sha256), image_sig: req(text) },
  ping: {},
});

/**
 * @param {string} type
 * @param {object} body
 * @returns {{ ok: true, body: object } | { ok: false, error: 'unknown_type' | 'bad_body', field?: string }}
 * `body` — только известные поля, с умолчаниями §3.3.
 */
export function validateBody(type, body) {
  if (!Object.hasOwn(BODY_SPECS, type)) return { ok: false, error: 'unknown_type' };
  const out = {};
  for (const [field, spec] of Object.entries(BODY_SPECS[type])) {
    if (!Object.hasOwn(body, field)) {
      if (spec.required) return { ok: false, error: 'bad_body', field };
      if (spec.fallback !== undefined) out[field] = structuredClone(spec.fallback);
      continue;
    }
    if (!spec.check(body[field])) return { ok: false, error: 'bad_body', field };
    out[field] = body[field];
  }
  return { ok: true, body: out };
}
