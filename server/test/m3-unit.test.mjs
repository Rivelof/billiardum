// M3 core без базы: порядок каналов, маскировка с хешами, местное время сводки.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { channelChain, cleanActions, maskPhones } from '../notify/index.mjs';
import { createMaxBot } from '../notify/max.mjs';
import { localParts, shiftDate, summaryText } from '../summaries/index.mjs';

describe('цепочка и сводка', () => {
  it('порядок каналов пользователя — только доступные из выбранных; без выбора — основной и по умолчанию', () => {
    const route = { telegram_user_id: 1, max_user_id: 'm', notify_channel: 'telegram' };
    assert.deepEqual(channelChain({ ...route, channels_order: ['webpush', 'max'] }, true), ['webpush', 'max']);
    assert.deepEqual(channelChain({ ...route, channels_order: ['webpush', 'max'] }, false), ['max']);
    // №130: critical и important — после выбранных ещё и остальные доступные; info — только выбранные.
    assert.deepEqual(channelChain({ ...route, channels_order: ['webpush'] }, true, 'important'), ['webpush', 'max', 'telegram']);
    assert.deepEqual(channelChain({ ...route, channels_order: ['webpush'] }, true, 'critical'), ['webpush', 'max', 'telegram']);
    assert.deepEqual(channelChain({ ...route, channels_order: ['webpush'] }, true, 'info'), ['webpush']);
    assert.deepEqual(channelChain(route, true), ['telegram', 'max', 'webpush']);
  });

  it('MAX до документации не настроен; действия проверяются', async () => {
    const max = createMaxBot({ token: 'x' });
    assert.equal(max.configured, false);
    await assert.rejects(max.call('sendMessage', {}), (e) => e.code === 'not_configured');
    assert.deepEqual(cleanActions([{ id: 'extend', title: ' Продлить ', url: '/app/s/1' }]), [{ id: 'extend', title: 'Продлить', url: '/app/s/1' }]);
    assert.throws(() => cleanActions([{ id: 'x', title: 'X', url: '/\\evil' }]));
  });

  it('маскировка телефонов не трогает хеш головы журнала', () => {
    const hash = '1234567890123456789012345678901234567890123456789012345678901234';
    assert.equal(maskPhones(`хеш ${hash}, звонок +7 999 123-45-67`), `хеш ${hash}, звонок ***`);
  });

  it('местные дата и минуты в поясе клуба; рабочие сутки «вчера»', () => {
    const at = new Date('2026-10-22T00:30:00Z');
    assert.deepEqual(localParts(at, 'Asia/Vladivostok'), { date: '2026-10-22', minutes: 630 });
    assert.deepEqual(localParts(at, 'Asia/Yekaterinburg'), { date: '2026-10-22', minutes: 330 });
    assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  });

  it('текст сводки без журнала и с пустой выручкой', () => {
    const text = summaryText({
      day: '2026-10-21',
      revenue: { by_method: { sbp: 0, card: 0, cash: 0, card_terminal: 0 }, net_kopecks: 0, refunds_kopecks: 0 },
      play: { hours: 0, utilization_percent: 0 },
      alarms: { total: 0, critical: 0 },
      manual_actions: { count: 0 },
      journal: { head_seq: 0, head_hash: null },
    });
    assert.equal(text.replace(/[\u00a0\u202f]/g, ' '), 'Сводка за 21 октября: выручка 0 ₽; игра 0 ч, загрузка 0 %; 0 тревог; ручных действий: 0.');
  });

  it('текст сводки: автоматические действия системы — отдельной строкой, только при M > 0 (№125)', () => {
    const base = {
      day: '2026-10-21',
      revenue: { by_method: { sbp: 0, card: 0, cash: 0, card_terminal: 0 }, net_kopecks: 0, refunds_kopecks: 0 },
      play: { hours: 0, utilization_percent: 0 },
      alarms: { total: 0, critical: 0 },
      journal: { head_seq: 0, head_hash: null },
    };
    const text = summaryText({ ...base, manual_actions: { count: 1, automatic: { count: 2, by_action: { 'payment.forfeited': 2 } } } });
    assert.ok(text.endsWith('ручных действий: 1; автоматических действий системы: 2.'), text);
    assert.doesNotMatch(summaryText({ ...base, manual_actions: { count: 1, automatic: { count: 0, by_action: {} } } }), /автоматических/);
  });
});
