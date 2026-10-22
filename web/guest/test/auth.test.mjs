import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, needsConsent } from '../src/lib/auth.js';
import { telegramInitData, base64UrlToBytes, isIos } from '../src/lib/platform.js';
import { safeRedirectUrl, safeAppPath } from '../src/lib/urls.js';
import { matchRoute } from '../src/lib/router.js';
import { ROUTES } from '../src/lib/routes.js';

test('телефон для входа разработки', () => {
  assert.equal(normalizePhone('+7 (900) 123-45-67'), '+79001234567');
  assert.equal(normalizePhone('8 900 123 45 67'), '+79001234567');
  assert.equal(normalizePhone('9001234567'), '+79001234567');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(''), null);
});

test('согласие: нужно только при явном consent_version: null', () => {
  assert.equal(needsConsent({ id: 1, consent_version: null }), true);
  assert.equal(needsConsent({ id: 1, consent_version: 'v1' }), false);
  assert.equal(needsConsent({ id: 1 }), false, 'поля нет — узнаем по consent_required');
  assert.equal(needsConsent(null), false);
});

test('данные запуска мини-приложения Telegram из адреса', () => {
  const data = 'query_id=AA&user=%7B%22id%22%3A1%7D&auth_date=1700000000&hash=abc';
  assert.equal(telegramInitData(`#tgWebAppData=${encodeURIComponent(data)}&tgWebAppVersion=7.0`), data);
  assert.equal(telegramInitData('#tgWebAppData=no_hash_here'), null);
  assert.equal(telegramInitData(''), null);
  assert.equal(telegramInitData('#other=1'), null);
});

test('ключ VAPID base64url → байты', () => {
  assert.deepEqual([...base64UrlToBytes('AQID_-8')], [1, 2, 3, 255, 239]);
});

test('iPhone и iPad (iPadOS представляется Mac)', () => {
  assert.equal(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5), true);
  assert.equal(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), true);
  assert.equal(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), false);
  assert.equal(isIos('Mozilla/5.0 (Linux; Android 14)', 5), false);
});

test('переход на оплату — только https или свой хост', () => {
  const origin = 'https://billiardum.ru';
  assert.equal(safeRedirectUrl('https://yoomoney.ru/checkout/payments/v2/contract?orderId=1', origin), 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=1');
  assert.equal(safeRedirectUrl('/pay/123', origin), 'https://billiardum.ru/pay/123');
  assert.equal(safeRedirectUrl('javascript:alert(1)', origin), null);
  assert.equal(safeRedirectUrl('http://evil.example/', origin), null);
  assert.equal(safeRedirectUrl('data:text/html,hi', origin), null);
  assert.equal(safeRedirectUrl(undefined, origin), null);
  assert.equal(safeAppPath('/app/s/1', '/app/'), '/app/s/1');
  assert.equal(safeAppPath('//evil.example/app/', '/app/'), '/app/');
  assert.equal(safeAppPath('https://evil.example', '/app/'), '/app/');
});

test('маршруты приложения гостя', () => {
  assert.deepEqual(matchRoute('/app/', ROUTES, '/app/'), { name: 'home', params: {} });
  assert.deepEqual(matchRoute('/app/t/4K7P9QW2XM', ROUTES, '/app/'), { name: 'table', params: { code: '4K7P9QW2XM' } });
  assert.deepEqual(matchRoute('/app/s/abc/receipt/', ROUTES, '/app/'), { name: 'receipt', params: { id: 'abc' } });
  assert.deepEqual(matchRoute('/app/wait/p-1', ROUTES, '/app/'), { name: 'wait', params: { paymentId: 'p-1' } });
  assert.equal(matchRoute('/app/t/', ROUTES, '/app/').name, 'notfound');
  assert.equal(matchRoute('/app/t/%E0%A4%A', ROUTES, '/app/').name, 'notfound', 'битая кодировка не роняет приложение');
  assert.equal(matchRoute('/app/nope/x/y', ROUTES, '/app/').name, 'notfound');
});
