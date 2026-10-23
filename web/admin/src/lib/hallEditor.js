import { TABLE_SIZES } from '@billiardum/shared/hall';

/**
 * Редактор плана зала (M5.1, №155). Чистые функции без DOM.
 *
 * Координаты — как в bl.resources: центр стола в сантиметрах от левого верхнего угла зала, поворот в градусах
 * по часовой стрелке (0 — длинной стороной вверх). Размер зала — PUT /api/clubs/{club}/hall { width, height } в сантиметрах.
 * Вид стола в API M5.1 — kind: pyramid | pool | snooker | mixed; в старых ответах — type 'billiard_*'.
 */

export const KINDS = Object.freeze([
  { id: 'pyramid', label: 'Русская пирамида, 12 футов', short: 'пирамида', type: 'billiard_pyramid' },
  { id: 'pool', label: 'Пул, 9 футов', short: 'пул', type: 'billiard_pool' },
  { id: 'snooker', label: 'Снукер, 12 футов', short: 'снукер', type: 'billiard_snooker' },
  { id: 'mixed', label: 'Стол под пирамиду и пул', short: 'пирамида и пул', type: 'billiard_pyramid' },
]);
const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));

export const DEFAULT_HALL = Object.freeze({ width: 1800, height: 1200 });
export const HALL_MIN_M = 3;
export const HALL_MAX_M = 100;
export const SNAP_CM = 10;

/** Вид стола ресурса: kind из API M5.1, иначе по type. */
export function kindOf(resource) {
  if (KIND[resource?.kind]) return resource.kind;
  const t = String(resource?.type ?? '');
  if (/pool/i.test(t)) return 'pool';
  if (/snooker/i.test(t)) return 'snooker';
  return 'pyramid';
}

export const kindLabel = (kind) => KIND[kind]?.label ?? KIND.pyramid.label;
/** Рисунок стола: пул короче, остальные — 12 футов. */
export const artKind = (kind) => (kind === 'pool' ? 'pool' : 'pyramid');

/** Поворот к 0…359. */
export const normRotation = (deg) => ((Math.round(Number(deg) || 0) % 360) + 360) % 360;

/** Габарит стола на плане в сантиметрах с учётом поворота (под углом — описанный прямоугольник). */
export function footprint(kind, rotation = 0) {
  const s = TABLE_SIZES[artKind(kind)];
  const w = s.outerShort / 10;
  const h = s.outerLong / 10;
  const a = (normRotation(rotation) * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const si = Math.abs(Math.sin(a));
  return { w: Math.round(w * c + h * si), h: Math.round(w * si + h * c) };
}

const snap = (v, step = SNAP_CM) => Math.round(v / step) * step;

/** Центр стола внутри зала: стол целиком в стенах; зал меньше стола — по середине. */
export function clampCenter(x, y, kind, rotation, hall) {
  const f = footprint(kind, rotation);
  const fit = (v, size, total) => (size >= total ? Math.round(total / 2) : Math.min(total - size / 2, Math.max(size / 2, v)));
  return { x: Math.round(fit(x, f.w, hall.width)), y: Math.round(fit(y, f.h, hall.height)) };
}

/** Сдвиг стола (клавиши-стрелки, перетаскивание): шаг 10 см и стены зала. */
export function moveTable(t, dx, dy, hall) {
  const kind = kindOf(t);
  const p = clampCenter(snap(t.plan_x + dx), snap(t.plan_y + dy), kind, t.plan_rotation, hall);
  return { ...t, plan_x: p.x, plan_y: p.y };
}

/** Поворот на delta градусов; после поворота стол возвращается в стены. */
export function rotateTable(t, delta, hall) {
  const plan_rotation = normRotation((t.plan_rotation ?? 0) + delta);
  const p = clampCenter(t.plan_x, t.plan_y, kindOf(t), plan_rotation, hall);
  return { ...t, plan_rotation, plan_x: p.x, plan_y: p.y };
}

/** Пиксели экрана → сантиметры плана: план шириной rectWidth px показывает зал hall.width см. */
export const pxToCm = (px, rectWidth, hall) => (rectWidth > 0 ? (px * hall.width) / rectWidth : 0);

const overlaps = (a, b, gap) => Math.abs(a.x - b.x) * 2 < a.w + b.w + gap * 2 && Math.abs(a.y - b.y) * 2 < a.h + b.h + gap * 2; // gap — проход между краями столов

/**
 * Место для нового стола: обходим зал сеткой 50 см сверху слева (метр от стен) и берём первую точку, где стол
 * с проходом 120 см никого не задевает. Места нет — середина зала (владелец передвинет сам).
 */
export function nextSpot(tables, hall, kind = 'pyramid', rotation = 0) {
  const f = footprint(kind, rotation);
  const placed = tables.map((t) => ({ x: t.plan_x, y: t.plan_y, ...footprint(kindOf(t), t.plan_rotation) }));
  // От стен — проход не меньше метра, если зал позволяет
  const wall = (size, total) => (total - size >= 300 ? 100 : 0);
  const wx = wall(f.w, hall.width);
  const wy = wall(f.h, hall.height);
  for (let y = Math.ceil((f.h / 2 + wy) / 50) * 50; y + f.h / 2 + wy <= hall.height; y += 50) {
    for (let x = Math.ceil((f.w / 2 + wx) / 50) * 50; x + f.w / 2 + wx <= hall.width; x += 50) {
      const me = { x, y, ...f };
      if (!placed.some((p) => overlaps(me, p, 120))) return { x, y };
    }
  }
  return clampCenter(hall.width / 2, hall.height / 2, kind, rotation, hall);
}

/** Следующий свободный номер стола. */
export function nextNumber(tables) {
  const used = new Set(tables.map((t) => t.number));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

/** Номер стола: целое 1…999, не занятое другим столом. Ошибка словами или null. */
export function numberError(value, tables, selfId = null) {
  const n = Number(String(value ?? '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 999) return 'Номер — целое число от 1 до 999.';
  if (tables.some((t) => t.number === n && t.id !== selfId)) return `Стол ${n} уже есть. Выберите другой номер.`;
  return null;
}

/** Размер зала в метрах из полей → сантиметры и ошибки. */
export function hallFromMetres(widthM, heightM) {
  const parse = (v) => {
    const n = Number(String(v ?? '').replace(',', '.').trim());
    return Number.isFinite(n) ? n : null;
  };
  const w = parse(widthM);
  const h = parse(heightM);
  const errors = {};
  const bad = (v) => v === null || v < HALL_MIN_M || v > HALL_MAX_M;
  if (bad(w)) errors.width = `Ширина — от ${HALL_MIN_M} до ${HALL_MAX_M} м.`;
  if (bad(h)) errors.height = `Длина — от ${HALL_MIN_M} до ${HALL_MAX_M} м.`;
  return { hall: Object.keys(errors).length ? null : { width: Math.round(w * 100), height: Math.round(h * 100) }, errors };
}

/** Сантиметры → «4,5 м». */
export function metres(cm) {
  const m = Math.round(Number(cm) / 10) / 10;
  return `${String(m).replace('.', ',')} м`;
}

/** Столы плана из ответа зала (GET /api/clubs/{club}/hall): только поля редактора. */
export function planTables(hall) {
  return (hall ?? [])
    .map((h) => ({
      id: h.resource.id,
      number: h.resource.number,
      kind: kindOf(h.resource),
      type: h.resource.type,
      code: h.resource.code ?? null,
      plan_x: Number(h.resource.plan_x ?? h.resource.plan?.x ?? 0) || 0,
      plan_y: Number(h.resource.plan_y ?? h.resource.plan?.y ?? 0) || 0,
      plan_rotation: normRotation(h.resource.plan_rotation ?? h.resource.plan?.rotation ?? 0),
      busy: ['busy', 'pending'].includes(h.status),
      lit: h.status === 'busy',
      device: h.device ?? null,
    }))
    .sort((a, b) => a.number - b.number);
}

/**
 * Столы без позиции (старые клубы: всё в 0,0) — раскладываем рядами, чтобы на плане их было видно.
 * Только для показа: на сервер уйдёт позиция, когда владелец сдвинет стол.
 */
export function placeUnset(tables, hall) {
  const out = [];
  for (const t of tables) {
    if (t.plan_x > 0 || t.plan_y > 0) out.push(t);
    else {
      const p = nextSpot(out, hall, t.kind, t.plan_rotation);
      out.push({ ...t, plan_x: p.x, plan_y: p.y, unset: true });
    }
  }
  return out;
}

/** Подпись стола на плане для экранного диктора. */
export function tableAria(t) {
  const turn = normRotation(t.plan_rotation);
  return `Стол ${t.number}, ${KIND[t.kind]?.short ?? 'пирамида'}. ${metres(t.plan_x)} от левой стены, ${metres(t.plan_y)} от верхней${turn ? `, повёрнут на ${turn}°` : ''}.`;
}

/** Тело POST /api/clubs/{club}/resources. */
export const resourceBody = (t) => ({ number: t.number, kind: t.kind, plan_x: t.plan_x, plan_y: t.plan_y, plan_rotation: normRotation(t.plan_rotation) });

/**
 * Тело PATCH …/resources/{id}: только изменённые поля; вывод из работы — active: false и причина
 * (в боевом режиме причина обязательна, №155).
 */
export function resourcePatch(before, after, { reason } = {}) {
  const body = {};
  for (const k of ['number', 'kind', 'plan_x', 'plan_y', 'plan_rotation']) if (after[k] !== undefined && after[k] !== before[k]) body[k] = after[k];
  if (after.active === false) body.active = false;
  if (reason && reason.trim()) body.reason = reason.trim();
  return body;
}
