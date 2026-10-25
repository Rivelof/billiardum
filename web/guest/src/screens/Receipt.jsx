import { useEffect, useState } from 'preact/hooks';
import { formatDate, formatMoney, formatTime } from '@billiardum/shared/format';
import { Header } from '../components/Header.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { BASE } from '../lib/env.js';
import { clubTimeZone } from '../lib/flow.js';
import { linkHandler } from '../lib/router.js';
import { isIos, isStandalone } from '../lib/platform.js';
import { local } from '../lib/store.js';
import { minutesWords, tableName } from '../lib/words.js';
import { receiptState, refundLines, RECEIPT_TEXT } from '../lib/receipt.js';

const METHOD = { sbp: 'СБП', card: 'Картой онлайн', cash: 'Наличными на ресепшене', card_terminal: 'Картой на ресепшене' };

/** Чек сессии: строки и суммы моноширинным по правому краю (DESIGN §4), способы оплаты, статус фискального чека. */
export function ReceiptScreen({ id }) {
  const [receipt, setReceipt] = useState(null);
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);

  const load = async () => {
    setError(null);
    try {
      const [r, s] = await Promise.all([api.receipt(id), api.session(id).catch(() => null)]);
      setReceipt(r);
      setSession(s);
    } catch (err) {
      setError(err);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const tz = clubTimeZone(session?.club?.timezone);
  const lines = [...(Array.isArray(receipt?.lines) ? receipt.lines : []), ...refundLines(receipt?.payments)];
  const payments = Array.isArray(receipt?.payments) ? receipt.payments : [];

  return (
    <div class="screen screen--paper">
      <Header back={{ href: `${BASE}s/${encodeURIComponent(id)}`, label: 'К игре' }} />
      <main class="wrap content">
        <h1 class="page-title display">Чек</h1>
        {session ? (
          <p class="muted">
            {tableName(session.resource?.number, session.resource)}
            {session.started_at ? `, ${formatDate(session.started_at, tz)}` : ''}
          </p>
        ) : null}

        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Загрузить снова
          </button>
        </ErrorNote>

        {receipt ? (
          <section class="ticket" aria-label="Чек">
            <div class="receipt">
              {lines.map((l, i) => (
                <div class="receipt__row" key={i}>
                  <span>{lineTitle(l)}</span>
                  <span class="receipt__sum">{formatMoney(l.amount_kopecks ?? 0)}</span>
                  {lineSub(l, tz) ? <span class="receipt__sub">{lineSub(l, tz)}</span> : null}
                </div>
              ))}
              <div class="receipt__row receipt__row--total">
                <span>Итого</span>
                <span class="receipt__sum">{formatMoney(receipt.total_kopecks ?? 0)}</span>
              </div>
            </div>
            {payments.length ? (
              <div class="receipt receipt--pay">
                {payments.map((p, i) => (
                  <div class="receipt__row" key={p.payment_id ?? i}>
                    <span>{METHOD[p.method] ?? 'Оплата'}</span>
                    <span class="receipt__sum">{formatMoney(p.amount_kopecks ?? 0)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <p class="ticket__status">
              <Icon name="receipt" />
              {RECEIPT_TEXT[receiptState(receipt.receipt_status)]}
            </p>
          </section>
        ) : !error ? (
          <p class="waiting" role="status">
            <span class="waiting__dot" aria-hidden="true" />
            Загружаем чек…
          </p>
        ) : null}

        <InstallHint />

        {/* M4 (№141): отзыв о клубе — после игры */}
        {session?.club?.id ? (
          <a class="rateclub" href={`${BASE}review/${encodeURIComponent(session.club.id)}?name=${encodeURIComponent(session.club.name ?? '')}`} onClick={linkHandler}>
            <span class="rateclub__balls" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
            </span>
            <span>
              Как вам {session.club.name ? `«${session.club.name}»` : 'клуб'}?
              <span class="rateclub__sub">Оцените — это 20 секунд</span>
            </span>
            <Icon name="forward" />
          </a>
        ) : null}

        <a class="btn btn--quiet btn--block" href={BASE} onClick={linkHandler}>
          На главную
        </a>
      </main>
    </div>
  );
}

function lineTitle(l) {
  if (l.title) return l.title;
  if (l.minutes) return `Игра, ${minutesWords(l.minutes)}`;
  return 'Игра';
}

function lineSub(l, tz) {
  if (l.from && l.to) return `${formatTime(l.from, tz)}–${formatTime(l.to, tz)}`;
  return null;
}

/** iPhone: Web Push работает только с экрана «Домой» (PRODUCT §12). Подсказка — после первой игры. */
function InstallHint() {
  const [hidden, setHidden] = useState(() => !isIos() || isStandalone() || Boolean(local.get('bl-ios-hint')));
  if (hidden) return null;
  return (
    <section class="note install" aria-labelledby="install-title">
      <Icon name="phone" />
      <h2 class="note__title" id="install-title">
        Напоминания на iPhone
      </h2>
      <div class="note__body">
        <p>Чтобы в следующий раз получить уведомление о конце игры, добавьте Бильярдум на экран «Домой»:</p>
        <ol class="howto howto--small">
          <li>нажмите «Поделиться» внизу Safari;</li>
          <li>выберите «На экран Домой»;</li>
          <li>откройте Бильярдум с экрана «Домой» и включите напоминания.</li>
        </ol>
      </div>
      <div class="note__actions">
        <button
          type="button"
          class="btn btn--link"
          onClick={() => {
            local.set('bl-ios-hint', '1');
            setHidden(true);
          }}
        >
          Понятно, скрыть
        </button>
      </div>
    </section>
  );
}
