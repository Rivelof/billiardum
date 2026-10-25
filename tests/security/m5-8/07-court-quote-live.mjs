// PoC M5.8 / сценарий 7 — котировка корта на стенде: «Без лимита», баланс пакетов, граничные минуты, оплата балансом.
//
// Корт сида 101 (TESTC00001). Котировка на старт держит корт за гостем 3 минуты (pending), поэтому в конце
// PoC ждёт, пока корт снова станет свободным.
//
// ВАЖНО: на стенде включён DEV_ALLOW_ANY_MINUTES=1 (решение №54): любые минуты 1…1440 принимаются, поэтому
// «не кратно слоту» и «5 слотов» здесь НЕ проверяются — это доказано в 01-quote-slots.mjs на боевой
// конфигурации (devAllowAnyMinutes = false, как при NODE_ENV=production, server/lib/config.mjs:112).
// Здесь — то, что от флага не зависит.
//
// Запуск: node tests/security/m5-8/07-court-quote-live.mjs

import { COURT_CODES, login, ok, pay, quote, runner, tableByCode, waitFree } from './lib.mjs';

const r = runner('M5.8 / 7: котировка корта на стенде');
const CODE = COURT_CODES[101];
const g = await login();
try {
  await waitFree(CODE, g.token);
  const t = await ok(tableByCode(CODE, g.token));
  const RID = t.resource.id;
  r.check('GET /api/t/{код корта}: «Без лимита» не предлагается, варианты — слоты', t.options.every((x) => typeof x === 'number' && x % 90 === 0), JSON.stringify(t.options));
  r.check('карточка корта: family=court, billing=slot, max_players=4', t.resource.family === 'court' && t.resource.billing === 'slot' && t.resource.max_players === 4);

  const q = (body) => quote(g.token, { resource_id: RID, kind: 'start', ...body });
  const must400 = async (label, body) => {
    const x = await q(body);
    r.check(`${label} — 400`, x.status === 400, `${x.status} ${x.json?.error}`);
  };
  await must400('«Без лимита» (minutes: null)', { minutes: null });
  await must400('баланс пакетов (use_balance) на корте', { minutes: 90, use_balance: true });
  await must400('use_balance не булево', { minutes: 90, use_balance: 'yes' });
  await must400('minutes: 0', { minutes: 0 });
  await must400('minutes: −90', { minutes: -90 });
  await must400('minutes: 89.5', { minutes: 89.5 });
  await must400('minutes строкой', { minutes: '90' });
  await must400('minutes: 99999999', { minutes: 99_999_999 });
  await must400('minutes: Number.POSITIVE_INFINITY', { minutes: Number.POSITIVE_INFINITY });
  await must400('minutes не задано', {});

  // Допустимые слоты: сумма = k × цена слота окна.
  const one = await ok(q({ minutes: 90 }));
  r.check('1 слот: 90 минут, slots=1, цена в копейках — целое > 0', one.minutes === 90 && one.slots === 1 && Number.isSafeInteger(one.amount_kopecks) && one.amount_kopecks > 0, `${one.amount_kopecks}`);
  const four = await ok(q({ minutes: 360 }));
  r.check('4 слота: сумма = 4 × слот (в окне одной цены) или не меньше 4 × минимальной цены слота', four.slots === 4 && four.amount_kopecks >= 4 * 240000, `${four.amount_kopecks}`);
  r.check('котировка корта несёт slot_minutes и extend_limit_until', one.slot_minutes === 90 && 'extend_limit_until' in one);

  // Оплата балансом по котировке корта: баланса в котировке нет — отказ, ничего не списывается.
  const viaBalance = await pay(g.token, one.quote_id, 'balance');
  r.check('оплата корта методом balance — 400', viaBalance.status === 400, `${viaBalance.status} ${viaBalance.json?.error}`);
  // Метод оплаты вне списка и повтор котировки после попытки — по-прежнему слот.
  const weird = await pay(g.token, one.quote_id, 'cash');
  r.check('метод cash в pay — 400', weird.status === 400, `${weird.status} ${weird.json?.error}`);

  // Котировка на продление несуществующей/чужой сессии корта.
  const fake = await quote(g.token, { resource_id: RID, kind: 'extend', session_id: '00000000-0000-4000-8000-000000000000', minutes: 90 });
  r.check('продление несуществующей сессии корта — 404', fake.status === 404, `${fake.status} ${fake.json?.error}`);
  const noSession = await quote(g.token, { resource_id: RID, kind: 'extend', minutes: 90 });
  r.check('продление без session_id — 400', noSession.status === 400, `${noSession.status}`);
} catch (e) {
  r.check(`сценарий не упал: ${e.message}`, false);
} finally {
  // Освободить корт: удержание pending гостя снимается через 3 минуты (срок котировки).
  const release = await waitFree(CODE, g.token, 210_000).then(() => 'свободен', () => 'ещё удержан (сгорит сам)');
  console.log(`корт 101: ${release}`);
  r.done();
}
