// PoC M5.8 / сценарий 2 — оплата корта → свет только на этом корте; игроки; повтор вебхука.
// Атакующий: гость, который хочет (а) включить не тот ресурс, (б) пролезть в чужую игру,
// (в) занять больше 4 мест на корте гонкой, (г) продлить чужую игру, (д) повторить оплату.
// Инварианты: 1 (свет только по подписанной команде сервера), 4, 9.
//
// Запуск: node tests/security/m5-8/02-court-light-players.mjs
// Занимает корт сида 101 (TESTC00001) на время проверки и освобождает его в конце.

import { COURT_CODES, api, login, ok, quote, sim, startGame, stopGame, tableByCode, waitFor, waitFree, runner, emuWebhook, sleep } from './lib.mjs';

const r = runner('M5.8 / 2: корт 101 — свет, игроки, повтор оплаты');
const CODE = COURT_CODES[101];
const OTHER_COURT = COURT_CODES[102];
const TABLE1_CODE = 'TEST000001';

const payer = await login();
let sessionId = null;
try {
  await waitFree(CODE, payer.token);
  const before = { c102: (await sim(102)).state.mode, t1: (await sim(1)).state.mode };

  // 1. Оплата корта 101 включает свет только на 101.
  const g = await startGame(CODE, 90, payer);
  sessionId = g.sessionId;
  r.check('котировка корта: 1 слот = 90 минут, slots=1', g.q.minutes === 90 && g.q.slots === 1 && g.q.slot_minutes === 90, `minutes=${g.q.minutes} slots=${g.q.slots}`);
  const s101 = await waitFor(async () => {
    const s = await sim(101);
    return s.state.mode === 'active' ? s : null;
  }, { what: 'свет корта 101' });
  r.check('свет корта 101 включён, остаток ~90 мин', s101.state.relay === true && s101.state.remaining_ms > 89 * 60_000 && s101.state.remaining_ms <= 90 * 60_000, `remaining_ms=${s101.state.remaining_ms}`);
  r.check('сессия контроллера = сессия сервера', s101.state.session_id === sessionId);
  const after = { c102: (await sim(102)).state, t1: (await sim(1)).state };
  r.check('корт 102 не тронут', after.c102.mode === before.c102 && after.c102.relay === false, after.c102.mode);
  r.check('стол 1 не тронут', after.t1.mode === before.t1 && after.t1.relay === false, after.t1.mode);

  // 2. Подмена ресурса в продлении: сессия корта 101 + resource_id другого ресурса.
  const c102 = await ok(tableByCode(OTHER_COURT, payer.token));
  const t1 = await ok(tableByCode(TABLE1_CODE, payer.token));
  for (const [label, res] of [['корт 102', c102.resource.id], ['стол 1', t1.resource.id]]) {
    const q = await quote(payer.token, { resource_id: res, kind: 'extend', session_id: sessionId, minutes: 90 });
    r.check(`продление сессии корта 101 с resource_id (${label}) отклонено`, q.status === 404 && q.json?.error === 'not_found', `${q.status} ${q.text.slice(0, 80)}`);
  }

  // 3. Чужой гость: продлить без участия нельзя, «Я играю» только с кодом именно этого корта.
  const stranger = await login();
  const ext = await quote(stranger.token, { resource_id: g.t.resource.id, kind: 'extend', session_id: sessionId, minutes: 90 });
  r.check('чужой гость: продление чужой игры — 403', ext.status === 403, `${ext.status} ${ext.json?.error}`);
  for (const [label, code] of [['код стола 1', TABLE1_CODE], ['код корта 102', OTHER_COURT]]) {
    const j = await api('POST', `/api/sessions/${sessionId}/join`, { token: stranger.token, body: { code } });
    r.check(`«Я играю» с ${label} отклонено`, j.status === 404, `${j.status} ${j.json?.error}`);
  }
  const noCode = await api('POST', `/api/sessions/${sessionId}/join`, { token: stranger.token, body: {} });
  r.check('«Я играю» без кода — 400', noCode.status === 400, String(noCode.status));

  // 4. Гонка за места: 8 гостей одновременно, мест 3 (плательщик + 3 = 4).
  const crowd = await Promise.all(Array.from({ length: 8 }, () => login()));
  const joins = await Promise.all(crowd.map((u) => api('POST', `/api/sessions/${sessionId}/join`, { token: u.token, body: { code: CODE } })));
  const okJoins = joins.filter((x) => x.status === 200).length;
  const limited = joins.filter((x) => x.status === 409 || x.status === 400 || x.status === 422).length;
  const view = await ok(api('GET', `/api/sessions/${sessionId}`, { token: payer.token }));
  const players = view.participants?.length ?? view.session?.participants?.length ?? null;
  r.check('гонка 8 → ровно 3 принято', okJoins === 3, `принято ${okJoins}, отказано ${limited}`);
  r.check('в игре не больше 4 игроков (плательщик + 3)', players === 4, `participants=${players}`);
  r.check('отказ — код limit_exceeded', joins.filter((x) => x.status !== 200).every((x) => x.json?.error === 'limit_exceeded'), joins.filter((x) => x.status !== 200).map((x) => x.json?.error).join(','));

  // 5. Продление сверх предела: пятый (не участник) оплатить продление не может.
  const fifth = crowd[7];
  const e5 = await quote(fifth.token, { resource_id: g.t.resource.id, kind: 'extend', session_id: sessionId, minutes: 90 });
  r.check('пятый игрок: котировка продления — 403 (не участник)', e5.status === 403, `${e5.status} ${e5.json?.error}`);

  // 6. Повтор вебхука/оплаты: ещё раз «оплачено» тем же платежом — время не растёт.
  const before6 = (await ok(api('GET', `/api/sessions/${sessionId}`, { token: payer.token })));
  const paidUntil6 = before6.paid_until ?? before6.session?.paid_until;
  const wh = emuWebhook(g.pid, { repeat: 10 });
  // Подделанный вебхук: сумма и метаданные другие — сервер перепроверяет по API ЮKassa и не верит телу.
  const forged = emuWebhook(g.pid, { repeat: 3, override: { amount: { value: '1.00', currency: 'RUB' }, metadata: { quote_id: '00000000-0000-4000-8000-000000000000' } } });
  await sleep(1500);
  r.check('вебхук повторён 10+3 раза (доставлен)', wh.deliveries.length === 10 && forged.deliveries.length === 3, `${wh.deliveries.length}+${forged.deliveries.length}`);
  const after6 = (await ok(api('GET', `/api/sessions/${sessionId}`, { token: payer.token })));
  const paidUntil6b = after6.paid_until ?? after6.session?.paid_until;
  r.check('повтор вебхука: paid_until не изменился', paidUntil6 && paidUntil6 === paidUntil6b, `${paidUntil6} -> ${paidUntil6b}`);
  const s2 = await sim(101);
  r.check('повтор вебхука: на контроллере не больше 90 мин', s2.state.remaining_ms <= 90 * 60_000, `remaining_ms=${s2.state.remaining_ms}`);

  // 7. Повторная оплата той же котировки: used_at → 409/quote_used, а тот же ключ — тот же ответ.
  const again = await api('POST', `/api/quotes/${g.q.quote_id}/pay`, { token: payer.token, body: { method: 'sbp' }, idem: true });
  r.check('вторая оплата той же котировки (другой ключ) отклонена', again.status >= 400, `${again.status} ${again.json?.error}`);
} catch (e) {
  r.check(`сценарий не упал: ${e.message}`, false);
} finally {
  if (sessionId) {
    const st = await stopGame(payer, sessionId);
    console.log(`освобождение корта 101: stop → ${st.status}`);
    await waitFor(async () => (await sim(101)).state.relay === false, { timeoutMs: 15_000, what: 'свет 101 погас' }).catch((e) => console.log(e.message));
  }
  r.done();
}
