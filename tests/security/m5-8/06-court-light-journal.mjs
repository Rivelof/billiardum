// PoC M5.8 / сценарий 6 — свет на корте: гонка на старт, журнал `device.cmd`, команды от клиента,
// остановка чужим, продление после конца оплаты (инварианты 1, 3, 4, 9).
//
// Корт сида 102 (TESTC00002), устройство 102 симулятора. Журнал читается ТОЛЬКО на чтение через
// GET /api/clubs/{club}/audit входом владельца сида (+70000000001); записей в сиде этот PoC не делает.
// Фаза «продление после конца» использует минуту игры (DEV_ALLOW_ANY_MINUTES на стенде, №54) —
// в проде такая котировка невозможна, что доказано в 01-quote-slots (unit, боевая конфигурация).
//
// Запуск: node tests/security/m5-8/06-court-light-journal.mjs     (≈ 4–5 минут)

import { COURT_CODES, api, emuSucceed, login, ok, providerId, pay, quote, runner, sim, sleep, startGame, stopGame, tableByCode, waitFor, waitFree } from './lib.mjs';

const r = runner('M5.8 / 6: корт 102 — свет, журнал, команды');
const CODE = COURT_CODES[102];
const CLUB = 'c1000000-0000-4000-8000-000000000001';
const owner = await login('+70000000001', { consent: false });
const auditCmds = async (resourceId, type) => {
  const q = new URLSearchParams({ action: 'device.cmd', resource: resourceId, limit: '200' });
  const resp = await api('GET', `/api/clubs/${CLUB}/audit?${q}`, { token: owner.token, headers: { 'x-club-id': CLUB } });
  if (resp.status !== 200) throw new Error(`audit ${resp.status} ${resp.text.slice(0, 120)}`);
  const items = resp.json.items ?? resp.json.entries ?? resp.json.records ?? [];
  return type ? items.filter((e) => e.data?.type === type) : items;
};

const payer = await login();
let sessionId = null;
try {
  await waitFree(CODE, payer.token);
  const tbl = await ok(tableByCode(CODE, payer.token));
  const RID = tbl.resource.id;
  const before = (await auditCmds(RID)).length;

  // 1. Гонка двух гостей за старт одного корта: один получает котировку, второй — занято.
  const rival = await login();
  const [qa, qb] = await Promise.all([
    quote(payer.token, { resource_id: RID, kind: 'start', minutes: 90 }),
    quote(rival.token, { resource_id: RID, kind: 'start', minutes: 90 }),
  ]);
  const codes = [qa.status, qb.status].sort();
  r.check('гонка на старт: одна котировка 200, вторая 409', codes[0] === 200 && codes[1] === 409, `${qa.status}/${qb.status} ${qa.json?.error ?? ''}${qb.json?.error ?? ''}`);
  const winner = qa.status === 200 ? payer : rival;
  const loser = winner === payer ? rival : payer;
  const sbp = await ok(pay(winner.token, (qa.status === 200 ? qa : qb).json.quote_id, 'sbp'));
  const lost = await quote(loser.token, { resource_id: RID, kind: 'start', minutes: 90 });
  r.check('пока корт удержан за первым, второй не получает котировку', lost.status === 409, `${lost.status} ${lost.json?.error}`);
  emuSucceed(providerId(sbp));
  const done = await waitFor(async () => {
    const x = await api('GET', `/api/payments/${sbp.payment_id}`, { token: winner.token });
    return x.status === 200 && x.json.session_id ? x.json : null;
  }, { what: 'сессия корта' });
  sessionId = done.session_id;
  const s = await waitFor(async () => ((await sim(102)).state.mode === 'active' ? sim(102) : null), { what: 'свет корта 102' });
  r.check('свет корта 102 включён по оплате', s.state.relay === true && s.state.session_id === sessionId);

  // 2. Журнал: котировка держит корт (state.pending), оплата включает свет (session.start). Обе команды — от
  //    системы, с cmd_id и seq устройства, подряд, на «Корт 2»; других команд корту никто не слал.
  const cmds = await auditCmds(RID);
  const fresh = cmds.slice(0, cmds.length - before).reverse();
  r.check('в журнале ровно две новые команды: state.pending, затем session.start', fresh.length === 2 && fresh[0].data?.type === 'state.pending' && fresh[1].data?.type === 'session.start', fresh.map((e) => e.data?.type).join(' → '));
  r.check('обе — от системы, на «Корт 2», с cmd_id', fresh.every((e) => e.actor_type === 'system' && e.resource_number === 2 && typeof e.data?.cmd_id === 'string'), JSON.stringify(fresh.map((e) => [e.actor_type, e.resource_number])));
  r.check('seq устройства растёт строго на 1', fresh.length === 2 && fresh[1].data.seq === fresh[0].data.seq + 1, `${fresh[0]?.data?.seq} → ${fresh[1]?.data?.seq}`);
  r.check('session.start несёт id оплаченной сессии', fresh[1]?.data?.session_id === sessionId);

  // 3. Клиент не шлёт команды контроллеру и не включает сервисный свет (инвариант 9).
  const stranger = await login();
  for (const [label, who] of [['гость-плательщик', winner], ['посторонний гость', stranger]]) {
    for (const [name, method, path, body] of [
      ['сервисный свет', 'POST', `/api/resources/${RID}/service`, { reason_code: 'cleaning', reason_text: 'x', minutes: 30 }],
      ['стоп сервисного света', 'POST', `/api/resources/${RID}/service/stop`, {}],
      ['identify', 'POST', `/api/resources/${RID}/identify`, {}],
      ['продление без оплаты', 'POST', `/api/sessions/${sessionId}/extend-free`, { minutes: 90, reason: 'x' }],
    ]) {
      const x = await api(method, path, { token: who.token, body });
      r.check(`${label}: ${name} — 401/403`, x.status === 401 || x.status === 403, `${x.status} ${x.json?.error}`);
    }
  }
  const bind = await api('POST', `/api/clubs/${CLUB}/devices/bind`, { token: stranger.token, body: { device_id: 'd1000000-0000-4000-8000-000000000102', resource_id: RID } });
  r.check('посторонний: привязка устройства в клубе сида — 401/403/404', [401, 403, 404].includes(bind.status), `${bind.status} ${bind.json?.error}`);
  const claim = await api('POST', '/api/devices/claim', { body: { device_id: 'd1000000-0000-4000-8000-000000000102', claim_code: 'AAAAAAAA-BBBB' } });
  r.check('claim уже привязанного корта с чужим кодом — отказ', claim.status >= 400 && claim.status !== 500, `${claim.status} ${claim.json?.error}`);
  const after = await sim(102);
  r.check('после всех попыток контроллер корта в прежнем состоянии', after.state.session_id === sessionId && after.state.mode === 'active');

  // 4. Остановить игру может только плательщик (№46); участник и посторонний — нет.
  const joiner = await login();
  await ok(api('POST', `/api/sessions/${sessionId}/join`, { token: joiner.token, body: { code: CODE } }));
  for (const [label, who] of [['участник «Я играю»', joiner], ['посторонний', stranger]]) {
    const x = await stopGame(who, sessionId);
    r.check(`${label}: «Закончить игру» — 403/404`, x.status === 403 || x.status === 404, `${x.status} ${x.json?.error}`);
  }
  const still = await sim(102);
  r.check('свет корта продолжает гореть', still.state.relay === true);
  const ext = await ok(quote(joiner.token, { resource_id: RID, kind: 'extend', session_id: sessionId, minutes: 90 }));
  r.check('участник может купить продление слотом (№46), цена слота', ext.minutes === 90 && ext.slots === 1, `${ext.amount_kopecks}`);
  const stopped = await stopGame(winner, sessionId);
  r.check('плательщик закончил игру — 200', stopped.status === 200, `${stopped.status}`);
  await waitFor(async () => (await sim(102)).state.relay === false, { what: 'свет 102 погас' });
  const stops = (await auditCmds(RID, 'session.stop')).filter((e) => e.data?.session_id === sessionId);
  r.check('в журнале session.stop на этот корт', stops.length >= 1, `записей: ${stops.length}`);
  sessionId = null;

  // 5. Конец оплаты: игра в одну минуту (dev-флаг), после конца и льготы свет гаснет сам, продлить закрытую нельзя.
  const g2 = await login();
  await waitFree(CODE, g2.token);
  const t2 = await ok(tableByCode(CODE, g2.token));
  const q2 = await ok(quote(g2.token, { resource_id: t2.resource.id, kind: 'start', minutes: 1 }));
  const p2 = await ok(pay(g2.token, q2.quote_id, 'sbp'));
  emuSucceed(providerId(p2));
  const sess = await waitFor(async () => {
    const x = await api('GET', `/api/payments/${p2.payment_id}`, { token: g2.token });
    return x.status === 200 && x.json.session_id ? x.json.session_id : null;
  }, { what: 'сессия 1 минуты' });
  sessionId = sess;
  await waitFor(async () => (await sim(102)).state.relay === true, { what: 'свет 102' });
  const t0 = Date.now();
  await waitFor(async () => (await sim(102)).state.relay === false, { timeoutMs: 6 * 60_000, intervalMs: 2000, what: 'свет погас сам после минуты и льготы' });
  const dark = await sim(102);
  r.check('свет погас сам, контроллер не продлил время (инвариант 4)', dark.state.relay === false && (dark.state.remaining_ms ?? 0) <= 0, `mode=${dark.state.mode} через ${Math.round((Date.now() - t0) / 1000)} с`);
  await sleep(8000);
  const closed = await api('GET', `/api/sessions/${sess}`, { token: g2.token });
  const late = await quote(g2.token, { resource_id: t2.resource.id, kind: 'extend', session_id: sess, minutes: 90 });
  r.check('продление закрытой игры корта — отказ', late.status >= 400, `сессия ${closed.json?.status ?? closed.json?.session?.status}; ${late.status} ${late.json?.error}`);
  const again = await sim(102);
  r.check('после отказа свет не включился', again.state.relay === false);
  sessionId = null;
} catch (e) {
  r.check(`сценарий не упал: ${e.message}`, false);
} finally {
  if (sessionId) {
    const st = await stopGame(payer, sessionId);
    console.log(`освобождение корта 102: stop → ${st.status}`);
  }
  r.done();
}
