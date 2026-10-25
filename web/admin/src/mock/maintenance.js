/*
 * BL_MOCK_MARKER — заглушка M5.6 «Обслуживание столов» (только VITE_MOCK=1), формы — server/maintenance/README.md.
 *
 * Счётчик — часы игры стола с последнего действующего события вида (из синтетики дашборда); до первой отметки — с начала
 * учёта плюс «наработка до программы» (сукно стола 1 и шары стола 4 уже за порогом). События только добавляются:
 * исправление — новая запись с corrects_id и причиной (одна на событие, повтор — 409 duplicate), void — «не было».
 * Стоимость > 0 — расход «Ремонт столов» в кассе управляющего той же датой; исправление сторнирует прежний расход.
 * Ресепшн и бар — 403.
 */

import { addDays, isYmd } from '../lib/period.js';
import { ALL_KINDS, DEFAULT_THRESHOLDS, MAINT_KINDS, MAINT_COST_MAX_BACK_DAYS, MAINT_MAX_BACK_DAYS, THRESHOLD_MAX } from '../lib/maintenance.js';
import { ensureCashbook } from './reports.js';

const MIN = 60_000;
const localIso = (date, minutes) => new Date(Date.parse(`${date}T00:00:00+05:00`) + minutes * MIN).toISOString();
const LABEL = { cloth: 'Замена сукна', balls: 'Замена шаров', cushions: 'Замена резины бортов', leveling: 'Выравнивание', other: 'Другое' };

/** Наработка до начала учёта, ч: стол → вид. */
const BEFORE = {
  1: { cloth: 1050, balls: 1800, cushions: 2600 },
  2: { cloth: 400, balls: 0, cushions: 1200 },
  3: { cloth: 860, balls: 900, cushions: 900 },
  4: { cloth: 300, balls: 2700, cushions: 700 },
  5: { cloth: 0, balls: 1500, cushions: 1500 },
  6: { cloth: 520, balls: 600, cushions: 400 },
  7: { cloth: 210, balls: 300, cushions: 300 },
  8: { cloth: 640, balls: 1100, cushions: 1100 },
};

export function maintenanceState(today, empty) {
  if (empty) return { thresholds: { ...DEFAULT_THRESHOLDS }, events: [] };
  const ev = (n, kind, daysAgo, cost, comment, by, extra = {}) => ({
    event_id: `0e000000-0000-4000-8000-00000000${n}${String(daysAgo).padStart(2, "0")}${ALL_KINDS.indexOf(kind)}`,
    resource_id: `00000000-0000-4000-8000-00000000000${n}`,
    resource_number: n,
    kind,
    date: addDays(today, -daysAgo),
    comment,
    cost_kopecks: cost,
    corrects_id: null,
    corrected_by: null,
    voided: false,
    reason: null,
    cashbook_entry_id: null,
    created_by: by === 'Андрей' ? 'u-owner-0001' : 'u-manager-0002',
    created_by_name: by,
    created_at: localIso(addDays(today, -daysAgo), 15 * 60),
    ...extra,
  });
  return {
    thresholds: { ...DEFAULT_THRESHOLDS },
    events: [
      // Перетяжка сукна стола 5 — та же, что в синтетике дашборда (4 часа сервиса 33 дня назад)
      ev(5, 'cloth', 33, 0, 'Перетяжка сукна мастером, сукно оплачено поставщику отдельно', 'Ольга Р.'),
      ev(2, 'balls', 20, 950000, 'Новый комплект шаров для пирамиды', 'Ольга Р.', { cashbook_entry_id: 'cb000000-0000-4000-8000-0000000000b2' }),
      ev(7, 'leveling', 10, 0, 'Выровняли после перестановки столов', 'Андрей'),
    ],
  };
}

export function maintenanceRoutes({ state, me, err, ok, audit, dash, today, hall }) {
  const S = () => {
    const st = state();
    if (!st.maint) st.maint = maintenanceState(today(), dash().empty);
    return st.maint;
  };
  const allowed = (fn) => (m, b, q) => (!me() ? err(401, 'unauthorized') : ['owner', 'manager'].includes(me().role) ? fn(m, b, q) : err(403, 'forbidden'));
  /** Действующие события: не исправленные и не «не было». */
  const effective = () => {
    const corrected = new Set(S().events.map((e) => e.corrects_id).filter(Boolean));
    return S().events.filter((e) => !corrected.has(e.event_id) && !e.voided);
  };

  function kindsOf(resourceId, number) {
    const out = {};
    const list = effective();
    for (const k of ALL_KINDS) {
      const last = list.filter((e) => e.resource_id === resourceId && e.kind === k).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      // Событие задним числом — со следующих суток (как на сервере); в заглушке — с даты события
      const minutes = Math.round(dash().playMinutesSince(resourceId, last ? addDays(last.date, 1) : null) + (last ? 0 : (BEFORE[number]?.[k] ?? 0) * 60));
      const thr = S().thresholds[k] ?? null;
      const hours = Math.round((minutes / 60) * 10) / 10;
      out[k] = { hours, minutes, since: last ? last.date : null, event_id: last?.event_id ?? null, threshold_hours: thr, due: thr !== null && hours >= thr };
    }
    return out;
  }

  const view = () => {
    const corrected = new Map(S().events.filter((e) => e.corrects_id).map((e) => [e.corrects_id, e.event_id]));
    return {
      thresholds: { ...S().thresholds },
      defaults: { ...DEFAULT_THRESHOLDS },
      kinds: ALL_KINDS.map((k) => ({ kind: k, label: LABEL[k] })),
      counters: hall().map(({ resource: r }) => ({ resource_id: r.id, number: r.number, title: `Стол ${r.number}`, type: r.type, active: true, kinds: kindsOf(r.id, r.number) })),
      events: [...S().events].map((e) => ({ ...e, corrected_by: corrected.get(e.event_id) ?? null })).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    };
  };

  /** Счётчик сукна для таблицы «По столам» дашборда: cloth_hours, cloth_since, cloth_threshold_hours, cloth_due. */
  function cloth(resourceId) {
    const r = hall().find((x) => x.resource.id === resourceId)?.resource;
    if (!r) return null;
    const c = kindsOf(r.id, r.number).cloth;
    return { cloth_hours: c.hours, cloth_since: c.since, cloth_threshold_hours: c.threshold_hours, cloth_due: c.due };
  }

  function cashExpense(ev, number) {
    const cbk = ensureCashbook(state());
    const cat = cbk.categories.find((c) => c.name.toLowerCase() === 'ремонт столов');
    const id = globalThis.crypto.randomUUID();
    cbk.manual.push({ entry_id: id, date: ev.date, kind: 'expense', category_id: cat?.category_id ?? null, category: cat?.name ?? 'Ремонт столов', amount_kopecks: ev.cost_kopecks, signed_kopecks: -ev.cost_kopecks, comment: `${LABEL[ev.kind]}, стол ${number}${ev.comment ? `: ${ev.comment}` : ''}`.slice(0, 200), shift_id: null, reverses_id: null, reversed_by: null, reason: null, maintenance_event_id: ev.event_id, created_at: new Date().toISOString(), created_by: me().id, created_by_name: me().name });
    return id;
  }

  function storno(entryId, reason) {
    const cbk = ensureCashbook(state());
    const orig = cbk.manual.find((x) => x.entry_id === entryId);
    if (!orig || cbk.manual.some((x) => x.reverses_id === entryId)) return;
    cbk.manual.push({ ...orig, date: today(), comment: null, entry_id: globalThis.crypto.randomUUID(), amount_kopecks: -orig.amount_kopecks, signed_kopecks: orig.amount_kopecks, reverses_id: entryId, reason, created_at: new Date().toISOString(), created_by: me().id, created_by_name: me().name });
  }

  const routes = [
    ['GET', /^\/api\/clubs\/([^/]+)\/maintenance$/, allowed(() => ok(view()))],
    ['GET', /^\/api\/clubs\/([^/]+)\/maintenance\/thresholds$/, allowed(() => ok({ thresholds: { ...S().thresholds }, defaults: { ...DEFAULT_THRESHOLDS } }))],
    [
      'POST',
      /^\/api\/clubs\/([^/]+)\/maintenance$/,
      allowed((_m, b) => {
        const t = today();
        let orig = null;
        let reason = null;
        if (b.corrects_id) {
          if (typeof b.reason !== 'string' || !b.reason.trim()) return err(400, 'reason_required');
          reason = b.reason.trim();
          orig = S().events.find((e) => e.event_id === b.corrects_id);
          if (!orig) return err(404, 'not_found');
          if (S().events.some((e) => e.corrects_id === orig.event_id)) return err(409, 'duplicate');
        } else if (b.reason) return err(400, 'bad_request');
        const voided = b.void === true;
        if (voided && !orig) return err(400, 'bad_request');
        const resourceId = b.resource_id ?? orig?.resource_id;
        const r = hall().find((x) => x.resource.id === resourceId)?.resource;
        const kind = b.kind ?? orig?.kind;
        const date = b.date ?? orig?.date ?? t;
        if (!MAINT_KINDS.some((k) => k.value === kind) || !isYmd(date) || date > t || date < addDays(t, -MAINT_MAX_BACK_DAYS)) return err(400, 'bad_request');
        const comment = b.comment !== undefined ? (typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim() : null) : (orig?.comment ?? null);
        if (comment && comment.length > 500) return err(400, 'bad_request');
        const cost = voided ? 0 : (b.cost_kopecks ?? (orig ? orig.cost_kopecks : 0));
        if (!Number.isSafeInteger(cost) || cost < 0) return err(400, 'bad_request');
        if (cost > 0 && date < addDays(t, -MAINT_COST_MAX_BACK_DAYS)) return err(400, 'bad_request');
        if (!r) return err(404, 'not_found');
        const ev = { event_id: globalThis.crypto.randomUUID(), resource_id: r.id, resource_number: r.number, kind, date, comment, cost_kopecks: cost, corrects_id: orig?.event_id ?? null, corrected_by: null, voided, reason, cashbook_entry_id: null, created_by: me().id, created_by_name: me().name, created_at: new Date().toISOString() };
        if (orig?.cashbook_entry_id) {
          storno(orig.cashbook_entry_id, `Исправление обслуживания: ${reason}`);
          orig.cashbook_entry_id = null;
        }
        if (cost > 0) ev.cashbook_entry_id = cashExpense(ev, r.number);
        S().events.push(ev);
        audit(orig ? 'maintenance.correct' : 'maintenance.event', { resource_number: r.number, reason: reason ?? undefined, data: { kind, date, cost_kopecks: cost, void: voided } });
        return { status: 201, body: ev };
      }),
    ],
    [
      'PUT',
      /^\/api\/clubs\/([^/]+)\/maintenance\/thresholds$/,
      allowed((_m, b) => {
        if (!b || typeof b !== 'object' || !Object.keys(b).length) return err(400, 'bad_request');
        const next = { ...S().thresholds };
        for (const [k, v] of Object.entries(b)) {
          if (!ALL_KINDS.includes(k)) return err(400, 'bad_request');
          if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= THRESHOLD_MAX)) return err(400, 'bad_request');
          next[k] = v;
        }
        const before = S().thresholds;
        S().thresholds = next;
        audit('maintenance.thresholds_update', { data: { before, after: next } });
        return ok({ thresholds: { ...next }, defaults: { ...DEFAULT_THRESHOLDS } });
      }),
    ],
  ];
  return { routes, cloth };
}
