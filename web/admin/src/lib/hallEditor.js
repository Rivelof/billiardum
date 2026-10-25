import { TABLE_SIZES } from '@billiardum/shared/hall';
import { familyText, resourceName } from '@billiardum/shared/resource';

/**
 * Редактор плана зала (M5.1, №155). Чистые функции без DOM.
 *
 * Координаты — как в bl.resources: центр стола в сантиметрах от левого верхнего угла зала, поворот в градусах
 * по часовой стрелке (0 — длинной стороной вверх). Размер зала — PUT /api/clubs/{club}/hall { width, height } в сантиметрах.
 * Вид стола в API M5.1 — kind: pyramid | pool | snooker | mixed; в старых ответах — type 'billiard_*'.
 *
 * M5.8 (№203, №213): вид 'padel_court' — падел-корт 10 × 20 м (на плане 10,6 × 20,6 м со стенами). Нумерация своя
 * у каждой семьи («Стол 1…», «Корт 1…»), стол и корт друг в друга не превращаются (сервер — 400 bad_request).
 */

export const KINDS = Object.freeze([
  { id: 'pyramid', label: 'Русская пирамида, 12 футов', short: 'пирамида', type: 'billiard_pyramid', family: 'table' },
  { id: 'pool', label: 'Пул, 9 футов', short: 'пул', type: 'billiard_pool', family: 'table' },
  { id: 'snooker', label: 'Снукер, 12 футов', short: 'снукер', type: 'billiard_snooker', family: 'table' },
  { id: 'mixed', label: 'Стол под пирамиду и пул', short: 'пирамида и пул', type: 'billiard_mixed', family: 'table' },
  { id: 'padel_court', label: 'Падел-корт, 10 × 20 м', short: 'падел-корт', type: 'padel_court', family: 'court' },
]);
const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));
export const COURT_KIND = 'padel_court';

/** Семья вида мастера: 'table' | 'court'. */
export const familyOfKind = (kind) => KIND[kind]?.family ?? 'table';
/** Виды одной семьи — в выборе вида у существующего ресурса (стол не становится кортом). */
export const kindsOfFamily = (family) => KINDS.filter((k) => k.family === family);
/** Смена вида уводит в другую семью — сервер ответит 400 bad_request (№213). */
export const familyChange = (before, after) => Boolean(before?.kind && after?.kind) && familyOfKind(before.kind) !== familyOfKind(after.kind);

export const DEFAULT_HALL = Object.freeze({ width: 1800, height: 1200 });
export const HALL_MIN_M = 3;
export const HALL_MAX_M = 100;
export const SNAP_CM = 10;

/** Вид стола ресурса: kind из API M5.1, иначе по type. */
export function kindOf(resource) {
  if (KIND[resource?.kind]) return resource.kind;
  const t = String(resource?.type ?? '');
  if (/padel/i.test(t) || resource?.family === 'court') return COURT_KIND;
  if (/pool/i.test(t)) return 'pool';
  if (/snooker/i.test(t)) return 'snooker';
  if (/mixed/i.test(t)) return 'mixed';
  return 'pyramid';
}

export const kindLabel = (kind) => KIND[kind]?.label ?? KIND.pyramid.label;
/** Рисунок: пул короче, остальные столы — 12 футов, корт — свой рисунок 10,6 × 20,6 м. */
export const artKind = (kind) => (kind === COURT_KIND ? 'court' : kind === 'pool' ? 'pool' : 'pyramid');

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

/** Следующий свободный номер в семье (№213: «Стол 1…» и «Корт 1…» нумеруются отдельно). */
export function nextNumber(tables, family = 'table') {
  const used = new Set(tables.filter((t) => familyOfKind(t.kind) === family).map((t) => t.number));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

/** Номер: целое 1…999, не занятое другим ресурсом той же семьи. Ошибка словами или null. */
export function numberError(value, tables, selfId = null, family = 'table') {
  const n = Number(String(value ?? '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 999) return 'Номер — целое число от 1 до 999.';
  if (tables.some((t) => t.number === n && t.id !== selfId && familyOfKind(t.kind) === family)) return `${resourceName(family, n)} уже есть. Выберите другой номер.`;
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

/** Ресурс вида не помещается в зал целиком (корт 10,6 × 20,6 м в зале 18 × 14 м) — ни так, ни повёрнутым. */
export function fitsHall(kind, hall) {
  const a = footprint(kind, 0);
  const b = footprint(kind, 90);
  return (a.w <= hall.width && a.h <= hall.height) || (b.w <= hall.width && b.h <= hall.height);
}

/** Поворот, при котором ресурс помещается в зал: корт в широком зале — поперёк. */
export function fitRotation(kind, hall) {
  const a = footprint(kind, 0);
  return a.w <= hall.width && a.h <= hall.height ? 0 : fitsHall(kind, hall) ? 90 : 0;
}

/** Сантиметры → «4,5 м». */
export function metres(cm) {
  const m = Math.round(Number(cm) / 10) / 10;
  return `${String(m).replace('.', ',')} м`;
}

/**
 * Столы плана: список столов (GET /api/clubs/{club}/resources → resources, только в работе) или ответ зала
 * (GET …/hall, элементы { resource, status }). statuses — состояние столов из зала по id, чтобы показать игру.
 */
export function planTables(list, statuses = null) {
  return (list ?? [])
    .map((h) => (h.resource ? { ...h.resource, status: h.status } : h))
    .filter((r) => r.active !== false)
    .map((r) => {
      const status = statuses?.get(r.id) ?? r.status ?? null;
      const kind = kindOf(r);
      return {
        id: r.id,
        number: r.number,
        kind,
        family: familyOfKind(kind),
        type: r.type,
        code: r.code ?? null,
        plan_x: Number(r.plan_x ?? r.plan?.x ?? 0) || 0,
        plan_y: Number(r.plan_y ?? r.plan?.y ?? 0) || 0,
        plan_rotation: normRotation(r.plan_rotation ?? r.plan?.rotation ?? 0),
        busy: ['busy', 'pending'].includes(status),
        lit: status === 'busy',
      };
    })
    // Столы, затем корты (как у сервера), внутри — по номеру
    .sort((a, b) => Number(a.family === 'court') - Number(b.family === 'court') || a.number - b.number);
}

/** Размер зала из ответа: { plan: { width_cm, height_cm } } (GET …/resources, PUT …/hall) или { width, height }. */
export function hallSize(res) {
  const p = res?.plan ?? res;
  const w = Number(p?.width_cm ?? p?.width);
  const h = Number(p?.height_cm ?? p?.height);
  return w > 0 && h > 0 ? { width: Math.round(w), height: Math.round(h) } : null;
}

/** 409 table_busy { reason } при выводе стола (корта) из работы — что мешает словами. */
export function retireBusyText(reason, number, family = 'table') {
  return familyText(retireTableText(reason, number), family);
}

function retireTableText(reason, number) {
  const t = `Стол ${number}`;
  switch (reason) {
    case 'session':
      return `${t}: идёт игра. Вывести стол можно после неё.`;
    case 'pending':
      return `${t}: гость сейчас оплачивает игру. Попробуйте через несколько минут.`;
    case 'reserved':
      return `${t} удерживается за гостем. Вывести стол можно, когда удержание закончится.`;
    case 'service':
      return `${t} на обслуживании. Сначала выключите сервисный свет.`;
    case 'booking':
      return `У стола ${number} есть бронь впереди. Сначала отмените её на экране «Брони».`;
    case 'tournament':
      return `Стол ${number} занят турниром. Вывести его можно после турнира.`;
    default:
      return `${t} сейчас занят. Вывести его можно, когда он освободится.`;
  }
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

/** Подпись стола (корта) на плане для экранного диктора. */
export function tableAria(t) {
  const turn = normRotation(t.plan_rotation);
  return `${resourceName(familyOfKind(t.kind), t.number)}, ${KIND[t.kind]?.short ?? 'пирамида'}. ${metres(t.plan_x)} от левой стены, ${metres(t.plan_y)} от верхней${turn ? `, повёрнут на ${turn}°` : ''}.`;
}

/**
 * Сохранение столов плана (Д2 M5.1): стрелки и R копятся и уходят одним PATCH через delay мс после последней
 * клавиши, конец перетаскивания — сразу. Стол берётся через get(id) в момент сохранения — из актуального
 * состояния редактора, а не из отрисовки, в которой нажали клавишу (иначе тело PATCH пустое).
 * Несколько столов подряд — сохраняется каждый.
 * @param {{ get: (id: string) => object | null, save: (t: object) => unknown, delay?: number, timers?: { setTimeout: Function, clearTimeout: Function } }} o
 */
export function planSaver({ get, save, delay = 600, timers = globalThis }) {
  const pending = new Set();
  let timer = null;
  const flush = () => {
    timers.clearTimeout(timer);
    timer = null;
    const ids = [...pending];
    pending.clear();
    for (const id of ids) {
      const t = get(id);
      if (t) save(t);
    }
  };
  return {
    /** Клавиша: сохранить стол позже, после паузы. */
    later(id) {
      pending.add(id);
      timers.clearTimeout(timer);
      timer = timers.setTimeout(flush, delay);
    },
    /** Конец перетаскивания: сохранить стол сразу (и всё, что ждало). */
    now(id) {
      pending.add(id);
      flush();
    },
    flush,
    /** Уход с экрана: отложенное не теряем. */
    dispose: flush,
  };
}

/**
 * №164: смена типа стола в боевом режиме — ручное действие (при тарифах по типам она меняет цену стола):
 * нужна причина, владельцу — уведомление. Позиция, поворот и номер — только журнал.
 */
export const kindNeedsReason = (before, after, live) => Boolean(live) && Boolean(after?.kind) && after.kind !== before?.kind;

/** Тело POST /api/clubs/{club}/resources; в live — с причиной (manual.resource_add). */
export const resourceBody = (t, reason = null) => ({
  number: t.number,
  kind: t.kind,
  plan_x: t.plan_x,
  plan_y: t.plan_y,
  plan_rotation: normRotation(t.plan_rotation),
  ...(reason && reason.trim() ? { reason: reason.trim() } : {}),
});

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
