// Мастер тарифов (M5.1 №156, backend-B): шаблоны, проверка недели, сохранение правил.
//
//   GET /api/tariff-templates               → { templates } — 5 шаблонов, цены — параметры
//   GET /api/clubs/{club}/tariffs           → { timezone, day_start_local, rules, coverage }
//   PUT /api/clubs/{club}/tariffs {rules, reason?} → то же, что GET
//
// Правило мастера: { kind?: 'pyramid'|'pool'|'snooker'|'mixed'|null (null — все типы столов)
//   или resource_type: 'billiard_pyramid'…, days: [1..7] (ISO, 1 — пн), from|start_local: 'HH:MM',
//   to|end_local: 'HH:MM' ('24:00' и from = to — до того же времени следующих суток),
//   price_per_hour_kopecks, min_minutes (0–1440), step_minutes (1–60) }. Неделя — все 24 часа.
//   В ответе правило несёт оба набора полей: kind и resource_type, from/to и start_local/end_local.
//
// Неделя проверяется так же, как её считает движок (server/tariffs/engine.mjs, №43): по рабочим
// суткам клуба в его часовом поясе (сутки начинаются в day_start_local, по умолчанию 06:00;
// интервал, пересекающий начало суток, принадлежит суткам, в которых начался). Для каждого типа
// столов (в работе или упомянутого в правилах) каждая минута недели — ровно одно правило:
//   нет правила   → 400 tariff_gap     {kind, weekday, from, to}
//   два и больше  → 400 tariff_overlap {kind, weekday, from, to}
// weekday — день рабочих суток (ночь с пятницы на субботу до 06:00 — пятница), from/to — местное время.
//
// Сохранение заменяет все правила клуба: прежние гаснут (active = false, история остаётся),
// новые вставляются по одному на тип столов. Режим test — журнал tariff.update; live — ручное
// действие manual.tariff_change: причина обязательна, тревога владельцу (инвариант 8).

import { plural } from '@billiardum/shared/format';
import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { clubTariffSettings } from '../tariffs/index.mjs';
import { formatLocalTime, parseLocalTime } from '../tariffs/engine.mjs';
import { KIND_OF_TYPE, KINDS } from './hall.mjs';
import { cleanReason, clubMode, isLive, manualAction } from './mode.mjs';

const DAY = 1440;
const WEEK = 7 * DAY;
export const MAX_RULES = 100;
export const MAX_PRICE_KOPECKS = 100_000_000;
const ALL_KINDS = Object.keys(KINDS);
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const bad = (detail) => new HttpError(400, 'bad_request', { detail });

// Шаблоны -------------------------------------------------------------------------------------

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 7];
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/**
 * Пять шаблонов мастера (№156). Границы — от начала рабочих суток 06:00: ночь до 06:00 относится
 * к прошедшему дню (№43), поэтому «выходные» — с субботы 06:00 до понедельника 06:00.
 * В правиле price — ключ параметра; min_minutes и step_minutes — значения по умолчанию,
 * мастер меняет их вместе с ценами.
 */
export const TEMPLATES = Object.freeze([
  {
    id: 'single',
    title: 'Одна цена',
    description: 'Одна цена часа круглосуточно все дни',
    params: [{ key: 'price', title: 'Цена часа' }],
    rules: [{ days: ALL_DAYS, from: '06:00', to: '06:00', price: 'price' }],
  },
  {
    id: 'weekdays_weekend',
    title: 'Будни и выходные',
    description: 'Своя цена в будни и в выходные; ночь с пятницы на субботу — будняя',
    params: [
      { key: 'weekday', title: 'Будни' },
      { key: 'weekend', title: 'Выходные' },
    ],
    rules: [
      { days: WEEKDAYS, from: '06:00', to: '06:00', price: 'weekday' },
      { days: WEEKEND, from: '06:00', to: '06:00', price: 'weekend' },
    ],
  },
  {
    id: 'day_evening',
    title: 'День и вечер',
    description: 'День 06:00–18:00, вечер и ночь 18:00–06:00',
    params: [
      { key: 'day', title: 'День' },
      { key: 'evening', title: 'Вечер' },
    ],
    rules: [
      { days: ALL_DAYS, from: '06:00', to: '18:00', price: 'day' },
      { days: ALL_DAYS, from: '18:00', to: '06:00', price: 'evening' },
    ],
  },
  {
    id: 'day_evening_night',
    title: 'День, вечер, ночь',
    description: 'День 06:00–17:00, вечер 17:00–00:00, ночь 00:00–06:00',
    params: [
      { key: 'day', title: 'День' },
      { key: 'evening', title: 'Вечер' },
      { key: 'night', title: 'Ночь' },
    ],
    rules: [
      { days: ALL_DAYS, from: '06:00', to: '17:00', price: 'day' },
      { days: ALL_DAYS, from: '17:00', to: '00:00', price: 'evening' },
      { days: ALL_DAYS, from: '00:00', to: '06:00', price: 'night' },
    ],
  },
  {
    id: 'weekdays_weekend_day_evening',
    title: 'Будни и выходные × день и вечер',
    description: 'Четыре цены: будни и выходные, день 06:00–18:00 и вечер 18:00–06:00',
    params: [
      { key: 'weekday_day', title: 'Будни, день' },
      { key: 'weekday_evening', title: 'Будни, вечер' },
      { key: 'weekend_day', title: 'Выходные, день' },
      { key: 'weekend_evening', title: 'Выходные, вечер' },
    ],
    rules: [
      { days: WEEKDAYS, from: '06:00', to: '18:00', price: 'weekday_day' },
      { days: WEEKDAYS, from: '18:00', to: '06:00', price: 'weekday_evening' },
      { days: WEEKEND, from: '06:00', to: '18:00', price: 'weekend_day' },
      { days: WEEKEND, from: '18:00', to: '06:00', price: 'weekend_evening' },
    ],
  },
]);

export const TEMPLATE_DEFAULTS = Object.freeze({ min_minutes: 30, step_minutes: 1 });

/** Ответ GET /api/tariff-templates. */
export function templatesJson() {
  return { defaults: { ...TEMPLATE_DEFAULTS }, templates: TEMPLATES.map((t) => ({ ...t, rules: t.rules.map((r) => ({ ...r, days: [...r.days] })) })) };
}

/**
 * Правила шаблона с ценами: prices — { ключ: копейки }; kind — тип столов (null — все).
 * Удобно мастеру и тестам; сервер всё равно проверяет итоговые правила.
 */
export function applyTemplate(id, prices, { kind = null, min_minutes: min = TEMPLATE_DEFAULTS.min_minutes, step_minutes: step = TEMPLATE_DEFAULTS.step_minutes } = {}) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`шаблон ${id}`);
  return t.rules.map((r) => ({ kind, days: [...r.days], from: r.from, to: r.to, price_per_hour_kopecks: prices[r.price], min_minutes: min, step_minutes: step }));
}

// Проверка ------------------------------------------------------------------------------------

/** Минута 'HH:MM' (24:00 → 0). */
const minuteOf = (hhmm) => parseLocalTime(hhmm);

/** Разбор правил из тела запроса → нормализованные правила; ошибка формы — 400 bad_request. */
export function normalizeRules(input) {
  if (!Array.isArray(input) || input.length === 0) throw bad('rules');
  if (input.length > MAX_RULES) throw bad('rules: too many');
  return input.map((r, i) => {
    const where = `rules[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad(where);
    // Тип: kind ('pyramid'…) или resource_type как в базе ('billiard_pyramid'…); нет — все типы.
    const rawKind = r.kind !== undefined ? r.kind : r.resource_type;
    const kind = rawKind === undefined || rawKind === null || rawKind === 'all' ? null : (KIND_OF_TYPE[rawKind] ?? rawKind);
    if (kind !== null && !ALL_KINDS.includes(kind)) throw bad(`${where}.kind`);
    if (!Array.isArray(r.days) || r.days.length === 0 || r.days.length > 7) throw bad(`${where}.days`);
    const days = [...new Set(r.days)];
    if (days.length !== r.days.length || !days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) throw bad(`${where}.days`);
    days.sort((a, b) => a - b);
    // Время: from/to или start_local/end_local (как столбцы базы), 'HH:MM' или 'HH:MM:00'.
    const fromText = typeof (r.from ?? r.start_local) === 'string' ? (r.from ?? r.start_local).replace(/^(\d{2}:\d{2}):00$/, '$1') : null;
    const toText = typeof (r.to ?? r.end_local) === 'string' ? (r.to ?? r.end_local).replace(/^(\d{2}:\d{2}):00$/, '$1') : null;
    if (!fromText || !HHMM.test(fromText)) throw bad(`${where}.from`);
    if (!toText || !HHMM.test(toText)) throw bad(`${where}.to`);
    const price = r.price_per_hour_kopecks;
    // №163: цена строго больше нуля — бесплатная игра только ручным действием (инвариант 8), не тарифом 0 ₽.
    if (!Number.isSafeInteger(price) || price > MAX_PRICE_KOPECKS) throw bad(`${where}.price_per_hour_kopecks`);
    if (price <= 0) throw bad(`${where}.price_per_hour_kopecks: must be > 0`);
    if (!Number.isInteger(r.min_minutes) || r.min_minutes < 0 || r.min_minutes > DAY) throw bad(`${where}.min_minutes`);
    if (!Number.isInteger(r.step_minutes) || r.step_minutes < 1 || r.step_minutes > 60) throw bad(`${where}.step_minutes`);
    const from = minuteOf(fromText);
    const to = minuteOf(toText);
    return {
      kind,
      days,
      from: formatLocalTime(from),
      to: formatLocalTime(to),
      startMin: from,
      len: (to - from + DAY) % DAY || DAY,
      price_per_hour_kopecks: price,
      min_minutes: r.min_minutes,
      step_minutes: r.step_minutes,
    };
  });
}

/**
 * Покрытие недели одним набором правил (одного типа столов), минуты рабочих суток.
 * rules — [{ days, startMin, len }]; dayStart — минута начала рабочих суток.
 * @returns {{ type: 'gap'|'overlap', weekday: number, from: string, to: string } | null}
 *   первая проблема: пересечения важнее дыр.
 */
export function weekProblem(rules, dayStart) {
  const count = new Uint8Array(WEEK);
  for (const r of rules) {
    const offset = (r.startMin - dayStart + DAY) % DAY;
    for (const d of r.days) {
      const base = (d - 1) * DAY + offset;
      for (let m = 0; m < r.len; m += 1) {
        const i = (base + m) % WEEK;
        if (count[i] < 255) count[i] += 1;
      }
    }
  }
  const find = (test) => {
    const i = count.findIndex(test);
    if (i < 0) return null;
    const day = Math.floor(i / DAY);
    let j = i;
    while (j < (day + 1) * DAY && test(count[j])) j += 1;
    const local = (slot) => (slot - day * DAY + dayStart) % DAY;
    // Конец ровно в полночь рабочих суток после полуночи часов — '24:00' только когда сутки с 00:00.
    const to = local(j);
    return { weekday: day + 1, from: formatLocalTime(local(i)), to: to === 0 && j > i ? '24:00' : formatLocalTime(to) };
  };
  const overlap = find((c) => c > 1);
  if (overlap) return { type: 'overlap', ...overlap };
  const gap = find((c) => c === 0);
  if (gap) return { type: 'gap', ...gap };
  return null;
}

/**
 * Проверка правил мастера для клуба: по каждому типу столов из правил и из столов в работе.
 * @param {ReturnType<typeof normalizeRules>} rules
 * @param {{ dayStart: string, activeKinds: string[] }} club
 * @returns {null | { type, kind, weekday, from, to }}
 */
export function checkWeek(rules, { dayStart, activeKinds }) {
  const start = minuteOf(dayStart);
  const kinds = new Set(activeKinds);
  for (const r of rules) {
    if (r.kind) kinds.add(r.kind);
  }
  // Правила «для всех типов» без единого стола — проверяются как один набор.
  if (kinds.size === 0) kinds.add(null);
  for (const kind of ALL_KINDS.filter((k) => kinds.has(k)).concat(kinds.has(null) ? [null] : [])) {
    const set = rules.filter((r) => r.kind === null || r.kind === kind);
    const p = weekProblem(set, start);
    if (p) return { ...p, kind };
  }
  return null;
}

// База ------------------------------------------------------------------------------------------

async function clubRow(db, clubId) {
  const { rows } = await db.query('select timezone, settings from bl.clubs where id = $1', [clubId]);
  if (rows.length === 0) throw new HttpError(404, 'not_found');
  return rows[0];
}

async function activeKindsOf(db, clubId) {
  const { rows } = await db.query('select distinct type from bl.resources where club_id = $1 and active', [clubId]);
  return rows.map((r) => KIND_OF_TYPE[r.type]).filter(Boolean);
}

const hhmm = (t) => String(t).slice(0, 5);

/** Правила клуба из базы в виде мастера; одинаковые правила всех четырёх типов — одним kind: null. */
async function loadRules(db, clubId) {
  const { rows } = await db.query(
    `select id, resource_type, resource_id, days, start_local::text as start_local, end_local::text as end_local,
            price_per_hour, step_minutes, min_minutes
       from bl.tariff_rules where club_id = $1 and active
      order by resource_id nulls first, days[1], start_local, resource_type`,
    [clubId],
  );
  const list = rows.map((r) => ({
    kind: r.resource_type ? (KIND_OF_TYPE[r.resource_type] ?? null) : null,
    resource_type: r.resource_type ?? null,
    resource_id: r.resource_id,
    days: r.days.map(Number),
    from: hhmm(r.start_local),
    to: hhmm(r.end_local),
    price_per_hour_kopecks: Number(r.price_per_hour),
    min_minutes: r.min_minutes,
    step_minutes: r.step_minutes,
  }));
  const typed = list.filter((r) => !r.resource_id);
  const key = (r) => JSON.stringify([r.days, r.from, r.to, r.price_per_hour_kopecks, r.min_minutes, r.step_minutes]);
  const groups = new Map();
  for (const r of typed) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const g of groups.values()) {
    const kinds = new Set(g.map((r) => r.kind));
    if (ALL_KINDS.every((k) => kinds.has(k)) && g.length === ALL_KINDS.length) {
      const { kind: _k, resource_type: _t, resource_id: _r, ...rest } = g[0];
      out.push({ kind: null, resource_type: null, ...rest });
    } else {
      for (const r of g) {
        const { resource_id: _r, ...rest } = r;
        out.push(rest);
      }
    }
  }
  const specific = list.filter((r) => r.resource_id).map(({ kind: _k, resource_type: _t, ...rest }) => rest);
  // Поля как у столбцов базы (start_local, end_local) — для мастера frontend; from/to — то же.
  const withDb = (r) => ({ ...r, start_local: r.from, end_local: r.to });
  return { rules: out.map(withDb), resourceRules: specific.map(withDb), raw: rows };
}

/**
 * Покрытие недели правилами клуба в базе: для каждого стола в работе — его правила и правила его типа
 * (как в движке). Нет столов — правила по типам, что есть. Нет правил — не покрыто.
 * @returns {Promise<{ ok: boolean, problem: null | { type, kind, weekday, from, to, resource_id? } }>}
 */
export async function weekCoverage(db, clubId) {
  const club = await clubRow(db, clubId);
  const { dayStart } = clubTariffSettings(club.settings);
  const start = minuteOf(dayStart);
  const { raw } = await loadRules(db, clubId);
  if (raw.length === 0) return { ok: false, problem: { type: 'gap', kind: null, weekday: 1, from: dayStart, to: dayStart } };
  const toRule = (r) => {
    const s = minuteOf(hhmm(r.start_local));
    const e = minuteOf(hhmm(r.end_local));
    return { days: r.days.map(Number), startMin: s, len: (e - s + DAY) % DAY || DAY };
  };
  const tables = (await db.query('select id, type from bl.resources where club_id = $1 and active order by number', [clubId])).rows;
  const units = tables.length
    ? tables.map((t) => ({ kind: KIND_OF_TYPE[t.type] ?? null, resource_id: t.id, rules: raw.filter((r) => r.resource_id === t.id || r.resource_type === t.type) }))
    : [...new Set(raw.filter((r) => r.resource_type).map((r) => r.resource_type))].map((type) => ({
        kind: KIND_OF_TYPE[type] ?? null,
        resource_id: null,
        rules: raw.filter((r) => r.resource_type === type),
      }));
  for (const u of units) {
    // Свои правила стола главнее правил типа (движок): дыра — только там, где нет ни тех, ни других.
    const p = weekProblem(u.rules.map(toRule), start);
    if (p && p.type === 'gap') return { ok: false, problem: { ...p, kind: u.kind, ...(u.resource_id ? { resource_id: u.resource_id } : {}) } };
  }
  return { ok: true, problem: null };
}

/** Тарифы покрывают неделю (чек-лист №160 п. 3). db — в контексте клуба. */
export async function coversWeek(db, clubId) {
  return (await weekCoverage(db, clubId)).ok;
}

/** GET …/tariffs. */
export async function getTariffs(db, { clubId }) {
  const club = await clubRow(db, clubId);
  const { dayStart } = clubTariffSettings(club.settings);
  const { rules, resourceRules } = await loadRules(db, clubId);
  const coverage = await weekCoverage(db, clubId);
  return { timezone: club.timezone, day_start_local: dayStart, rules, resource_rules: resourceRules, coverage };
}

/**
 * PUT …/tariffs {rules, reason?}.
 * @param {{ clubId: string, userId: string, body: object, now: Date, ctx?: object, log?: object }} p
 */
export async function saveTariffs(db, { clubId, userId, body, now, ctx = null, log }) {
  const rules = normalizeRules(body?.rules);
  const club = await clubRow(db, clubId);
  const { dayStart } = clubTariffSettings(club.settings);
  // Правила клуба меняет один запрос за раз.
  await db.query("select pg_advisory_xact_lock(hashtextextended('bl.setup.tariffs:' || $1, 0))", [clubId]);
  const problem = checkWeek(rules, { dayStart, activeKinds: await activeKindsOf(db, clubId) });
  if (problem) {
    const { type, ...data } = problem;
    if (data.kind === null) delete data.kind;
    throw new HttpError(400, type === 'overlap' ? 'tariff_overlap' : 'tariff_gap', { detail: JSON.stringify(problem), data });
  }
  const mode = await clubMode(db, clubId, ctx);
  const reason = isLive(mode) ? cleanReason(body?.reason) : null;
  const before = await loadRules(db, clubId);
  await db.query('update bl.tariff_rules set active = false where club_id = $1 and active', [clubId]);
  for (const r of rules) {
    for (const kind of r.kind ? [r.kind] : ALL_KINDS) {
      await db.query(
        `insert into bl.tariff_rules (club_id, resource_type, days, start_local, end_local, price_per_hour, step_minutes, min_minutes, priority, created_at)
         values ($1, $2, $3::smallint[], $4::time, $5::time, $6, $7, $8, 0, $9)`,
        [clubId, KINDS[kind], r.days, r.from, r.to, r.price_per_hour_kopecks, r.step_minutes, r.min_minutes, now],
      );
    }
  }
  const compact = (list) => list.map((r) => ({ kind: r.kind, days: r.days, from: r.from, to: r.to, price: r.price_per_hour_kopecks, min: r.min_minutes, step: r.step_minutes }));
  const data = { mode, before: compact(before.rules), before_resource_rules: before.resourceRules.length, after: compact(rules) };
  if (isLive(mode)) {
    await manualAction(db, {
      clubId,
      userId,
      action: 'manual.tariff_change',
      reason,
      objectType: 'club',
      objectId: clubId,
      data,
      text: `Изменён тариф клуба (${rules.length} ${plural(rules.length, ['правило', 'правила', 'правил'])})`,
      log,
      ctx,
    });
  } else {
    await appendAudit(db, { action: 'tariff.update', objectType: 'club', objectId: clubId, actorType: 'user', actorId: userId, data });
  }
  return getTariffs(db, { clubId });
}
