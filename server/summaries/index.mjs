// Утренняя сводка владельцу (контракт M3 §1 п. 8, decisions №110, №13, №43).
//
// В 10:00 по времени клуба (clubs.settings.summary_time_local) — сводка за вчерашние рабочие
// сутки (с clubs.settings.day_start_local, по умолчанию 06:00): выручка по способам оплаты
// и возвраты, часы игры и загрузка, тревоги по уровням, ручные действия (и автоматические действия
// системы, если были) и хеш головы журнала.
// Получатели — владелец и управляющий (уведомление по цепочке каналов); управляющему сети (M5.5
// №192) — без разбивки выручки по способам оплаты. Отправка один раз:
// строка bl.club_summaries (клуб, вид, рабочие сутки) пишется в той же транзакции.
// Планировщик раз в минуту на ctx.clock — тесты двигают часы.
// M5.1 (№153): клубу в тестовом режиме сводка не отправляется; тестовые записи (is_test) в сводку
// не входят (запросы server/reports/queries.mjs).

import { formatDate, formatMoney, plural } from '@billiardum/shared/format';
import { withContext as storeWithContext } from '../lib/store.mjs';
import { send } from '../notify/index.mjs';
import { computeDay } from '../dashboard/day.mjs';
import { loadClub } from '../dashboard/store.mjs';
import { manualActions, playStats, revenueOf, shiftPayments, shiftRefunds } from '../reports/queries.mjs';

export const TICK_MS = 60_000;
export const ROLES = ['owner', 'manager'];
const HHMM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const METHOD_TITLES = { sbp: 'СБП', card: 'карта', cash: 'наличные', card_terminal: 'терминал' };

/** Местные дата (YYYY-MM-DD) и минуты от полуночи в поясе tz. */
export function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function minutesOf(hhmm, fallback) {
  const m = HHMM.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

/** Дата на day дней раньше (YYYY-MM-DD). */
export function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Сводка за рабочие сутки day клуба из контекста транзакции. */
export async function buildMorningSummary(db, { clubId, day, timezone, dayStartLocal = '06:00', now = new Date() }) {
  const { rows } = await db.query(
    `select ($1::date + $2::time) at time zone $3 as from_at, ($1::date + 1 + $2::time) at time zone $3 as to_at`,
    [day, dayStartLocal, timezone],
  );
  const from = rows[0].from_at;
  const toExclusive = rows[0].to_at;
  const to = new Date(toExclusive.getTime() - 1);
  const payments = await shiftPayments(db, { clubId, from, to });
  const refunds = await shiftRefunds(db, { clubId, from, to });
  const revenue = revenueOf(payments, refunds);
  // Незаконченные сутки (свежая сводка «за сегодня» в сверке с дашбордом): идущая игра считается до «сейчас», а не до конца суток.
  const play = await playStats(db, { clubId, from, to: new Date(Math.min(to.getTime(), Math.max(from.getTime(), now.getTime()))) });
  // Загрузка суток — по формуле дашборда (№170, №187): ёмкость — ресурсы «в работе» в эти сутки (по созданию и журналу
  // вывода: корт, которого ещё не было, не входит) в часы работы клуба; игра — фактические минуты суток. Сводка и дашборд
  // не расходятся ни до копейки, ни до процента (приёмка M5.8, T29).
  const club = await loadClub(db, clubId);
  if (club) {
    const { daily } = await computeDay(db, { club, day, now });
    const cap = daily.totals.capacity_minutes;
    play.utilization_percent = cap > 0 ? Math.round(((daily.totals.play_minutes / cap) * 100) * 10) / 10 : 0;
    play.resources = Object.values(daily.resources).filter((r) => r.capacity_minutes > 0).length;
  }
  const alarms = { critical: 0, important: 0, info: 0, total: 0 };
  const a = await db.query('select level, count(*)::int as n from bl.alarms where raised_at >= $1 and raised_at < $2 group by level', [from, toExclusive]);
  for (const r of a.rows) {
    alarms[r.level] = r.n;
    alarms.total += r.n;
  }
  const manual = await manualActions(db, { clubId, from, to, limit: 0 });
  const head = (await db.query('select seq, hash from bl.audit_log where club_id = $1 order by seq desc limit 1', [clubId])).rows[0];
  return {
    day,
    timezone,
    from: from.toISOString(),
    to: toExclusive.toISOString(),
    revenue: {
      by_method: revenue.by_method,
      total_kopecks: revenue.total_kopecks,
      refunds_kopecks: revenue.refunds.total_kopecks,
      net_kopecks: revenue.net_kopecks,
      // M4: взносы за турниры (строка tournaments из revenueOf).
      tournaments: { total_kopecks: revenue.tournaments?.total_kopecks ?? 0 },
    },
    play: { sessions: play.sessions, minutes: play.minutes, hours: play.hours, utilization_percent: play.utilization_percent, resources: play.resources },
    alarms,
    // №125: «ручные» — manual.*; действия системы (сгорание предоплаты, автоматические возвраты
    // и отмены) — отдельно, в automatic.
    manual_actions: { count: manual.count, by_action: manual.by_action, automatic: { count: manual.automatic.count, by_action: manual.automatic.by_action } },
    journal: head ? { head_seq: Number(head.seq), head_hash: head.hash } : { head_seq: 0, head_hash: null },
  };
}

/** Текст сводки (без персональных данных). */
export function summaryText(s, { methods: withMethods = true } = {}) {
  const dayDate = new Date(`${s.day}T12:00:00Z`);
  const methods = (withMethods ? Object.keys(METHOD_TITLES) : [])
    .filter((m) => s.revenue.by_method[m] > 0)
    .map((m) => `${METHOD_TITLES[m]} ${formatMoney(s.revenue.by_method[m])}`);
  const parts = [
    `выручка ${formatMoney(s.revenue.net_kopecks)}${methods.length ? ` (${methods.join(', ')})` : ''}${s.revenue.refunds_kopecks ? `, возвраты ${formatMoney(s.revenue.refunds_kopecks)}` : ''}`,
    `игра ${String(s.play.hours).replace('.', ',')} ч, загрузка ${String(s.play.utilization_percent).replace('.', ',')} %`,
    ...(s.revenue.tournaments?.total_kopecks > 0 ? [`турниры ${formatMoney(s.revenue.tournaments.total_kopecks)}`] : []),
    `${s.alarms.total} ${plural(s.alarms.total, ['тревога', 'тревоги', 'тревог'])}${s.alarms.critical ? `, из них критичных ${s.alarms.critical}` : ''}`,
    `ручных действий: ${s.manual_actions.count}`,
  ];
  const automatic = s.manual_actions.automatic?.count ?? 0;
  if (automatic > 0) parts.push(`автоматических действий системы: ${automatic}`);
  const journal = s.journal.head_hash ? ` Журнал: запись ${s.journal.head_seq}, хеш ${s.journal.head_hash}.` : '';
  return `Сводка за ${formatDate(dayDate, 'UTC')}: ${parts.join('; ')}.${journal}`;
}

/**
 * Один проход планировщика: клубам, у которых по местному времени наступило время сводки,
 * отправить сводку за вчерашние рабочие сутки (если ещё не отправлена).
 * @returns {Promise<{ sent: { club_id: string, day: string }[] }>}
 */
export async function tick({ pool, withContext = storeWithContext, clock, log }) {
  const now = clock.now();
  const clubs = await withContext(pool, { clubId: null, actorType: 'system' }, (db) => db.query('select * from bl.summary_clubs()'));
  const sent = [];
  for (const c of clubs.rows) {
    try {
      const local = localParts(now, c.timezone);
      // Время сводки раньше конца рабочих суток (day_start) — сводка ждёт их конца (№130 п. 15).
      const due = Math.max(minutesOf(c.summary_time_local, 600), minutesOf(c.day_start_local, 360));
      if (local.minutes < due) continue;
      // Рабочие сутки, закончившиеся сегодня в day_start: начались вчера.
      const day = shiftDate(local.date, -1);
      const done = await withContext(pool, { clubId: c.club_id, actorType: 'system' }, async (db) => {
        if ((await db.query('select bl.ctx_club_mode() as m')).rows[0].m === 'test') return false;
        const exists = await db.query("select 1 from bl.club_summaries where club_id = $1 and kind = 'morning' and day = $2", [c.club_id, day]);
        if (exists.rowCount > 0) return false;
        const data = await buildMorningSummary(db, { clubId: c.club_id, day, timezone: c.timezone, dayStartLocal: c.day_start_local, now });
        const ins = await db.query(
          `insert into bl.club_summaries (club_id, kind, day, data, sent_at) values ($1, 'morning', $2, $3::jsonb, $4)
           on conflict (club_id, kind, day) do nothing returning id`,
          [c.club_id, day, JSON.stringify(data), now],
        );
        if (ins.rowCount === 0) return false;
        // Управляющему сети (членство через сеть, M5.5 №192) — без разбивки по способам оплаты.
        const { rows: to } = await db.query(
          `select user_id, bool_and(network_id is not null) as via_network
             from bl.club_members where club_id = $1 and role = any($2::text[]) and active
            group by user_id order by user_id`,
          [c.club_id, ROLES],
        );
        for (const r of to) {
          await send(db, r.user_id, {
            kind: 'summary.morning',
            level: 'info',
            text: summaryText(data, { methods: !r.via_network }),
            data: { day, head_hash: data.journal.head_hash, url: '/club/' },
          });
        }
        return true;
      });
      if (done) {
        sent.push({ club_id: c.club_id, day });
        log?.info('summary_sent', { club_id: c.club_id, kind: 'morning', day });
      }
    } catch (err) {
      log?.error('summary_failed', { club_id: c.club_id, error: err.message });
    }
  }
  return { sent };
}

let state = null;

/** Модуль сводок (контракт M1 §2.1): планировщик раз в минуту. */
export async function init(ctx) {
  if (state) return;
  const run = () => tick({ pool: ctx.pool, withContext: ctx.withContext ?? storeWithContext, clock: ctx.clock, log: ctx.log });
  let running = null;
  const timer = setInterval(() => {
    if (running) return;
    running = run()
      .catch((err) => ctx.log.error('summary_tick_failed', { error: err.message }))
      .finally(() => {
        running = null;
      });
  }, ctx.summaries?.tickMs ?? TICK_MS);
  timer.unref?.();
  state = { timer, running: () => running };
  ctx.log.info('summaries_started', {});
}

export async function stop() {
  if (!state) return;
  clearInterval(state.timer);
  await state.running();
  state = null;
}
