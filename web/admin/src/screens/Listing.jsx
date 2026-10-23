import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatDate } from '@billiardum/shared/format';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { Ill } from '../components/Ill.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { LISTING_STATUS, ratingSummary } from '../lib/platform.js';
import '../styles/m4.css';

/**
 * Карточка клуба в агрегаторе (№133) и отзывы (№141): адрес, телефон, описание, часы; ответ на отзыв,
 * жалоба оператору платформы. Название и город меняет оператор — чтобы адреса страниц не ломались.
 */
export function Listing({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [card, setCard] = useState(null);
  const [form, setForm] = useState(null);
  const [reviews, setReviews] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [reporting, setReporting] = useState(null);

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([api.listing(clubId), api.reviews(clubId)]);
      setCard(c);
      setForm({ address: c.address ?? '', phone: c.phone ?? '', description: c.description ?? '', hours_text: c.hours_text ?? '', url: c.url ?? '' });
      setReviews(r?.items ?? []);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCard(await api.updateListing(clubId, form));
      setNotice('Карточка сохранена. На сайте обновится в течение минуты.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const st = LISTING_STATUS[card?.status] ?? null;
  const sum = ratingSummary(reviews);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.currentTarget.value }));

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="listing" title="Карточка в Бильярдуме">
      <div class="page listing">
        <ErrorNote error={error} />
        {notice ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">{notice}</span>
          </p>
        ) : null}
        {!card && !error ? <p class="muted loading">Загружаем карточку…</p> : null}
        {card ? (
          <div class="listing__cols">
            <form class="form panel" onSubmit={save} noValidate aria-labelledby="ls-title">
              <div class="listing__head">
                <h2 class="section-title" id="ls-title">
                  {card.name}
                </h2>
                {st ? (
                  <span class={`badge badge--${st.tone}`}>
                    <span class="badge__dot" aria-hidden="true" />
                    {st.word}
                  </span>
                ) : null}
              </div>
              {st ? <p class="hint">{st.text}</p> : null}
              <p class="muted small">
                {card.city}
                {card.path || card.slug ? ` · адрес страницы: ${card.path ?? `/${card.slug}/`}` : ''}
              </p>
              <div class="field">
                <label class="field__label" for="ls-addr">
                  Адрес
                </label>
                <input id="ls-addr" class="field__input" maxLength={200} value={form.address} onInput={set('address')} />
              </div>
              <div class="field">
                <label class="field__label" for="ls-phone">
                  Телефон для гостей
                </label>
                <input id="ls-phone" class="field__input mono" type="tel" maxLength={40} value={form.phone} onInput={set('phone')} />
              </div>
              <div class="field">
                <label class="field__label" for="ls-hours">
                  Часы работы
                </label>
                <input id="ls-hours" class="field__input" maxLength={200} value={form.hours_text} placeholder="Ежедневно 12:00–02:00" onInput={set('hours_text')} />
              </div>
              <div class="field">
                <label class="field__label" for="ls-desc">
                  Описание
                </label>
                <textarea id="ls-desc" class="field__input field__input--area" rows={5} maxLength={1000} value={form.description} aria-describedby="ls-desc-hint" onInput={set('description')} />
                <p class="field__hint" id="ls-desc-hint">
                  Столы, бар, турниры — коротко и по делу. <span class="mono">{form.description.length}</span> из 1000.
                </p>
              </div>
              <button type="submit" class="btn btn--primary" disabled={busy}>
                {busy ? 'Сохраняем…' : 'Сохранить карточку'}
              </button>
            </form>

            <section class="panel" aria-labelledby="rv-title">
              <div class="listing__head">
                <h2 class="section-title" id="rv-title">
                  Отзывы <span class="count">{reviews?.length ?? 0}</span>
                </h2>
                {sum ? (
                  <p class="rvsum">
                    <span class="rvsum__value display">{sum.avg}</span>
                    <span class="rvsum__balls" aria-hidden="true">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <span key={n} class={n <= Math.round(sum.value) ? 'on' : ''} />
                      ))}
                    </span>
                    <span class="visually-hidden">Средняя оценка {sum.avg} из 5</span>
                  </p>
                ) : null}
              </div>
              {reviews?.length === 0 ? (
                <p class="empty-queue">
                  <Ill name="lamp" />
                  <span class="empty-queue__title">Отзывов пока нет</span>
                  Оставить отзыв могут гости, которые играли или бронировали у вас за 90 дней.
                </p>
              ) : null}
              <ul class="rvlist">
                {(reviews ?? []).map((r) => (
                  <Review key={r.id} r={r} timeZone={timeZone} onChange={(x) => setReviews((l) => l.map((y) => (y.id === x.id ? x : y)))} onReport={() => setReporting(r)} />
                ))}
              </ul>
            </section>
          </div>
        ) : null}
      </div>
      <ReportDialog
        r={reporting}
        onClose={() => setReporting(null)}
        onDone={(x) => {
          setReporting(null);
          setReviews((l) => l.map((y) => (y.id === x.id ? x : y)));
          setNotice('Жалоба отправлена оператору платформы. Он проверит отзыв и ответит.');
        }}
      />
    </Shell>
  );
}

function Review({ r, timeZone, onChange, onReport }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <li class="rv">
      <p class="rv__head">
        <span class="rv__balls" role="img" aria-label={`Оценка ${r.rating} из 5`}>
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} class={n <= r.rating ? 'on' : ''} aria-hidden="true" />
          ))}
        </span>
        <span class="rv__who">{r.author_nick}</span>
        <span class="rv__date">{formatDate(r.created_at, timeZone)}</span>
      </p>
      {r.text ? <p class="rv__text">{r.text}</p> : null}
      {r.reply ? (
        <div class="rv__reply">
          <p class="rv__reply-kicker">Ответ клуба · {formatDate(r.reply.at, timeZone)}</p>
          <p>{r.reply.text}</p>
        </div>
      ) : null}
      {open ? (
        <form
          class="rv__form"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            setBusy(true);
            setError(null);
            try {
              onChange(await api.replyReview(r.id, text.trim()));
              setOpen(false);
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label class="visually-hidden" for={`rp-${r.id}`}>
            Ответ на отзыв {r.author_nick}
          </label>
          <textarea id={`rp-${r.id}`} class="field__input field__input--area" rows={3} maxLength={1000} value={text} placeholder="Спасибо за отзыв…" onInput={(e) => setText(e.currentTarget.value)} />
          <ErrorNote error={error} />
          <div class="row">
            <button type="submit" class="btn btn--primary btn--sm" disabled={busy || !text.trim()}>
              {busy ? 'Публикуем…' : 'Опубликовать ответ'}
            </button>
            <button type="button" class="btn btn--quiet btn--sm" onClick={() => setOpen(false)}>
              Отмена
            </button>
          </div>
        </form>
      ) : (
        <div class="row rv__actions">
          {!r.reply ? (
            <button type="button" class="btn btn--secondary btn--sm" onClick={() => setOpen(true)}>
              Ответить
            </button>
          ) : null}
          {r.reported ? (
            <span class="muted small">Жалоба у оператора</span>
          ) : (
            <button type="button" class="btn btn--quiet btn--sm" onClick={onReport}>
              Пожаловаться
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function ReportDialog({ r, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setReason('');
    setError(null);
  }, [r?.id]);
  if (!r) return <Dialog open={false} onClose={onClose} title="" />;
  return (
    <Dialog open onClose={onClose} title="Пожаловаться на отзыв" labelledBy="rpt-title">
      <form
        class="form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (reason.trim().length < 3) return;
          setBusy(true);
          setError(null);
          try {
            onDone(await api.reportReview(r.id, reason.trim()));
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p class="hint">Оператор Бильярдума проверит отзыв. Скрывают оскорбления, персональные данные и отзывы не об игре в клубе — не плохие оценки.</p>
        <div class="field">
          <label class="field__label" for="rpt-reason">
            Что не так
          </label>
          <input id="rpt-reason" class="field__input" maxLength={300} value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || reason.trim().length < 3}>
            {busy ? 'Отправляем…' : 'Отправить оператору'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
