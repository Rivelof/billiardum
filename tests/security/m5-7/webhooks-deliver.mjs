// PoC M5.7, часть 2: доставка вебхуков без стенда и без базы (pentester).
//
// Запуск из корня репозитория:  node tests/security/m5-7/webhooks-deliver.mjs
// Всё локально: приёмник HTTPS на 127.0.0.1 с самоподписанным сертификатом, подменный DNS, база —
// заглушка в памяти. Ни одного запроса наружу (DNS — только подменный).
// Строка «ОК» — защита выдержала, «FAIL» — находка. Код возврата — число FAIL.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import https from 'node:https';
import { createDeliveryWorker, deliveryHeaders, httpsSend, notifyFailing, RETRY_WINDOW_MS } from '../../../server/clubapi/deliver.mjs';
import { checkUrlSyntax, isPublicAddress, validateWebhookUrl } from '../../../server/clubapi/ssrf.mjs';
import { gameId, gamePepper, newSecret, secretContext } from '../../../server/clubapi/webhooks.mjs';
import { encryptSecret } from '../../../server/lib/secrets.mjs';
import { fakeLookup, HOOK_HOST, selfSigned, startReceiver } from '../../../server/clubapi/test/helpers.mjs';

let FAILS = 0;
const ok = (m) => console.log(`  ОК   ${m}`);
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  FAILS += 1;
};
const check = (cond, m, detail = '') => (cond ? ok(m) : bad(`${m}${detail ? `: ${detail}` : ''}`));
const allowLocal = (ip) => ip === '127.0.0.1' || isPublicAddress(ip);
const codeOf = async (p) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e.code ?? 'error';
  }
};

// Проверка подписи — дословно пример из docs/api/club-api-v1.md («Проверка подписи», Node.js).
function docVerify(SECRET, headers, rawBody, nowMs = Date.now()) {
  const t = headers['x-bl-timestamp'];
  const sig = String(headers['x-bl-signature'] ?? '');
  if (!/^\d+$/.test(t ?? '') || Math.abs(nowMs / 1000 - Number(t)) > 300) return false;
  const expected = `v1=${createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex')}`;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

console.log('### 1. Адрес: синтаксис и DNS (без сети) ###');
{
  const syn = (u) => {
    try {
      checkUrlSyntax(u);
      return 'ok';
    } catch (e) {
      return e.code;
    }
  };
  const blocked = [
    'https://127.0.0.1/', 'https://10.0.0.1/', 'https://172.16.0.1/', 'https://172.31.255.254/', 'https://192.168.1.1/', 'https://169.254.169.254/',
    'https://0.0.0.0/', 'https://0/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[fd00::1]/', 'https://[64:ff9b::7f00:1]/',
    'https://[2002:7f00:1::1]/', 'https://2130706433/', 'https://017700000001/', 'https://0x7f000001/', 'https://0x7f.0.0.1/', 'https://127.1/',
    'https://%31%32%37.0.0.1/', 'https://１２７.０.０.１/', 'https://0xA9.0xFE.0xA9.0xFE/', 'https://3232235521/',
    'https://server/', 'https://db/', 'https://mosquitto/', 'https://caddy/', 'https://localhost/', 'https://localhost./', 'https://x.localhost/',
    'http://hooks.example.ru/', 'https://hooks.example.ru:8443/', 'https://u:p@hooks.example.ru/', 'https://127.0.0.1\\@hooks.example.ru/',
    'https://hooks.example.ru@127.0.0.1/',
  ];
  const wrong = blocked.filter((u) => syn(u) === 'ok');
  check(wrong.length === 0, `${blocked.length} внутренних и кривых адресов отклонены синтаксисом`, wrong.join(' '));
  check(syn('https://hooks.example.ru:443/x?y=1') === 'ok', 'обычный адрес https на 443 принят');

  // Имя → смесь публичного и внутреннего; только внутренний; IPv4 внутри IPv6; пусто.
  const cases = [
    [['93.184.216.34', '10.0.0.5'], 'url_forbidden'],
    [['::ffff:192.168.0.1'], 'url_forbidden'],
    [['64:ff9b::a9fe:a9fe'], 'url_forbidden'],
    [['2a00:1450:4010:c05::64', 'fe80::1'], 'url_forbidden'],
    [[], 'url_invalid'],
  ];
  for (const [ips, want] of cases) {
    const got = await codeOf(validateWebhookUrl(`https://${HOOK_HOST}/`, { lookup: fakeLookup({ [HOOK_HOST]: ips }) }));
    check(got === want, `регистрация: имя → [${ips.join(', ')}] → ${want}`, `получили ${got}`);
  }
}

console.log('### 2. Соединение: проверка IP при каждой доставке, редиректы, таймаут ###');
{
  const rx = await startReceiver({ replies: [200] });
  try {
    // Регистрация видела публичный адрес; при доставке имя отдаёт [публичный, 127.0.0.1] (rebinding со смесью).
    let n = 0;
    const lookup = fakeLookup(() => (++n === 1 ? ['93.184.216.34'] : ['93.184.216.34', '127.0.0.1']));
    await validateWebhookUrl(`https://${HOOK_HOST}/`, { lookup });
    const c0 = rx.connections;
    const got = await codeOf(httpsSend({ url: `https://${HOOK_HOST}:${rx.port}/`, body: '{}', headers: {}, ports: [rx.port], ca: rx.cert, lookup }));
    check(got === 'url_forbidden' && rx.connections === c0, 'rebinding [публичный, 127.0.0.1] при доставке — отказ, соединения нет', `код ${got}, соединений +${rx.connections - c0}`);
    // Только IPv6-формы локального адреса.
    for (const ip of ['::ffff:127.0.0.1', '::1', '64:ff9b::7f00:1']) {
      const g = await codeOf(httpsSend({ url: `https://${HOOK_HOST}:${rx.port}/`, body: '{}', headers: {}, ports: [rx.port], ca: rx.cert, lookup: fakeLookup({ [HOOK_HOST]: [ip] }) }));
      check(g === 'url_forbidden', `имя → ${ip} при доставке — отказ`, g);
    }
    // Порт: даже если в базе окажется адрес с другим портом — доставка с портами по умолчанию откажет.
    const gp = await codeOf(httpsSend({ url: `https://${HOOK_HOST}:${rx.port}/`, body: '{}', headers: {}, ca: rx.cert, lookup: fakeLookup({ [HOOK_HOST]: ['93.184.216.34'] }) }));
    check(gp === 'url_invalid', 'адрес с портом не 443 — отказ и при доставке', gp);
  } finally {
    await rx.close();
  }
  for (const st of [301, 307, 308]) {
    const r = await startReceiver({ replies: [st], redirectTo: 'https://169.254.169.254/latest/meta-data/' });
    try {
      const g = await codeOf(httpsSend({ url: `https://${HOOK_HOST}:${r.port}/`, body: '{}', headers: {}, ports: [r.port], ca: r.cert, lookup: fakeLookup({ [HOOK_HOST]: ['127.0.0.1'] }), isAllowed: allowLocal }));
      check(g === 'redirect' && r.requests.length === 1, `ответ ${st} → редирект не выполнен, один запрос`, `${g}, запросов ${r.requests.length}`);
    } finally {
      await r.close();
    }
  }
  // Медленный приёмник: заголовки не приходят — обрыв по таймауту.
  const tls = selfSigned();
  const slow = https.createServer(tls, () => {});
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  const g = await codeOf(httpsSend({ url: `https://${HOOK_HOST}:${slow.address().port}/`, body: '{}', headers: {}, ports: [slow.address().port], ca: tls.cert, lookup: fakeLookup({ [HOOK_HOST]: ['127.0.0.1'] }), isAllowed: allowLocal, timeoutMs: 500 }));
  check(g === 'timeout' && Date.now() - t0 < 3000, 'приёмник молчит — таймаут, соединение закрыто', `${g} за ${Date.now() - t0} мс`);
  slow.closeAllConnections?.();
  slow.close();
}

console.log('### 3. Подпись по документации, повтор старой доставки ###');
{
  const rx = await startReceiver({ replies: [200] });
  try {
    const secret = newSecret();
    const body = JSON.stringify({ id: randomUUID(), type: 'ping', created_at: new Date().toISOString(), club_id: randomUUID(), test: true, data: { webhook_id: randomUUID() } });
    const ts = Math.floor(Date.now() / 1000);
    const headers = deliveryHeaders({ secret, timestamp: ts, body, event: 'ping', eventId: randomUUID(), deliveryId: randomUUID() });
    await httpsSend({ url: `https://${HOOK_HOST}:${rx.port}/in`, body, headers, ports: [rx.port], ca: rx.cert, lookup: fakeLookup({ [HOOK_HOST]: ['127.0.0.1'] }), isAllowed: allowLocal });
    const got = rx.requests.at(-1);
    check(got && got.body === body, 'приёмник получил тело байт в байт');
    check(docVerify(secret, got.headers, got.body), 'подпись сходится с примером из документации (HMAC-SHA256 `t.body`, секрет целиком с whsec_)');
    check(!docVerify(secret, got.headers, got.body.replace('"ping"', '"pong"')), 'изменённое тело — подпись не сходится');
    check(!docVerify(secret, { ...got.headers, 'x-bl-timestamp': String(ts + 1) }, got.body), 'подменённый X-Bl-Timestamp — подпись не сходится');
    check(!docVerify(newSecret(), got.headers, got.body), 'чужой секрет — подпись не сходится');
    check(!docVerify(secret, got.headers, got.body, (ts + 301) * 1000), 'повтор той же доставки через 5 минут — отклонён по X-Bl-Timestamp');
    check(docVerify(secret, got.headers, got.body, (ts + 120) * 1000), 'повтор в пределах 5 минут подпись проходит — от дубля спасает только X-Bl-Event-Id (как и советует документация)');
    check(!Object.values(got.headers).some((v) => String(v).includes(secret)), 'секрет не уходит в заголовках');
  } finally {
    await rx.close();
  }
}

console.log('### 4. game_id не обращается в session_id ###');
{
  const key = randomBytes(32);
  const pepper = gamePepper(key);
  const club = randomUUID();
  const sid = randomUUID();
  const g = gameId(pepper, club, sid);
  const g2 = gameId(gamePepper(randomBytes(32)), club, sid);
  const plain = createHmac('sha256', Buffer.alloc(0)).update(`${club}:${sid}`).digest('hex').slice(0, 32);
  check(g !== sid && !g.replace(/-/g, '').includes(sid.replace(/-/g, '').slice(0, 8)), 'game_id не содержит session_id');
  check(g !== g2, 'без ключа шифрования (перец из encKey) game_id не воспроизвести');
  check(g.replace(/-/g, '') !== plain, 'game_id — не HMAC с пустым ключом');
  check(gameId(pepper, randomUUID(), sid) !== g, 'в другом клубе та же сессия даёт другой game_id');
}

console.log('### 5. Повторы до failed и уведомление владельцу (воркер, база-заглушка) ###');
{
  const rx = await startReceiver({ replies: [500] });
  const encKey = randomBytes(32);
  const webhookId = randomUUID();
  const clubId = randomUUID();
  const secret = newSecret();
  const created = new Date('2026-10-24T10:00:00.000Z');
  let now = new Date(created);
  const delivery = { id: randomUUID(), club_id: clubId, webhook_id: webhookId, event_id: randomUUID(), event: 'ping', payload: { id: 'e', type: 'ping', data: {} }, attempts: 0, created_at: created, status: 'pending', next_attempt_at: created, claimed_until: null };
  const hook = { id: webhookId, url: `https://${HOOK_HOST}:${rx.port}/in?token=rcv-secret-path`, secret_enc: encryptSecret(secret, encKey, secretContext(webhookId)), disabled_at: null, failure_notified_at: null };
  const notified = [];
  const logs = [];
  const db = {
    async query(sql, p = []) {
      if (sql.includes('with due as')) {
        const d = delivery;
        if (d.status === 'pending' && d.next_attempt_at <= p[0] && (!d.claimed_until || d.claimed_until <= p[0])) {
          d.claimed_until = p[2];
          return { rows: [{ ...d }] };
        }
        return { rows: [] };
      }
      if (sql.includes('from bl.webhooks where id = any')) return { rows: [{ ...hook }] };
      if (sql.includes('insert into bl.webhook_attempts')) return { rows: [], rowCount: 1 };
      if (sql.includes('update bl.webhook_deliveries set attempts')) {
        Object.assign(delivery, { attempts: p[1], status: p[2], next_attempt_at: p[7] ?? delivery.next_attempt_at, claimed_until: null });
        return { rowCount: 1 };
      }
      if (sql.includes('update bl.webhooks w set failure_notified_at')) {
        if (hook.failure_notified_at && hook.failure_notified_at > p[3]) return { rows: [] };
        hook.failure_notified_at = p[2];
        notified.push(p[2]);
        return { rows: [{ url: hook.url, timezone: 'Europe/Moscow', since: created }] };
      }
      if (sql.includes('from bl.club_members')) return { rows: [] };
      if (sql.includes('delete from bl.webhook_deliveries')) return { rowCount: 0 };
      throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
    },
  };
  const send = (a) => httpsSend({ ...a, ports: [rx.port], ca: rx.cert, lookup: fakeLookup({ [HOOK_HOST]: ['127.0.0.1'] }), isAllowed: allowLocal });
  const log = { info: (e, d) => logs.push([e, d]), error: (e, d) => logs.push([e, d]) };
  const worker = createDeliveryWorker({ pool: {}, log, clock: { now: () => now }, encKey, withContext: (_pool, _c, fn) => fn(db), send, pollMs: 0 });
  const times = [];
  for (let i = 0; i < 20 && delivery.status === 'pending'; i++) {
    now = new Date(delivery.next_attempt_at);
    times.push(Math.round((now - created) / 60_000));
    await worker.tick();
  }
  check(delivery.status === 'failed', `после ${delivery.attempts} попыток — failed`, delivery.status);
  check(JSON.stringify(times) === JSON.stringify([0, 1, 6, 21, 51, 111, 231, 471, 951, 1440]), `попытки на минутах ${times.join(', ')} (последняя ровно через 24 ч)`);
  check(rx.requests.length === times.length && rx.requests.every((r) => docVerify(secret, r.headers, r.body, Number(r.headers['x-bl-timestamp']) * 1000)), 'каждый повтор подписан заново со своим временем');
  check(new Set(rx.requests.map((r) => r.headers['x-bl-event-id'])).size === 1, 'X-Bl-Event-Id одинаковый во всех повторах');
  check(notified.length === 1, 'владелец уведомлён один раз', `${notified.length}`);
  check(!JSON.stringify(logs).includes('rcv-secret-path') && !JSON.stringify(logs).includes(secret), 'в логе воркера нет адреса с токеном и секрета');
  check(now - created <= RETRY_WINDOW_MS, 'повторы не выходят за 24 часа');

  // Второй failed того же адреса через час — без второго уведомления; через сутки — снова.
  const msgs = [];
  const capture = async (_db, _club, roles, msg) => msgs.push({ roles, msg });
  hook.failure_notified_at = now;
  const n1 = await notifyFailing(db, { clubId, webhookId, deliveryId: delivery.id, now: new Date(now.getTime() + 3600_000), send: capture });
  const n2 = await notifyFailing(db, { clubId, webhookId, deliveryId: delivery.id, now: new Date(now.getTime() + 25 * 3600_000), send: capture });
  check(n1 === false && n2 === true && msgs.length === 1, 'повторное уведомление — не раньше чем через сутки');
  const text = JSON.stringify(msgs[0] ?? {});
  check(msgs[0]?.roles?.join() === 'owner' && text.includes(HOOK_HOST) && !text.includes('rcv-secret-path') && !text.includes(secret), 'уведомление — владельцу, только хост, без пути с токеном и секрета');
  await rx.close();
}

console.log(`\nИтого FAIL: ${FAILS}`);
process.exit(FAILS);
