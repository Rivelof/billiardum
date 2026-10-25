// Хелперы PoC безопасности M5.5 «Сети». Поверх tests/e2e/m1/helpers.mjs (API через Caddy на
// https://localhost:8443, вход для разработки). Атакуем только локальный стенд: свои телефоны
// +7999673xxxx, свои новые тестовые клубы. Базу стенда, .env и секреты не трогаем.

import { api, ok } from '../../e2e/m1/helpers.mjs';
export { api, ok };

/** Уникальный суффикс прогона, чтобы телефоны и имена не сталкивались между запусками. */
export const RUN = `${Date.now() % 1_000_000}`;

let seq = 0;
const BASE_N = Math.floor(Date.now() / 1000) % 9000; // разный у каждого прогона, чтобы не упираться в лимит клубов
/** Телефон из разрешённого диапазона +7999673xxxx (4 цифры в конце). */
export function phone() {
  seq += 1;
  return `+7999673${String(1000 + ((BASE_N + seq) % 9000)).padStart(4, '0')}`;
}

/** Заход 2 (повторная проверка после bc51e24): телефон из диапазона +7999676xxxx. */
export function phone2() {
  seq += 1;
  return `+7999676${String(1000 + ((BASE_N + seq * 7) % 9000)).padStart(4, '0')}`;
}

/** Вход для разработки с паузой на 429 (лимит 30/мин). → { token, user, phone } */
export async function login(p, { tries = 6 } = {}) {
  for (let i = 0; ; i += 1) {
    const r = await api('POST', '/api/auth/dev', { body: { phone: p } });
    if (r.status === 200) {
      const token = r.json.token;
      // Согласие (на всякий случай для requires:['consent']).
      const me = await api('GET', '/api/me', { token });
      if (me.status === 200 && me.json.user && !me.json.user.consent_version && me.json.user.consent?.version) {
        await api('POST', '/api/auth/consent', { token, body: { version: me.json.user.consent.version } });
      }
      return { token, user: r.json.user, phone: p };
    }
    if (r.status !== 429 || i >= tries) throw new Error(`login ${p}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
    await sleep(2100);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Создать тестовый клуб владельцем (token). → club_id */
export async function createClub(token, { name, timezone = 'Asia/Yekaterinburg', city = 'Екатеринбург' } = {}) {
  const r = await api('POST', '/api/clubs', { token, body: { name: name ?? `PoC ${RUN} ${timezone}`, city_name: city, timezone } });
  if (r.status !== 201) throw new Error(`createClub: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.club_id;
}

/** Создать сеть. → network_id (или бросает). */
export async function createNetwork(token, name) {
  const r = await api('POST', '/api/networks', { token, body: { name } });
  if (r.status !== 201) throw new Error(`createNetwork: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.id;
}

export async function addClub(token, networkId, clubId) {
  return api('POST', `/api/networks/${networkId}/clubs`, { token, body: { club_id: clubId } });
}

/** Утверждение; возвращает текст PASS/FAIL для отчёта (не бросает, чтобы прогон шёл до конца). */
export function check(results, name, condition, detail = '') {
  const passed = Boolean(condition);
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return passed;
}

export function summary(results) {
  const failed = results.filter((r) => !r.passed);
  console.log(`\n== ${results.length - failed.length}/${results.length} PASS ==`);
  if (failed.length) {
    console.log('FAILED:', failed.map((r) => r.name).join('; '));
  }
  return failed;
}
