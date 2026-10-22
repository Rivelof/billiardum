// T14. ККТ выключена во время продажи: продажа сохранена, чек receipt_pending, ресепшн видит
// предупреждение (SSE kkt и GET kkt/status), после включения чек пробит; по одному receipt_id —
// ровно один документ в эмуляторе АТОЛ (по всем UUID попыток kkt_job.uuids).
//
// Эмулятор АТОЛ: POST /__emu/power {on:false, mode:"error"} — задание принимается и падает с
// «Нет связи» (повтор с новым UUID, decisions №91). В конце ККТ включается в любом случае.
//
// «Исход неизвестен» (decisions №91): /__emu/fault {kind:"forget_request"} — документ в ФН есть,
// а веб-сервер АТОЛ задание «забыл» → мост сообщает atol_task_lost → тревога receipt_unknown
// (критично, владельцу) → управляющий отмечает чек пробитым с ФД/ФП с ленты → второго чека нет,
// очередь клуба не стоит. Плюс права и коды ручного решения на чеке с известным исходом.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  CLUB_A,
  closeMyShift,
  docsFor,
  kktDocs,
  kktPower,
  kktState,
  openMyShift,
  P,
  posSale,
  receiptRow,
  rub,
  sse,
  staff,
  waitFor,
  waitReceiptsPrinted,
  waitSale,
  ensureStock,
  kkt,
  ok,
  OWNER_ID,
} from './helpers.mjs';

let db;
let rec;
let man;
let shift;
let stream;
const sales = [];

before(async () => {
  db = await adminClient();
  rec = await staff('reception');
  man = await staff('manager');
  await ensureStock(db, man, { [P.chips]: 30, [P.nuts]: 20, [P.waterStill]: 30, [P.waterSpark]: 20, [P.beer]: 20 });
  shift = await openMyShift({ rec, man, floatKopecks: 100_000, log: (m) => console.log(`# ${m}`) });
  stream = sse(`club=${CLUB_A}`, rec.token);
  await stream.ready;
});

after(async () => {
  try {
    kktPower(true);
  } catch (e) {
    console.log(`# ККТ не включена: ${e.message}`);
  }
  stream?.close();
  if (shift) {
    if (sales.length) await waitReceiptsPrinted(db, sales.map((s) => s.receipt_id), { timeoutMs: 90_000 }).catch(() => {});
    const closed = await closeMyShift({ rec, man, shiftId: shift.id, comment: 'e2e T14' }).catch((e) => console.log(`# смена не закрыта: ${e.message}`));
    if (closed) console.log(`# смена №${closed.number} закрыта честно, расхождение ${closed.discrepancy_kopecks}`);
  }
  await db?.end();
});

test('T14: ККТ выключена — продажа сохранена, чек receipt_pending, предупреждение ресепшену', async (t) => {
  const st0 = kktState();
  t.diagnostic(`эмулятор до: power=${st0.power} mode=${st0.offline_mode} fd=${st0.fd}`);
  kktPower(false, 'error');
  t.diagnostic(`ККТ выключена: ${JSON.stringify(kktState()).slice(0, 120)}`);
  const tOff = Date.now();

  const a = await posSale(rec.token, { items: [{ product_id: P.waterStill, qty: 2 }], method: 'cash', received_kopecks: 50_000 });
  const b = await posSale(rec.token, { items: [{ product_id: P.cappuccino, qty: 1, modifier_ids: [] }], method: 'card_terminal' });
  t.diagnostic(`продажа наличными → HTTP ${a.status} status=${a.json?.status} receipt_status=${a.json?.receipt_status} сдача ${a.json?.change_kopecks}`);
  t.diagnostic(`продажа терминалом → HTTP ${b.status} status=${b.json?.status} receipt_status=${b.json?.receipt_status}`);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  for (const s of [a.json, b.json]) {
    assert.equal(s.status, 'completed', 'продажа сохранена и завершена без ККТ');
    assert.equal(s.receipt_status, 'receipt_pending');
    sales.push(s);
  }

  // Задание доходит до АТОЛ и падает «Нет связи» — хотя бы одна ошибка по каждому чеку.
  const rows = await waitFor(
    async () => {
      const list = await Promise.all(sales.map((s) => receiptRow(db, s.receipt_id)));
      return list.some((r) => Number(r.kkt_job?.errors ?? 0) >= 1) ? list : null;
    },
    { timeoutMs: 60_000, intervalMs: 500, what: 'ошибка задания при выключенной ККТ' },
  );
  for (const r of rows) t.diagnostic(`чек ${r.id.slice(0, 8)}: status=${r.status} state=${r.kkt_job?.state} errors=${r.kkt_job?.errors ?? 0} last_error=${JSON.stringify(r.kkt_job?.last_error ?? null)} uuids=${r.kkt_job?.uuids?.length ?? 0}`);
  assert.ok(rows.every((r) => r.status === 'receipt_pending'));

  const status = await waitFor(
    async () => {
      const s = await api('GET', `/api/clubs/${CLUB_A}/kkt/status`, { token: rec.token });
      return s.status === 200 && s.json.queue.pending >= 2 && s.json.state !== 'online' ? s.json : null;
    },
    { timeoutMs: 40_000, intervalMs: 500, what: 'kkt/status: предупреждение и очередь' },
  ).catch(async () => (await api('GET', `/api/clubs/${CLUB_A}/kkt/status`, { token: rec.token })).json);
  t.diagnostic(`GET kkt/status (ресепшн): state=${status.state} reason=${status.reason} queue=${JSON.stringify(status.queue)}`);
  assert.ok(status.queue.pending >= 2);
  assert.ok(status.queue.pending_kopecks >= a.json.total_kopecks + b.json.total_kopecks);

  const warn = await stream.waitEvent((e) => e.event === 'kkt' && e.at >= tOff && (e.data.state !== 'online' || e.data.queue?.pending > 0), { timeoutMs: 40_000, what: 'SSE kkt с предупреждением' });
  t.diagnostic(`SSE kkt у ресепшена через ${warn.at - tOff} мс после выключения: ${JSON.stringify(warn.data).slice(0, 300)}`);
  const offline = stream.events.find((e) => e.event === 'kkt' && e.at >= tOff && e.data.state !== 'online');
  t.diagnostic(`SSE kkt с state≠online: ${offline ? `${offline.data.state}/${offline.data.reason} через ${offline.at - tOff} мс` : 'не было'}`);
  assert.ok(offline, 'ресепшн получил предупреждение: ККТ не на связи');

  const list = await api('GET', `/api/clubs/${CLUB_A}/kkt/receipts?status=pending`, { token: rec.token });
  t.diagnostic(`GET kkt/receipts?status=pending → ${list.status}, наших: ${list.json?.filter?.((x) => sales.some((s) => s.receipt_id === x.id)).length}`);
  assert.equal(list.status, 200);
});

test('T14: ККТ включена — чеки пробиты, по каждому receipt_id ровно один документ', async (t) => {
  assert.equal(sales.length, 2);
  const tOn = Date.now();
  kktPower(true);
  const printed = await waitReceiptsPrinted(db, sales.map((s) => s.receipt_id), { timeoutMs: 120_000 });
  t.diagnostic(`чеки пробиты через ${Date.now() - tOn} мс после включения: ${JSON.stringify(printed.map((r) => ({ fd: r.fd, fp: r.fp })))}`);
  const docs = kktDocs();
  for (const s of sales) {
    const r = await receiptRow(db, s.receipt_id);
    const mine = docsFor(docs, r);
    t.diagnostic(`чек ${rub(Number(r.amount_kopecks))}: попыток (UUID) ${r.kkt_job.uuids.length}, done_uuid=${r.kkt_job.done_uuid === r.id ? 'receipt_id' : 'новый'}; документов в АТОЛ: ${mine.length} (fd ${mine.map((d) => d.fd).join(',')})`);
    assert.equal(mine.length, 1, 'ровно один чек на продажу');
    assert.equal(mine[0].fd, Number(r.fd));
    assert.equal(mine[0].total_kopecks, s.total_kopecks);
    const v = await waitSale(rec.token, s.sale_id);
    assert.equal(v.receipt_fd, Number(r.fd));
  }
});

test('T14: после включения ККТ предупреждение ресепшена снимается (короткое отключение)', async (t) => {
  // Отключение было короче опроса состояния моста (15 с): мост не заметил его сам, сервер узнал
  // о «Нет связи» из результата задания. После пробития чеков состояние должно вернуться в online.
  const tOn = Date.now();
  const ok2 = await stream.waitEvent((e) => e.event === 'kkt' && e.data.state === 'online' && e.data.queue?.pending === 0 && e.at >= tOn - 60_000, { timeoutMs: 40_000, what: 'SSE kkt online' }).catch(() => null);
  const st = await api('GET', `/api/clubs/${CLUB_A}/kkt/status`, { token: rec.token });
  const last = stream.events.filter((e) => e.event === 'kkt').at(-1);
  t.diagnostic(`последнее SSE kkt: ${last ? `${last.data.state}/${last.data.reason} queue.pending=${last.data.queue?.pending}` : 'нет'}; SSE online: ${ok2 ? 'было' : 'не было за 40 с'}`);
  t.diagnostic(`GET kkt/status: state=${st.json.state} reason=${st.json.reason} bridge.kkt=${JSON.stringify(st.json.bridges?.[0]?.kkt)} queue=${JSON.stringify(st.json.queue)}; эмулятор power=${kktState().power}`);
  assert.equal(st.json.state, 'online', 'чеки пробиты, ККТ включена, а ресепшн видит «ККТ не на связи»');
});

test('T14: долгое отключение (дольше опроса моста) — мост сообщает offline, после включения online', async (t) => {
  const tOff = Date.now();
  kktPower(false, 'error');
  const off = await stream.waitEvent((e) => e.event === 'kkt' && e.at >= tOff && e.data.state === 'offline', { timeoutMs: 40_000, what: 'SSE kkt offline' }).catch(() => null);
  t.diagnostic(`выключена ${Math.round((Date.now() - tOff) / 1000)} с; SSE offline: ${off ? `${off.data.reason} через ${off.at - tOff} мс` : 'нет'}`);
  await new Promise((r) => setTimeout(r, Math.max(0, 20_000 - (Date.now() - tOff))));
  const tOn = Date.now();
  kktPower(true);
  const on = await stream.waitEvent((e) => e.event === 'kkt' && e.at >= tOn && e.data.state === 'online', { timeoutMs: 40_000, what: 'SSE kkt online' }).catch(() => null);
  const st = await api('GET', `/api/clubs/${CLUB_A}/kkt/status`, { token: rec.token });
  t.diagnostic(`включена; SSE online: ${on ? `через ${on.at - tOn} мс` : 'нет за 40 с'}; GET kkt/status: ${st.json.state}/${st.json.reason}`);
  assert.equal(st.json.state, 'online');
});

test('T14: «исход неизвестен» — ручное решение доступно только управляющему, только для unknown', async (t) => {
  const s = sales[0];
  assert.ok(s);
  const unk = await api('GET', `/api/clubs/${CLUB_A}/kkt/receipts?status=unknown`, { token: man.token });
  t.diagnostic(`GET kkt/receipts?status=unknown (управляющий) → ${unk.status}, записей ${unk.json?.length}`);
  assert.equal(unk.status, 200);
  const recTry = await api('POST', `/api/kkt/receipts/${s.receipt_id}/mark-printed`, { token: rec.token, body: { fd: 1, fp: '1', reason: 'x' } });
  const noReason = await api('POST', `/api/kkt/receipts/${s.receipt_id}/mark-printed`, { token: man.token, body: { fd: 1, fp: '1' } });
  const known = await api('POST', `/api/kkt/receipts/${s.receipt_id}/mark-printed`, { token: man.token, body: { fd: 1, fp: '1234567890', reason: 'e2e: проверка кода' } });
  const retry = await api('POST', `/api/kkt/receipts/${s.receipt_id}/retry`, { token: man.token, body: { reason: 'e2e: проверка кода' } });
  t.diagnostic(`mark-printed ресепшеном → ${recTry.status} ${recTry.text}; без причины → ${noReason.status} ${noReason.text}; пробитый чек → ${known.status} ${known.text}; retry пробитого → ${retry.status} ${retry.text}`);
  assert.equal(recTry.status, 403);
  assert.equal(noReason.status, 400);
  assert.equal(known.status, 409);
  assert.equal(known.json.error, 'receipt_not_unknown');
  assert.equal(retry.status, 409);
  const r = await receiptRow(db, s.receipt_id);
  assert.equal(r.status, 'printed', 'чек не изменился');
});

test('T14: «исход неизвестен» (АТОЛ забыл задание) → критичная тревога, mark-printed управляющим, второго чека нет', async (t) => {
  // Эмулятор: задание выполнено (документ в ФН), но веб-сервер АТОЛ его «забыл» — GET 404 (decisions №91).
  // Открытая тревога того же типа гасит уведомление о новой (повтор — только счётчик, №75): подтвердить старую.
  const old = (await ok(api('GET', `/api/clubs/${CLUB_A}/alarms`, { token: man.token }))).filter((a) => a.type === 'receipt_unknown' && a.state === 'open');
  for (const a of old) await api('POST', `/api/alarms/${a.id}/ack`, { token: man.token, body: {} });
  t.diagnostic(`подтверждено старых тревог receipt_unknown: ${old.length}`);
  kkt('/__emu/fault', { body: { kind: 'forget_request', times: 1 } });
  const t0 = new Date(Date.now() - 1000);
  const r = await posSale(rec.token, { items: [{ product_id: P.teaGreen, qty: 1, modifier_ids: [] }], method: 'cash', received_kopecks: 20_000 });
  assert.equal(r.status, 201, r.text);
  const s = r.json;
  const lost = await waitFor(
    async () => {
      const x = await receiptRow(db, s.receipt_id);
      return x.kkt_job?.state === 'lost' ? x : null;
    },
    { timeoutMs: 150_000, intervalMs: 1000, what: 'чек с неизвестным исходом (kkt_job.state = lost)' },
  );
  const docs0 = docsFor(kktDocs(), lost);
  const { rows: al } = await db.query("select type, level, state, data from bl.alarms where club_id = $1 and type = 'receipt_unknown' and data->>'receipt_id' = $2", [CLUB_A, s.receipt_id]);
  const { rows: au } = await db.query("select action from bl.audit_log where club_id = $1 and object_id = $2 and action = 'kkt.receipt_unknown'", [CLUB_A, s.receipt_id]);
  const { rows: notes } = await db.query("select level, text from bl.notifications where club_id = $1 and user_id = $2 and kind = 'alarm' and created_at >= $3 and text like 'Исход чека%'", [CLUB_A, OWNER_ID, t0]);
  const list = await ok(api('GET', `/api/clubs/${CLUB_A}/kkt/receipts?status=unknown`, { token: man.token }));
  const st = await ok(api('GET', `/api/clubs/${CLUB_A}/kkt/status`, { token: rec.token }));
  t.diagnostic(`чек ${s.receipt_id.slice(0, 8)}: status=${lost.status} state=${lost.kkt_job.state} error=${lost.error ?? lost.kkt_job.last_error?.code}; документов в АТОЛ по UUID: ${docs0.length} (ФД ${docs0.map((d) => d.fd)})`);
  t.diagnostic(`тревога: ${JSON.stringify(al.map((a) => [a.type, a.level, a.state]))}; журнал kkt.receipt_unknown: ${au.length}; уведомление владельцу: ${notes.map((n) => `${n.level}: ${n.text}`).join(' | ') || 'нет'}; в списке unknown: ${list.some((x) => x.id === s.receipt_id)}; kkt/status: ${st.state}/${st.reason} unknown=${st.queue.unknown}`);
  assert.equal(lost.status, 'receipt_pending');
  assert.equal(al.length, 1);
  assert.equal(al[0].level, 'critical');
  assert.equal(au.length, 1);
  assert.ok(notes.length >= 1, 'владелец уведомлён');
  assert.equal(docs0.length, 1, 'документ в ФН есть (АТОЛ лишь забыл задание)');

  // Очередь не стоит: следующий чек пробивается.
  const next = await posSale(rec.token, { items: [{ product_id: P.waterStill, qty: 1 }], method: 'card_terminal' });
  assert.equal(next.status, 201);
  await waitReceiptsPrinted(db, [next.json.receipt_id], { timeoutMs: 60_000 });
  sales.push(next.json);

  // Управляющий нашёл чек на ленте ККТ: ФД и ФП — с ленты (документ эмулятора).
  const d = docs0[0];
  const mp = await api('POST', `/api/kkt/receipts/${s.receipt_id}/mark-printed`, { token: man.token, body: { fd: d.fd, fp: String(d.fp), reason: 'Чек найден на ленте ККТ (e2e)' } });
  t.diagnostic(`mark-printed управляющим (ФД ${d.fd}, ФП ${d.fp}) → ${mp.status} ${mp.text.slice(0, 160)}`);
  assert.equal(mp.status, 200, mp.text);
  await new Promise((res) => setTimeout(res, 3000));
  const after1 = await receiptRow(db, s.receipt_id);
  const docs1 = docsFor(kktDocs(), after1);
  const sameFd = kktDocs().filter((x) => x.kind === 'sell' && x.total_kopecks === s.total_kopecks && new Date(x.at) >= t0);
  const { rows: man1 } = await db.query("select action, reason from bl.audit_log where club_id = $1 and object_id = $2 and action = 'manual.receipt_mark_printed'", [CLUB_A, s.receipt_id]);
  const { rows: al2 } = await db.query("select level from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'receipt_id' = $2", [CLUB_A, s.receipt_id]);
  const v = await waitSale(rec.token, s.sale_id);
  t.diagnostic(`после: чек ${after1.status} ФД ${after1.fd}; продажа receipt_fd=${v.receipt_fd}; документов по UUID ${docs1.length}, продаж на ${s.total_kopecks} коп. в АТОЛ после t0: ${sameFd.length}; журнал ${JSON.stringify(man1)}; тревога manual_action ${JSON.stringify(al2)}`);
  assert.equal(after1.status, 'printed');
  assert.equal(Number(after1.fd), d.fd);
  assert.equal(docs1.length, 1, 'второго чека нет');
  assert.equal(sameFd.length, 1, 'второго чека нет');
  assert.equal(man1.length, 1);
  assert.equal(al2[0]?.level, 'critical');
  sales.push(s);
});
