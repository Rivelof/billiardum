import { useState } from 'preact/hooks';
import { formatMoney, formatTime, formatDuration } from '@billiardum/shared/format';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { useNow } from '../components/hooks.js';
import { api } from '../lib/api.js';
import { minutesWords, perHour } from '../lib/words.js';
import { setFlow } from '../lib/flow.js';
import { safeRedirectUrl } from '../lib/urls.js';

const METHODS = {
  sbp: { icon: 'transfer', title: 'СБП', sub: 'В приложении вашего банка' },
  card: { icon: 'card', title: 'Банковская карта', sub: 'На странице оплаты ЮKassa' },
  reception: { icon: 'reception', title: 'На ресепшене', sub: 'Наличными или картой у администратора' },
};

/**
 * Оплата по котировке (контракт §5): СБП и карта — переход на подтверждение ЮKassa,
 * «На ресепшене» — заявка в очередь ресепшена. Цена держится 3 минуты.
 *
 * @param {object} props
 * @param {object} props.quote ответ POST /api/quotes
 * @param {string} props.what 'Стол 4 · 2 часа'
 * @param {'start' | 'extend'} props.kind
 * @param {boolean} props.unlimited
 * @param {string} props.timeZone
 * @param {() => void} props.onRequote пересчитать цену после истечения
 * @param {(res: object) => void} props.onReception заявка создана
 */
export function Pay({ quote, what, kind, unlimited, timeZone, onRequote, onReception, onError }) {
  // «Без лимита» (решение №26, блок unlimited котировки): карта — заморозка за hold_minutes,
  // СБП — оплата блоками по sbp_block_minutes, ресепшн — депозит. Нет блока unlimited — СБП не предлагаем.
  const u = unlimited ? quote.unlimited ?? null : null;
  const methods = unlimited ? (u?.sbp_block_amount_kopecks ? ['card', 'sbp', 'reception'] : ['card', 'reception']) : ['sbp', 'card', 'reception'];
  const [method, setMethod] = useState(methods[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const now = useNow();
  const left = Date.parse(quote.valid_until) - now;
  const expired = Number.isFinite(left) && left <= 0;
  const payKopecks = unlimited && method === 'sbp' && u ? u.sbp_block_amount_kopecks : unlimited && u ? u.hold_amount_kopecks : quote.amount_kopecks;
  const amount = formatMoney(payKopecks);
  const breakdown = unlimited ? [] : Array.isArray(quote.breakdown) ? quote.breakdown : [];
  const holdWords = u?.hold_minutes ? minutesWords(u.hold_minutes, { accusative: true }) : '2 часа';
  const blockWords = u?.sbp_block_minutes ? minutesWords(u.sbp_block_minutes) : '30 минут';

  const submit = async (e) => {
    e.preventDefault();
    if (expired) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.pay(quote.quote_id, method);
      if (res.reception_request_id) {
        onReception?.(res);
        return;
      }
      const url = safeRedirectUrl(res.confirmation?.url);
      if (!url) throw Object.assign(new Error('confirmation'), { code: 'payment_failed' });
      setFlow({ paymentId: res.payment_id });
      window.location.assign(url);
    } catch (err) {
      setBusy(false);
      if (onError?.(err)) return;
      setError(err);
    }
  };

  let cta;
  if (method === 'reception') cta = 'Отправить заявку на ресепшн';
  else if (unlimited && method === 'card') cta = kind === 'extend' ? `Заморозить ${amount} и продлить` : `Заморозить ${amount} и включить свет`;
  else if (unlimited && method === 'sbp') cta = kind === 'extend' ? `Оплатить ещё ${blockWords}` : `Оплатить первые ${blockWords} и включить свет`;
  else if (kind === 'extend') cta = `Оплатить ${amount} и продлить`;
  else cta = `Оплатить ${amount} и включить свет`;

  let unlimitedNote = null;
  if (unlimited && method === 'card') unlimitedNote = `Заморозим ${amount} — сумму за ${holdWords}. Спишем только сыгранное время, остаток вернётся на карту.`;
  if (unlimited && method === 'sbp') unlimitedNote = `По СБП без лимита платите блоками по ${blockWords}: за 5 минут до конца блока предложим оплатить следующий.`;
  if (unlimited && method === 'reception') unlimitedNote = `На ресепшене сразу оплачиваются ${holdWords} — ${amount}. Дальше продлите игру как обычно.`;

  return (
    <form class="step pay" onSubmit={submit} noValidate aria-labelledby="pay-title">
      <div class="pay__sum">
        <h2 class="pay__what" id="pay-title">
          {what}
        </h2>
        <p class="pay__amount display">
          {amount.replace(/\s?₽$/, '')}
          <span class="rub">&nbsp;₽</span>
        </p>
        {unlimitedNote ? (
          <p class="hint" aria-live="polite">
            {unlimitedNote}
          </p>
        ) : null}
      </div>

      {breakdown.length > 1 ? (
        <div class="receipt pay__breakdown" aria-label="Из чего сложилась цена">
          {breakdown.map((b) => (
            <div class="receipt__row" key={b.from}>
              <span>
                <span class="mono">
                  {formatTime(b.from, timeZone)}–{formatTime(b.to, timeZone)}
                </span>
                {' · '}
                {perHour(b.price_per_hour_kopecks)}
              </span>
              <span class="receipt__sum">{formatMoney(b.amount_kopecks)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <p class={`quote-timer${expired ? ' quote-timer--over' : ''}`} role={expired ? 'alert' : undefined}>
        <Icon name="clock" />
        {expired ? (
          <span>Цена держалась 3 минуты, время вышло.</span>
        ) : (
          <span>
            Цена держится ещё <span class="mono">{formatDuration(left)}</span>, стол пока за вами
          </span>
        )}
      </p>

      {expired ? (
        <div class="actionbar">
          <button type="button" class="btn btn--primary btn--block btn--lg" onClick={onRequote}>
            <Icon name="refresh" />
            Пересчитать цену
          </button>
        </div>
      ) : (
        <>
          <fieldset>
            <legend class="step__label">Способ оплаты</legend>
            <div class="choice choice--methods">
              {methods.map((m) => (
                <label class="choice__item" key={m}>
                  <input type="radio" name="method" value={m} checked={method === m} onChange={() => setMethod(m)} />
                  <span class="choice__box choice__box--row">
                    <Icon name={METHODS[m].icon} />
                    <span>
                      <span class="choice__title">{METHODS[m].title}</span>
                      <span class="choice__sub">{METHODS[m].sub}</span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <ErrorNote error={error} />
          <div class="actionbar">
            <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
              {busy ? 'Отправляем…' : cta}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
