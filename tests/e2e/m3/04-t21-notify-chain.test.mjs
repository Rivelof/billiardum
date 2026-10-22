// T21. MAX-бот не доставил напоминание → ушло в запасной канал (decisions №110, контракт M3 §1 п. 7).
//
// На стенде разработки ни один мессенджер не настроен (MAX — заглушка до документации,
// MAX_BOT_TOKEN, TELEGRAM_BOT_TOKEN и TELEGRAM_PROXY_URL пусты), а подменить канал у живого
// сервера нечем (dev-ручек для уведомлений нет). Поэтому две части:
// 1. Живой стек. Гость с синтетическими id MAX и Telegram (в базе) выбирает порядок каналов
//    PATCH /api/me {notify_channel: max, channels_order: [max, telegram]}; бронь стола
//    E2E_T21_TABLE (по умолчанию 6) через 15–20 минут → сервер сам шлёт напоминание booking.soon
//    за 15 минут до начала. В bl.notifications: попытки по порядку max → telegram (MAX не
//    доставил — not_configured — и цепочка пошла дальше), итог skipped: доставить некуда.
// 2. То же напоминание (та же строка bl.notifications, живая база, транзакция с ROLLBACK)
//    проводится настоящим обработчиком доставки server/notify createNotifier().deliver с
//    подменой адаптеров: MAX отвечает ошибкой → Telegram получил текст и кнопку «Моя бронь»
//    (абсолютная ссылка своего сайта), итог sent/telegram, попытки [max:failed, telegram:sent];
//    MAX молчит дольше тайм-аута → max:failed:timeout → telegram. Тайм-аут по умолчанию 30 с.
// Длится до 6 минут (ожидание напоминания).

import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createNotifier, DELIVERY_TIMEOUT_MS } from '../../../server/notify/index.mjs';
import {
  adminClient,
  api,
  cancelBooking,
  cancelLeftovers,
  containerLog,
  createBooking,
  FAST_BOOKING,
  hhmm,
  MIN,
  newGuest,
  notificationsOf,
  ok,
  patchClubSettings,
  payBooking,
  SERVER_CONTAINER,
  slotAfter,
  staff,
  waitFor,
  waitTableFree,
} from './helpers.mjs';

const T = Number(process.env.E2E_T21_TABLE || 6);
let db;
let guest;
let bookingId;

before(async () => {
  db = await adminClient();
  const man = await staff('manager');
  await cancelLeftovers(db, man, [T], (m) => console.log(m));
  await waitTableFree(T);
});

after(async () => {
  if (bookingId) await cancelBooking(guest.token, bookingId).catch(() => null);
  if (guest) await db.query('update bl.users set max_user_id = null, telegram_user_id = null where id = $1', [guest.user.id]).catch(() => null);
  await db?.end();
});

let note;

test('T21 на живом стеке: MAX не доставил напоминание — цепочка пошла в Telegram (оба не настроены)', { timeout: 10 * MIN }, async (t) => {
  guest = await newGuest();
  const maxId = `e2e_max_${randomInt(1e9)}`;
  const tgId = 9_000_000_000 + randomInt(1e9);
  await db.query('update bl.users set max_user_id = $2, telegram_user_id = $3 where id = $1', [guest.user.id, maxId, tgId]);
  const me = await ok(api('PATCH', '/api/me', { token: guest.token, body: { notify_channel: 'max', channels_order: ['max', 'telegram'] } }));
  t.diagnostic(`гость: notify_channel ${me.user.notify_channel}, channels_order ${JSON.stringify(me.user.channels_order)}, каналы ${JSON.stringify(me.user.channels ?? null)}, можно предложить ${JSON.stringify(me.user.channels_available ?? null)}`);
  assert.deepEqual(me.user.channels_order, ['max', 'telegram']);
  // №126: ненастроенный на сервере канал гостю не показывается подключённым и не предлагается.
  assert.equal(me.user.channels.max, false);
  assert.ok(Array.isArray(me.user.channels_available) && !me.user.channels_available.includes('max'));

  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'full' });
  const startsAt = slotAfter(15 * MIN + 20_000);
  const b = await ok(createBooking(guest.token, { table: T, startsAt, minutes: 15 }), 201);
  bookingId = b.id;
  await payBooking(guest, b.id);
  t.diagnostic(`бронь ${b.id.slice(0, 8)} на ${hhmm(startsAt)}; напоминание ждём в ${hhmm(startsAt.getTime() - 15 * MIN)}`);
  const since = new Date();
  note = await waitFor(async () => {
    const n = (await notificationsOf(db, guest.user.id, { kind: 'booking.soon' }))[0];
    return n && n.status !== 'queued' ? n : null;
  }, { timeoutMs: startsAt.getTime() - 15 * MIN - Date.now() + 90_000, intervalMs: 2000, what: 'напоминание booking.soon доставлено (или нет)' });
  const tried = note.attempts.map((a) => `${a.channel}:${a.status}:${a.code ?? ''}`);
  t.diagnostic(`напоминание «${note.text}»: статус ${note.status}, канал ${note.channel}, попытки ${JSON.stringify(tried)}`);
  assert.deepEqual(tried, ['max:skipped:not_configured', 'telegram:skipped:not_configured'], 'MAX первым, затем запасной Telegram');
  assert.equal(note.status, 'skipped');
  const logs = containerLog(SERVER_CONTAINER, { since: new Date(since.getTime() - 60_000) }).filter((l) => l.notification_id === note.id);
  t.diagnostic(`лог сервера: ${logs.map((l) => `${l.msg}${l.channel ? `/${l.channel}` : ''}${l.tried ? ` ${JSON.stringify(l.tried)}` : ''}`).join(', ')}`);
  assert.ok(logs.some((l) => l.msg === 'notify_skipped'));
  assert.ok(!JSON.stringify(logs).includes(guest.phone), 'телефона гостя в логе нет');
});

test('T21 обработчиком доставки с подменой каналов: MAX ошибка/тайм-аут → Telegram (живая база, откат)', { timeout: 2 * MIN }, async (t) => {
  assert.ok(note, 'нужно напоминание из первой части');
  assert.equal(DELIVERY_TIMEOUT_MS, 30_000, 'подтверждение мессенджера ждём 30 с (№110)');
  const log = { info() {}, warn() {}, error() {} };
  const run = async (max, opts = {}) => {
    const calls = [];
    const telegram = { configured: true, async call(method, params) { calls.push({ method, params }); return { ok: true }; } };
    const notifier = createNotifier({ config: { publicHost: 'localhost:8443', vapid: {} }, log, telegram, max, ...opts });
    await db.query('begin');
    try {
      await db.query("select set_config('app.club_id', '', true), set_config('app.user_id', '', true), set_config('app.actor_type', 'system', true)");
      await db.query("update bl.notifications set status = 'queued', channel = null, attempts = '[]'::jsonb, sent_at = null where id = $1", [note.id]);
      await notifier.deliver({ notification_id: note.id }, { db });
      const { rows } = await db.query('select status, channel, attempts, sent_at from bl.notifications where id = $1', [note.id]);
      return { row: rows[0], calls };
    } finally {
      await db.query('rollback');
    }
  };
  const failing = { configured: true, async call() { throw Object.assign(new Error('MAX: 502'), { code: 'api_502' }); } };
  const r1 = await run(failing);
  const tried1 = r1.row.attempts.map((a) => `${a.channel}:${a.status}:${a.code ?? ''}`);
  t.diagnostic(`MAX ошибка: ${r1.row.status}/${r1.row.channel}, попытки ${JSON.stringify(tried1)}; Telegram получил ${JSON.stringify(r1.calls.map((c) => ({ m: c.method, chat: String(c.params.chat_id).slice(0, 3) + '…', text: c.params.text, kb: c.params.reply_markup })))}`);
  assert.equal(r1.row.status, 'sent');
  assert.equal(r1.row.channel, 'telegram');
  assert.deepEqual(tried1, ['max:failed:api_502', 'telegram:sent:']);
  assert.equal(r1.calls.length, 1);
  assert.equal(r1.calls[0].params.text, note.text);
  assert.deepEqual(r1.calls[0].params.reply_markup?.inline_keyboard?.[0]?.[0], { text: 'Моя бронь', url: `https://localhost:8443/app/bookings/${bookingId}` });

  const hang = { configured: true, call: () => new Promise(() => {}) };
  const t0 = Date.now();
  const r2 = await run(hang, { deliveryTimeoutMs: 300 });
  const tried2 = r2.row.attempts.map((a) => `${a.channel}:${a.status}:${a.code ?? ''}`);
  t.diagnostic(`MAX молчит (тайм-аут 300 мс вместо 30 с): ${r2.row.status}/${r2.row.channel} за ${Date.now() - t0} мс, попытки ${JSON.stringify(tried2)}`);
  assert.deepEqual(tried2, ['max:failed:timeout', 'telegram:sent:']);
  assert.equal(r2.row.channel, 'telegram');

  const after = (await notificationsOf(db, guest.user.id, { kind: 'booking.soon' }))[0];
  assert.equal(after.status, note.status, 'живая строка не изменилась (откат)');
});
