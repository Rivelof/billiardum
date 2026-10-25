// PoC M5.5 — шаблон тарифов сети (№191, №163, инвариант 8).
// Проверяем: цена <= 0 / дробная / строка / огромная; дыры и пересечения недели; применение в двух
// клубах с разными поясами; мягкий режим (переопределение), жёсткий (409 network_locked на прямой
// PUT тарифов клуба); принудительный возврат клубов при переходе сети в жёсткий режим; чужая сеть.
//
// Режим live (причина обязательна) на стенде не проверяется: перевод клуба в live требует магазина
// ЮKassa, контроллеров и ККТ (чек-лист №160). Покрыт кодом (templates.mjs reasonFor/cleanReason) и
// существующими тестами server/networks/test/db/networks.test.mjs (reason_required) — см. REPORT.md.
//
// Запуск: node tests/security/m5-5/04-tariff-template.test.mjs

import { addClub, api, check, createClub, createNetwork, login, phone, RUN, summary } from './_helpers.mjs';

const results = [];

const rule = (price, o = {}) => ({ kind: null, days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '06:00', price_per_hour_kopecks: price, min_minutes: 30, step_minutes: 1, ...o });

const A = await login(phone());
const B = await login(phone());
const clubEkb = await createClub(A.token, { name: `EKB ${RUN}`, timezone: 'Asia/Yekaterinburg' });
const clubKgd = await createClub(A.token, { name: `KGD ${RUN}`, timezone: 'Europe/Kaliningrad', city: 'Калининград' });
const NA = await createNetwork(A.token, `NT ${RUN}`);
await addClub(A.token, NA, clubEkb);
await addClub(A.token, NA, clubKgd);

const put = (token, rules, extra = {}) => api('PUT', `/api/networks/${NA}/tariffs`, { token, body: { rules, ...extra } });

// 1. Цена: 0, отрицательная, дробная, строка, больше максимума, null — всё 400.
{
  const bads = { zero: 0, negative: -100, fractional: 100.5, string: '100', huge: 100_000_001, nul: null, nan: 'NaN' };
  const bad = [];
  for (const [k, v] of Object.entries(bads)) {
    const r = await put(A.token, [rule(v)]);
    if (r.status !== 400) bad.push(`${k}=${r.status}`);
  }
  check(results, 'шаблон тарифа: цена 0/минус/дробь/строка/огромная/null → 400', bad.length === 0, bad.join(', ') || 'все 400');
  // Шаблон не должен был записаться.
  const g = await api('GET', `/api/networks/${NA}/tariffs`, { token: A.token });
  check(results, 'после отказов шаблон не создан', g.json?.rules?.length === 0, `rules=${g.json?.rules?.length} version=${g.json?.version}`);
}

// 2. Минимум/шаг вне диапазона, неизвестный вид, пустой список, слишком много правил.
{
  const cases = {
    min_negative: [rule(10000, { min_minutes: -1 })],
    min_huge: [rule(10000, { min_minutes: 100000 })],
    step_zero: [rule(10000, { step_minutes: 0 })],
    step_61: [rule(10000, { step_minutes: 61 })],
    kind_unknown: [rule(10000, { kind: 'bowling' })],
    empty: [],
    days_dup: [rule(10000, { days: [1, 1] })],
    days_8: [rule(10000, { days: [8] })],
    time_bad: [rule(10000, { from: '25:00' })],
    padel_zero: [{ kind: 'padel_court', days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '06:00', slot_minutes: 90, price_per_slot_kopecks: 0 }],
    padel_slot_45: [{ kind: 'padel_court', days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '06:00', slot_minutes: 45, price_per_slot_kopecks: 1000 }],
    padel_neg: [{ kind: 'padel_court', days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '06:00', slot_minutes: 90, price_per_slot_kopecks: -5 }],
  };
  const bad = [];
  for (const [k, rules] of Object.entries(cases)) {
    const r = await put(A.token, rules);
    if (r.status !== 400) bad.push(`${k}=${r.status}`);
  }
  check(results, 'шаблон тарифа: прочие неверные формы → 400', bad.length === 0, bad.join(', ') || 'все 400');
}

// 3. Дыра и пересечение недели — 400 с club_id.
{
  const gap = await put(A.token, [rule(10000, { from: '06:00', to: '18:00' })]);
  check(results, 'дыра в неделе → 400 tariff_gap {club_id}', gap.status === 400 && gap.json?.error === 'tariff_gap' && Boolean(gap.json?.club_id), `status=${gap.status} ${JSON.stringify(gap.json)}`);
  const over = await put(A.token, [rule(10000), rule(20000, { from: '10:00', to: '12:00' })]);
  check(results, 'пересечение → 400 tariff_overlap {club_id}', over.status === 400 && over.json?.error === 'tariff_overlap' && Boolean(over.json?.club_id), `status=${over.status} ${JSON.stringify(over.json)}`);
  const g = await api('GET', `/api/networks/${NA}/tariffs`, { token: A.token });
  check(results, 'после отказов тарифы клубов не менялись (шаблона нет)', g.json?.template === false, `template=${g.json?.template}`);
}

// 4. Корректный шаблон применяется в обоих поясах: локальные границы одинаковы, цена одна.
{
  const ok = await put(A.token, [rule(15000, { from: '06:00', to: '18:00' }), rule(25000, { from: '18:00', to: '06:00' })]);
  check(results, 'корректный шаблон (день/вечер) → 200', ok.status === 200 && ok.json?.template === true, `status=${ok.status}`);
  const e = await api('GET', `/api/clubs/${clubEkb}/tariffs`, { token: A.token });
  const k = await api('GET', `/api/clubs/${clubKgd}/tariffs`, { token: A.token });
  const sig = (j) => JSON.stringify((j.rules ?? []).map((r) => [r.from, r.to, r.price_per_hour_kopecks, r.min_minutes, r.step_minutes]).sort());
  check(results, 'EKB и KGD: одинаковые локальные границы и цены', e.status === 200 && k.status === 200 && sig(e.json) === sig(k.json) && (e.json.rules ?? []).length > 0, `ekb=${sig(e.json)} kgd=${sig(k.json)}`);
  check(results, 'пояса клубов сохранены разными', e.json?.timezone === 'Asia/Yekaterinburg' && k.json?.timezone === 'Europe/Kaliningrad', `${e.json?.timezone} / ${k.json?.timezone}`);
  check(results, 'покрытие недели без дыр в обоих', e.json?.coverage?.ok === true && k.json?.coverage?.ok === true, `ekb=${e.json?.coverage?.ok} kgd=${k.json?.coverage?.ok}`);
}

// 5. Мягкий режим: клуб переопределяет, цена клуба тоже > 0, шаблон его больше не меняет.
{
  const zero = await api('PUT', `/api/clubs/${clubEkb}/tariffs`, { token: A.token, body: { rules: [rule(0)] } });
  check(results, 'мягкий режим: клуб ставит цену 0 → 400', zero.status === 400, `status=${zero.status}`);
  const own = await api('PUT', `/api/clubs/${clubEkb}/tariffs`, { token: A.token, body: { rules: [rule(9000)] } });
  check(results, 'мягкий режим: клуб переопределяет своей ценой → 200', own.status === 200, `status=${own.status}`);
  const net = await api('GET', `/api/clubs/${clubEkb}/network`, { token: A.token });
  check(results, 'клуб помечен переопределившим (override=true)', net.json?.network?.tariffs?.override === true, `override=${net.json?.network?.tariffs?.override}`);
  const v2 = await put(A.token, [rule(17000)]);
  const e = await api('GET', `/api/clubs/${clubEkb}/tariffs`, { token: A.token });
  const k = await api('GET', `/api/clubs/${clubKgd}/tariffs`, { token: A.token });
  check(results, 'шаблон v2: переопределивший клуб (EKB) не тронут', e.json?.rules?.[0]?.price_per_hour_kopecks === 9000, `ekb=${e.json?.rules?.[0]?.price_per_hour_kopecks}`);
  check(results, 'шаблон v2: непереопределивший клуб (KGD) обновлён', v2.status === 200 && k.json?.rules?.[0]?.price_per_hour_kopecks === 17000, `kgd=${k.json?.rules?.[0]?.price_per_hour_kopecks}`);
}

// 6. Переход сети в жёсткий режим возвращает клубы к шаблону; затем прямой PUT клуба — 409.
{
  const hard = await api('PATCH', `/api/networks/${NA}`, { token: A.token, body: { tariffs_mode: 'hard' } });
  check(results, 'PATCH tariffs_mode=hard → 200', hard.status === 200, `status=${hard.status} ${hard.text.slice(0, 120)}`);
  const e = await api('GET', `/api/clubs/${clubEkb}/tariffs`, { token: A.token });
  check(results, 'жёсткий режим: переопределивший клуб возвращён к шаблону', e.json?.rules?.[0]?.price_per_hour_kopecks === 17000, `ekb=${e.json?.rules?.[0]?.price_per_hour_kopecks}`);
  const direct = await api('PUT', `/api/clubs/${clubEkb}/tariffs`, { token: A.token, body: { rules: [rule(5000)] } });
  check(results, 'жёсткий режим: прямой PUT тарифов клуба → 409 network_locked', direct.status === 409 && direct.json?.error === 'network_locked', `status=${direct.status} ${direct.json?.error ?? ''}`);
  const direct2 = await api('PUT', `/api/clubs/${clubKgd}/tariffs`, { token: A.token, body: { rules: [rule(5000)] } });
  check(results, 'жёсткий режим: прямой PUT во втором клубе → 409', direct2.status === 409, `status=${direct2.status}`);
  const e2 = await api('GET', `/api/clubs/${clubEkb}/tariffs`, { token: A.token });
  check(results, 'после отказов тариф клуба = шаблон', e2.json?.rules?.[0]?.price_per_hour_kopecks === 17000, `ekb=${e2.json?.rules?.[0]?.price_per_hour_kopecks}`);
}

// 7. Чужой владелец не меняет шаблон и не читает его.
{
  const p = await api('PUT', `/api/networks/${NA}/tariffs`, { token: B.token, body: { rules: [rule(5000)] } });
  const g = await api('GET', `/api/networks/${NA}/tariffs`, { token: B.token });
  const d = await api('DELETE', `/api/networks/${NA}/tariffs`, { token: B.token });
  check(results, 'чужой владелец: PUT/GET/DELETE шаблона тарифов → 404', p.status === 404 && g.status === 404 && d.status === 404, `${p.status}/${g.status}/${d.status}`);
}

// 8. Тарифный шаблон снят: тарифы клубов остаются, прямой PUT снова доступен.
{
  const del = await api('DELETE', `/api/networks/${NA}/tariffs`, { token: A.token });
  const own = await api('PUT', `/api/clubs/${clubEkb}/tariffs`, { token: A.token, body: { rules: [rule(12000)] } });
  check(results, 'шаблон снят → клуб снова правит тарифы сам', del.status === 200 && own.status === 200, `del=${del.status} own=${own.status}`);
}

process.exit(summary(results).length ? 1 : 0);
