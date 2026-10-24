// Подставные часы для подписки (T31): запускается ВНУТРИ контейнера сервера —
//   docker exec billiardum-server-1 node /repo/tests/e2e/m5-3/clock-runner.mjs <команда> <club_id> <ISO-время>
// Настоящий код модуля server/billing (processClub, syncPayment, getSubscription) с часами на <ISO-время>,
// в обычных транзакциях сервера (commit), только для одного клуба <club_id> — другие клубы не трогаются.
// Ключи магазина платформы и DATABASE_URL — из окружения контейнера; в вывод не попадают.
//
// Команды:
//   process  — один проход планировщика по клубу (счёт, списание, повтор, напоминание, уведомление Андрею)
//   sync     — сверка платежей платформы клуба без итога (как планировщик через 30 с без вебхука)
//   state    — GET подписки глазами владельца и управляющего на это время
// Вывод — одна строка JSON.

import pg from 'pg';
import { withContext } from '../../../server/lib/store.mjs';
import { billingConfig } from '../../../server/billing/config.mjs';
import { processClub } from '../../../server/billing/scheduler.mjs';
import { syncPayment } from '../../../server/billing/core.mjs';
import { getSubscription } from '../../../server/billing/service.mjs';

const [cmd, clubId, iso] = process.argv.slice(2);
if (!cmd || !/^[0-9a-f-]{36}$/.test(clubId ?? '') || Number.isNaN(Date.parse(iso ?? ''))) {
  process.stdout.write(`${JSON.stringify({ error: 'usage: process|sync|state <club_id> <iso>' })}\n`);
  process.exit(2);
}
const now = new Date(iso);
const logs = [];
const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((l) => [l, (msg, f) => logs.push({ l, msg, ...(f ?? {}) })]));
const deps = { clock: { now: () => now }, log };
const config = billingConfig({ config: { publicHost: process.env.PUBLIC_HOST } });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const system = { clubId: null, actorType: 'system' };

try {
  let out;
  if (cmd === 'process') {
    const { rows } = await withContext(pool, system, (db) => db.query('select * from bl.billing_clubs()'));
    const club = rows.find((c) => c.club_id === clubId);
    if (!club) throw new Error('клуб не в bl.billing_clubs()');
    const r = await withContext(pool, system, (db) => processClub(db, deps, config, club, now));
    out = { result: r, mode: club.mode, tables: Number(club.tables) };
  } else if (cmd === 'sync') {
    const { rows } = await withContext(pool, system, (db) =>
      db.query("select id from bl.billing_payments where club_id = $1 and status in ('pending', 'waiting_for_capture') and provider_payment_id is not null", [clubId]),
    );
    const res = [];
    for (const p of rows) res.push(await withContext(pool, system, (db) => syncPayment(db, deps, config, p.id, { via: 'sync', now })));
    out = { synced: rows.length, res };
  } else if (cmd === 'state') {
    const ctx = { clubId, actorType: 'system' };
    const owner = await withContext(pool, ctx, (db) => getSubscription(db, { clubId, owner: true, now, config }));
    const manager = await withContext(pool, ctx, (db) => getSubscription(db, { clubId, owner: false, now, config }));
    out = { owner, manager };
  } else throw new Error(`неизвестная команда ${cmd}`);
  process.stdout.write(`${JSON.stringify({ ok: true, now: now.toISOString(), ...out, logs: logs.map(({ l, msg, code, error, attempt }) => ({ l, msg, code, error, attempt })) })}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: err.message, code: err.code, logs })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
