// T48 (тексты на сервере): слова «корт» / «стол» по виду ресурса в ответах API, которые видит человек:
// наклейка QR (PDF), тревога сервисного света, журнал, каталог сайта, QR-страница, названия ресурсов в клубе.
// docs/contracts/m5-5-8.md №203, decisions №213.
//
//   * наклейки (`qr-stickers.pdf`): у корта — «КОРТ N», у стола — «СТОЛ N», столы раньше кортов (pdftotext);
//   * сервисный свет на корте 102 клуба сида (ресепшн, причина): тревога «Корт 2: …», журнал `service.start` — корт;
//   * каталог (`/api/public/cities/…`): `tables_count` / `free_now` — только столы, `courts_count` / `courts_free_now` — корты;
//     с фильтром «падел» — только клубы с кортами, цена и «свободно» — по кортам;
//   * справочник видов: склонения «корт» (nom, gen, dat, acc, ins, pre) — ни одного «стол» в словах корта.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { api, auditOf, BASE, caPem, CLUB_SEED, COURTS, courtRule, login, makeClub, newGuest, rule, SEED_PHONES, short, sim, staffPhone, waitCourtFree, waitFor } from './lib.mjs';

const S = {};
const hasPdftotext = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }).status === 0 || spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }).stderr?.includes('pdftotext');

before(async () => {
  S.owner = await login(staffPhone());
  S.club = await makeClub(S.owner, { name: 'E2E M5.8 Тексты', kinds: ['pyramid', 'pool'], courts: 2, rules: [rule('06:00', '06:00', 600), courtRule('06:00', '06:00', 90, 2400)] });
  S.seedRec = await login(SEED_PHONES.reception);
  S.seedMan = await login(SEED_PHONES.manager);
  S.seedOwner = await login(SEED_PHONES.owner);
});

after(async () => {
  if (S.service) await api('POST', `/api/resources/${COURTS[102].id}/service/stop`, { token: S.seedRec.token, body: {} }).catch(() => {});
});

describe('T48. тексты по виду ресурса (сервер)', () => {
  it('наклейки QR: «СТОЛ N» у столов, «КОРТ N» у кортов, столы раньше кортов', { skip: !hasPdftotext && 'нет pdftotext' }, async (t) => {
    // PDF — бинарное тело: запрос через https с корнем CA стенда (lib.api отдаёт только текст).
    const https = await import('node:https');
    const buf = await new Promise((resolve, reject) => {
      https
        .get(new URL(`/api/clubs/${S.club.club}/qr-stickers.pdf`, BASE), { ca: caPem(), headers: { authorization: `Bearer ${S.owner.token}`, 'x-club-id': S.club.club } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`стикеры ${res.statusCode}`))));
        })
        .on('error', reject);
    });
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bl-e2e-m58-pdf-'));
    try {
      const file = path.join(dir, 's.pdf');
      writeFileSync(file, buf);
      const out = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
      assert.equal(out.status, 0, out.stderr);
      const txt = out.stdout;
      t.diagnostic(`текст наклеек: ${txt.replace(/\s+/g, ' ').slice(0, 300)}`);
      // Раскладка в две колонки: подписи «СТОЛ СТОЛ» и номера «1 2» идут отдельными строками.
      const labels = [...txt.matchAll(/СТОЛ|КОРТ/g)].map((m) => m[0]);
      assert.deepEqual(labels, ['СТОЛ', 'СТОЛ', 'КОРТ', 'КОРТ'], 'подписи: столы раньше кортов');
      assert.ok(!/КОРТ[\s\S]*СТОЛ/.test(txt), 'после первого «КОРТ» слова «СТОЛ» нет');
      assert.ok(txt.indexOf('СТОЛ') < txt.indexOf('КОРТ'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('справочник видов: склонения «корт» без «стол» и наоборот', async () => {
    const r = (await api('GET', '/api/resource-kinds')).json;
    for (const k of r.kinds) {
      const forms = Object.values(k.noun).join(' ');
      if (k.family === 'court') assert.ok(!/стол/i.test(forms) && /корт/.test(forms), `${k.kind}: ${forms}`);
      else assert.ok(!/корт/i.test(forms) && /стол/.test(forms), `${k.kind}: ${forms}`);
    }
    assert.deepEqual(r.kinds.filter((k) => k.family === 'court').map((k) => k.noun.pre), ['корте']);
  });

  it('названия ресурсов клуба: «Стол N» у столов, «Корт N» у кортов, в тех же ответах — журнал и список', async () => {
    const list = (await api('GET', `/api/clubs/${S.club.club}/resources`, { token: S.owner.token, club: S.club.club })).json.resources;
    for (const r of list) assert.match(r.title, r.family === 'court' ? /^Корт \d+$/ : /^Стол \d+$/);
    const j = await auditOf(S.club.club, S.owner.token, 'resource.create', 20);
    assert.equal(j.length, 4, `создание ресурсов в журнале: ${j.length}`);
    const names = j.map((x) => `${x.resource_type}:${x.resource_number}`);
    assert.ok(names.some((n) => n.startsWith('padel_court:')), names.join(','));
  });

  it('каталог: столы и корты считаются отдельно; фильтр «падел» — только клубы с кортами, свободно по кортам', async (t) => {
    const all = (await api('GET', '/api/public/cities/ekaterinburg')).json;
    const padel = (await api('GET', '/api/public/cities/ekaterinburg?disciplines=padel')).json;
    const seed = all.items.find((x) => x.club_id === CLUB_SEED);
    assert.ok(seed, 'клуб сида в каталоге');
    assert.deepEqual([seed.tables_count, seed.courts_count], [8, 2]);
    assert.ok(seed.free_now <= 8 && seed.courts_free_now <= 2, 'свободно: столы ≤ 8, корты ≤ 2');
    assert.equal(seed.slot_minutes, 90);
    assert.ok(seed.court_price_from_kopecks > 0 && seed.price_from_kopecks > 0);
    assert.ok(padel.items.length >= 1 && padel.items.every((x) => x.courts_count > 0), 'в фильтре «падел» только клубы с кортами');
    assert.ok(padel.items.every((x) => x.disciplines.includes('padel')));
    // Цена в фильтре «падел»: фильтр по цене корта (решение №221) — 2 400 ₽ за слот не проходит в 1 000 ₽.
    const cheap = (await api('GET', '/api/public/cities/ekaterinburg?disciplines=padel&price_max=100000')).json;
    assert.ok(!cheap.items.some((x) => x.club_id === CLUB_SEED), 'клуб с кортом 2 400 ₽ за слот не проходит по цене до 1 000 ₽');
    const wide = (await api('GET', '/api/public/cities/ekaterinburg?disciplines=padel&price_max=500000')).json;
    assert.ok(wide.items.some((x) => x.club_id === CLUB_SEED), 'по цене до 5 000 ₽ проходит');
    const sorted = (await api('GET', '/api/public/cities/ekaterinburg?disciplines=padel&sort=free')).json;
    assert.ok(sorted.items.length >= 1);
    assert.equal((await api('GET', '/api/public/cities/ekaterinburg?disciplines=curling')).status, 400, 'мусорная дисциплина');
    t.diagnostic(`клуб сида: столов ${seed.tables_count}/${seed.free_now}, кортов ${seed.courts_count}/${seed.courts_free_now}, слот ${seed.slot_minutes} мин, цена корта ${seed.court_price_from_kopecks / 100} ₽`);
  });

  it('сервисный свет на корте 102 (ресепшн, причина): тревога «Корт 2: …», журнал — корт, свет только на 102; стол 5 не тронут', async (t) => {
    await waitCourtFree(102, S.owner.token, 240_000);
    const table5 = (await sim(5)).state.mode;
    const res = await api('POST', `/api/resources/${COURTS[102].id}/service`, { token: S.seedRec.token, body: { minutes: 2, reason_code: 'cleaning', reason_text: 'e2e M5.8: проверка текстов' } });
    assert.equal(res.status, 200, short(res));
    S.service = true;
    const s = await waitFor(async () => {
      const x = await sim(102);
      return x.state.mode === 'service' && x.state.relay ? x : null;
    }, { what: 'сервисный свет корта 102', timeoutMs: 10_000 });
    assert.equal(s.state.led, 'purple');
    assert.equal((await sim(5)).state.mode, table5, 'стол 5 не тронут');
    const alarms = (await api('GET', `/api/clubs/${CLUB_SEED}/alarms?state=open`, { token: S.seedOwner.token, club: CLUB_SEED })).json;
    const mine = alarms.find((a) => a.type === 'service_light' && a.resource_id === COURTS[102].id);
    assert.ok(mine, `тревога сервисного света на корте: ${JSON.stringify(alarms.map((a) => a.text))}`);
    t.diagnostic(`тревога: «${mine.text}»; resource_number=${mine.resource_number}, resource_type=${mine.resource_type}`);
    assert.match(mine.text, /^Корт 2:/);
    assert.doesNotMatch(mine.text, /[Сс]тол/);
    assert.equal(mine.resource_type, 'padel_court');
    const jr = await auditOf(CLUB_SEED, S.seedOwner.token, 'service.*', 10);
    const entry = jr.find((x) => x.resource_id === COURTS[102].id);
    assert.ok(entry && entry.resource_type === 'padel_court' && entry.resource_number === 2, JSON.stringify(entry?.data));
    assert.ok(entry.reason, 'причина записана');
    // Гостю корт показан как «обслуживание», не «стол».
    const g = await newGuest();
    const view = (await api('GET', `/api/t/${COURTS[102].code}`, { token: g.token })).json;
    t.diagnostic(`гость у корта на сервисе: status=${view.status}`);
    assert.equal(view.status, 'service');
    const stop = await api('POST', `/api/resources/${COURTS[102].id}/service/stop`, { token: S.seedRec.token, body: {} });
    assert.equal(stop.status, 200, short(stop));
    S.service = false;
    await waitFor(async () => ((await sim(102)).state.mode === 'free' ? true : null), { what: 'корт 102 свободен', timeoutMs: 10_000 });
    await api('POST', `/api/alarms/${mine.id}/ack`, { token: S.seedMan.token, body: {} });
  });
});
