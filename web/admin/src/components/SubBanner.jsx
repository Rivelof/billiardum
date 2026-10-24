import { useEffect, useState } from 'preact/hooks';
import { Icon } from './Icon.jsx';
import { linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { can, clubMode } from '../lib/auth.js';
import { local, useStore } from '../lib/store.js';
import { bannerHidden, bannerHideKey, bannerHideValue, bannerView, loadSubscription, localDay, subscriptions } from '../lib/billingBanner.js';

/**
 * Плашка подписки (M5.3, №184): одна строка под шапкой — «Пробный период заканчивается через 5 дней»,
 * «Оплата подписки не прошла…». Владельцу — «Перейти к оплате», крестик скрывает до завтра (по суткам клуба).
 * compact — касса и ресепшн: короткая строка, не мешает работе. На экране бара плашки нет.
 * Данные — поле banner сервера; без подписки (503 billing_unavailable), в тестовом режиме и у ресепшена плашки нет.
 */
export function SubBanner({ club, role, active, timeZone, compact = false }) {
  const clubId = club.club_id;
  const allowed = can.subscription(role) && clubMode(club) !== 'test' && active !== 'subscription';
  const subs = useStore(subscriptions);
  const [hideSaved, setHideSaved] = useState(() => local.get(bannerHideKey(clubId)));
  useEffect(() => {
    if (allowed) loadSubscription(clubId);
    setHideSaved(local.get(bannerHideKey(clubId)));
  }, [allowed, clubId]);
  if (!allowed) return null;
  const banner = subs[clubId]?.data?.banner ?? null;
  const view = bannerView(banner);
  if (!view) return null;
  const today = localDay(Date.now(), timeZone);
  if (bannerHidden(hideSaved, banner, today)) return null;
  const owner = can.subscriptionManage(role);
  const href = `${BASE}c/${encodeURIComponent(clubId)}/subscription`;
  return (
    <div class={`subnote${view.strong ? ' subnote--strong' : ''}${compact ? ' subnote--compact' : ''}`} role="note" aria-label="Подписка на Бильярдум">
      <Icon name={view.strong ? 'alert' : 'hourglass'} />
      <span class="subnote__text">
        {compact ? view.short : view.text}
        {!owner && !compact ? <span class="subnote__who"> Оплачивает владелец клуба.</span> : null}
      </span>
      {owner ? (
        <a class="subnote__link" href={href} onClick={linkHandler}>
          {compact ? 'Оплатить' : 'Перейти к оплате'}
        </a>
      ) : null}
      <button
        type="button"
        class="icon-btn subnote__close"
        aria-label="Скрыть напоминание о подписке до завтра"
        onClick={() => {
          const v = bannerHideValue(banner, today);
          local.set(bannerHideKey(clubId), v);
          setHideSaved(v);
        }}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
