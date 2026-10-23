import { useState } from 'preact/hooks';
import { plural } from '@billiardum/shared/format';
import { Icon } from '../../components/Icon.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { api } from '../../lib/api.js';
import { setClubMode } from '../../lib/auth.js';
import { linkHandler } from '../../lib/router.js';
import { BASE } from '../../lib/env.js';
import { checklistView, offerVersionText, stepById } from '../../lib/onboarding.js';

/**
 * Шаг «Запуск» (№160): чек-лист сервера с переходом к шагу, оферта и «Перейти в боевой режим».
 * 409 checklist_incomplete { failed } — невыполненные пункты отмечаются в списке. Обратно в тест клуб сам не переходит.
 */
export function GoLiveStep({ ctx, ob, reload, live, goTo }) {
  const clubId = ctx.club.club_id;
  const [failed, setFailed] = useState([]);
  const [offer, setOffer] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [launched, setLaunched] = useState(false);

  const items = checklistView(ob.checklist, failed).filter((i) => i.id !== 'offer');
  const open = items.filter((i) => !i.ok);

  if (live) {
    return (
      <div class="stack ob__content">
        <div class="note note--free golive__done" role="status">
          <Icon name="lamp" />
          <p class="note__title">{launched ? 'Готово: клуб в боевом режиме.' : 'Клуб в боевом режиме.'}</p>
          <p class="note__body">Оплаты гостей настоящие и идут в боевой магазин ЮKassa клуба, на кассе пробиваются фискальные чеки. Карточка клуба в каталоге связана с программой.</p>
        </div>
        <p class="hint">Тарифы, зал и магазин ЮKassa теперь меняются только с причиной — изменения попадут в журнал, вам придёт уведомление.</p>
        <a class="btn btn--primary" href={`${BASE}c/${encodeURIComponent(clubId)}/now`} onClick={linkHandler}>
          Открыть «Сейчас»
        </a>
      </div>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!offer) {
      document.getElementById('gl-offer')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.goLive(clubId);
      setClubMode(clubId, res?.mode ?? 'live');
      setLaunched(true);
      setFailed([]);
      await reload();
    } catch (err) {
      if (err?.code === 'checklist_incomplete') {
        setFailed(Array.isArray(err.data?.failed) ? err.data.failed : []);
        await reload();
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack ob__content">
      <p class="lead">Когда всё отмечено, переведите клуб в боевой режим: оплаты гостей станут настоящими.</p>
      <section aria-labelledby="gl-title">
        <h3 class="section-title" id="gl-title">
          Чек-лист запуска
          {open.length ? <span class="count count--alert">{open.length}</span> : null}
        </h3>
        <p class="small muted" role="status">
          {open.length ? `Не выполнено: ${open.length} ${plural(open.length, ['пункт', 'пункта', 'пунктов'])}.` : 'Все пункты выполнены.'}
        </p>
        <ul class="cl">
          {items.map((i) => (
            <li key={i.id} class={`cl__item ${i.ok ? 'cl__item--ok' : 'cl__item--no'}`}>
              <span class="cl__mark" aria-hidden="true">
                <Icon name={i.ok ? 'check' : 'alert'} />
              </span>
              <span class="cl__main">
                <span class="cl__title">
                  <span class="visually-hidden">{i.ok ? 'Выполнено: ' : 'Не выполнено: '}</span>
                  {i.title}
                </span>
                {i.detail ? <span class="cl__detail">{i.detail}</span> : null}
              </span>
              {!i.ok && i.step ? (
                <a class="btn btn--secondary btn--sm cl__go" href={`${BASE}c/${encodeURIComponent(clubId)}/onboarding/${i.step}`} onClick={linkHandler}>
                  {i.stepLabel ?? stepById(i.step)?.title ?? 'К шагу'}
                  <Icon name="forward" />
                </a>
              ) : null}
              {!i.ok && i.screen ? (
                <a class="btn btn--secondary btn--sm cl__go" href={`${BASE}c/${encodeURIComponent(clubId)}/${i.screen}`} onClick={linkHandler}>
                  Касса ККТ
                  <Icon name="forward" />
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <form class="form golive" onSubmit={submit} noValidate>
        <label class="check">
          <input id="gl-offer" type="checkbox" checked={offer} aria-invalid={tried && !offer ? 'true' : undefined} aria-describedby={tried && !offer ? 'gl-offer-e' : undefined} onChange={(e) => setOffer(e.currentTarget.checked)} />
          <span>
            Принимаю{' '}
            {typeof ob.offer_url === 'string' && /^(https:\/\/|\/)/.test(ob.offer_url) ? (
              <a href={ob.offer_url} target="_blank" rel="noopener">
                оферту Бильярдума для клубов
              </a>
            ) : (
              'оферту Бильярдума для клубов'
            )}
            {offerVersionText(ob.offer?.version) ? ` (редакция ${offerVersionText(ob.offer.version)})` : ''}
          </span>
        </label>
        {tried && !offer ? (
          <p class="field__error" id="gl-offer-e">
            Без принятой оферты клуб не перейдёт в боевой режим.
          </p>
        ) : null}
        <div class="note note--lamp">
          <Icon name="info" />
          <p class="note__title">Что изменится</p>
          <ul class="note__body golive__list">
            <li>Гости платят по-настоящему: деньги идут в боевой магазин ЮKassa клуба.</li>
            <li>На кассе ресепшена пробиваются фискальные чеки.</li>
            <li>Клуб появится в каталоге Бильярдума с онлайн-оплатой.</li>
            <li>Обратно в тестовый режим клуб переводит только поддержка Бильярдума.</li>
          </ul>
        </div>
        {error?.code === 'checklist_incomplete' ? (
          <div class="note note--error" role="alert">
            <Icon name="alert" />
            <p class="note__title">Клуб ещё не готов к боевому режиму.</p>
            <p class="note__body">Выполните пункты, отмеченные в чек-листе выше, и нажмите кнопку снова.</p>
          </div>
        ) : (
          <ErrorNote error={error} />
        )}
        <button type="submit" class="btn btn--lamp btn--lg" disabled={busy}>
          <Icon name="lamp" />
          {busy ? 'Переводим…' : 'Перейти в боевой режим'}
        </button>
        {open.length ? <p class="small muted">Сервер проверит чек-лист ещё раз в момент перехода.</p> : null}
        {goTo && open[0]?.step ? (
          <button type="button" class="btn btn--link" onClick={() => goTo(open[0].step)}>
            Начать с первого невыполненного: {stepById(open[0].step)?.title}
          </button>
        ) : null}
      </form>
    </div>
  );
}
