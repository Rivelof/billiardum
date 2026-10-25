// PoC M5.8 / сценарий 9 — тексты денег для корта: описание платежа ЮKassa и позиция чека.
//
// Гость оплачивает корт сида 101 по СБП; PoC читает у эмулятора ЮKassa описание созданного платежа и,
// если чек уже есть, позицию чека. Платёж в конце отменяется (корт освобождается, игра не начинается).
// Находка Н-3: описание платежа корта — «Стол 1, …» (server/payments/pay.mjs:165), хотя чек говорит «корт».
//
// Запуск: node tests/security/m5-8/09-payment-labels.mjs

import { COURT_CODES, emu, emuPayment, login, ok, pay, providerId, quote, runner, tableByCode, waitFree } from './lib.mjs';

const r = runner('M5.8 / 9: тексты платежа корта');
const CODE = COURT_CODES[101];
const g = await login();
let pid = null;
try {
  await waitFree(CODE, g.token);
  const t = await ok(tableByCode(CODE, g.token));
  const q = await ok(quote(g.token, { resource_id: t.resource.id, kind: 'start', minutes: 90 }));
  const p = await ok(pay(g.token, q.quote_id, 'sbp'));
  pid = providerId(p);
  const remote = emuPayment(pid);
  console.log(`описание платежа в ЮKassa: «${remote.description}» (${remote.amount.value} ₽)`);
  r.check('платёж создан на цену слота корта', remote.amount.value === (q.amount_kopecks / 100).toFixed(2), remote.amount.value);
  r.finding('описание платежа корта называет ресурс «Стол»', /^Стол\s/.test(remote.description), remote.description);
  const items = (remote.receipt?.items ?? []).map((i) => i.description);
  if (items.length) r.check('позиция чека называет «корт»', items.every((d) => /корт/.test(d)), items.join(' | '));
  else console.log('ПРИМЕЧАНИЕ: эмулятор не отдаёт позиции чека в карточке платежа — текст чека проверен по коду (receipt.mjs:11)');
} catch (e) {
  r.check(`сценарий не упал: ${e.message}`, false);
} finally {
  if (pid) {
    try {
      emu(`/__emu/payments/${pid}/cancel`, { post: true });
    } catch (e) {
      console.log(`отмена платежа: ${e.message}`);
    }
    await waitFree(CODE, g.token, 60_000).then(() => console.log('корт 101 свободен'), () => console.log('корт 101 ещё удержан (сгорит сам)'));
  }
  r.done();
}
