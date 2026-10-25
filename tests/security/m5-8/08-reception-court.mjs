// PoC M5.8 / сценарий 8 — ресепшн: заявка на корт показывается как корт (не путается со столом
// с тем же номером), деньги не принимаются без смены/достаточной суммы, свет по заявке не включается.
//
// Гость оплачивает корт сида 102 «на ресепшене»; ресепшн сида (+70000000004) читает список заявок
// и отклоняет свою (причина guest_cancelled), деньги не принимаются. Запись в сиде — только это отклонение.
//
// Запуск: node tests/security/m5-8/08-reception-court.mjs

import { COURT_CODES, api, login, ok, pay, quote, runner, sim, tableByCode, waitFree } from './lib.mjs';

const r = runner('M5.8 / 8: заявка на корт у ресепшена');
const CLUB = 'c1000000-0000-4000-8000-000000000001';
const CODE = COURT_CODES[102];
const guest = await login();
const staff = await login('+70000000004', { consent: false });
let reqId = null;
try {
  await waitFree(CODE, guest.token);
  const t = await ok(tableByCode(CODE, guest.token));
  const RID = t.resource.id;
  const q = await ok(quote(guest.token, { resource_id: RID, kind: 'start', minutes: 180 }));
  const p = await pay(guest.token, q.quote_id, 'reception');
  r.check('гость: оплата «на ресепшене» создала заявку', p.status === 200, `${p.status} ${p.json?.error ?? ''}`);
  const list = await api('GET', `/api/clubs/${CLUB}/reception/requests`, { token: staff.token, headers: { 'x-club-id': CLUB } });
  r.check('ресепшн читает список заявок', list.status === 200, String(list.status));
  const items = Array.isArray(list.json) ? list.json : (list.json?.items ?? list.json?.requests ?? []);
  const mine = items.find((x) => x.resource_id === RID);
  reqId = mine?.id ?? null;
  r.check('заявка видна на экране ресепшена', Boolean(mine));
  r.check('заявка помечена как корт: resource_type=padel_court, family=court (не «стол 2»)', mine?.resource_type === 'padel_court' && mine?.resource_family === 'court', JSON.stringify(mine && { n: mine.resource_number, t: mine.resource_type, f: mine.resource_family, m: mine.minutes }));
  // billing и slot_minutes в списке заявок добавлены коммитом 01a7197 (после b4f1103): на старом стенде их нет.
  if ('billing' in (mine ?? {})) r.check('заявка несёт billing=slot и слот 90 (экран «2 слота по 90 минут»)', mine.billing === 'slot' && mine.slot_minutes === 90, `${mine.billing}/${mine.slot_minutes}`);
  else console.log('ПРИМЕЧАНИЕ: поля billing/slot_minutes в списке заявок есть в коде HEAD (01a7197), но не на этом стенде (b4f1103)');
  r.check('минуты заявки = 2 слота (180), сумма = котировке', mine?.minutes === 180 && mine?.amount_kopecks === q.amount_kopecks, `${mine?.minutes} / ${mine?.amount_kopecks} vs ${q.amount_kopecks}`);
  r.check('телефон гостя в списке маской', typeof mine?.guest_masked_phone === 'string' && /\*/.test(mine.guest_masked_phone) && !String(JSON.stringify(mine)).includes(guest.phone));

  // Свет до приёма денег не включается: корт 102 в режиме pending (белый), а не active.
  const s = await sim(102);
  r.check('до приёма денег свет корта не горит (реле выкл.)', s.state.relay === false && s.state.mode !== 'active', `mode=${s.state.mode} led=${s.state.led}`);

  // Гость сам «принять» не может; чужой гость заявку не видит и не отклоняет.
  const selfAccept = await api('POST', `/api/reception/requests/${reqId}/accept`, { token: guest.token, body: { method: 'cash', received_kopecks: q.amount_kopecks }, idem: true });
  r.check('гость сам принять заявку не может — 401/403', selfAccept.status === 401 || selfAccept.status === 403, `${selfAccept.status} ${selfAccept.json?.error}`);
  const other = await login();
  const otherDecline = await api('POST', `/api/reception/requests/${reqId}/decline`, { token: other.token, body: { reason_code: 'other' } });
  r.check('чужой гость отклонить заявку не может — 401/403/404', [401, 403, 404].includes(otherDecline.status), `${otherDecline.status} ${otherDecline.json?.error}`);
  const listAsGuest = await api('GET', `/api/clubs/${CLUB}/reception/requests`, { token: guest.token, headers: { 'x-club-id': CLUB } });
  r.check('гость список заявок клуба не читает — 401/403', listAsGuest.status === 401 || listAsGuest.status === 403, `${listAsGuest.status}`);

  // Ресепшн: наличных меньше суммы — отказ (сумма не режется под «слот поменьше»).
  const short = await api('POST', `/api/reception/requests/${reqId}/accept`, { token: staff.token, body: { method: 'cash', received_kopecks: q.amount_kopecks - 100 }, idem: true });
  r.check('приём наличных меньше суммы — 400', short.status === 400, `${short.status} ${short.json?.error}`);
  const s2 = await sim(102);
  r.check('после неудачного приёма свет по-прежнему не горит', s2.state.relay === false);
} catch (e) {
  r.check(`сценарий не упал: ${e.message}`, false);
} finally {
  if (reqId) {
    const d = await api('POST', `/api/reception/requests/${reqId}/decline`, { token: staff.token, body: { reason_code: 'guest_cancelled' } });
    console.log(`освобождение корта 102: отклонение заявки → ${d.status}`);
  }
  r.done();
}
