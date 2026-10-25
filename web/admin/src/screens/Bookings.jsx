import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Ill } from '../components/Ill.jsx';
import { formatDate, formatMoney, formatTime } from '@billiardum/shared/format';
import { addDays, durationsFor, localDate, normalizePhone, slotDurations } from '@billiardum/shared/booking';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { useNow } from '../components/hooks.js';
import { api, streamClub } from '../lib/api.js';
import { BOOKING_STAFF_WORD, SOURCE_LABEL, canArrive, lanes, place, startOptions, timelineWindow } from '../lib/bookings.js';
import { minutesShort } from '../lib/words.js';
import { familyOf, familyText, resourceName, slotLabel, slotMinutesOf, slotOptions, slotsText } from '@billiardum/shared/resource';

const MIN = 60_000;
const BUSY_WORD = { session: 'Игра', service: 'Сервис', pending: 'Оплата', closed: 'Закрыто' };

/**
 * Брони на день (PRODUCT §6, §10): лента по столам — брони янтарной рамкой, идущие игры и сервис серым;
 * бронь по телефону (имя, телефон, источник), «Гость пришёл», отмена с причиной (ресепшн — только свои брони
 * по телефону без предоплаты, №115). Живые изменения — SSE booking в канале клуба.
 */
export function Bookings({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const now = useNow(60_000, true);
  // «Сегодня» — рабочие сутки клуба (с day_start, после полуночи — ещё вчерашние): дата availability без date
  const [today, setToday] = useState(() => localDate(Date.now(), timeZone));
  const [date, setDate] = useState(today);
  useEffect(() => {
    const calendar = localDate(Date.now(), timeZone);
    api
      .availability(clubId)
      .then((d) => {
        if (!d?.date) return;
        setToday(d.date);
        setDate((x) => (x === calendar ? d.date : x));
      })
      .catch(() => {});
  }, [clubId]);
  const [day, setDay] = useState(null);
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null); // бронь в окне
  const [creating, setCreating] = useState(null); // { resourceId?, at? }

  const load = useCallback(async () => {
    const [a, b] = await Promise.allSettled([api.availability(clubId, date), api.bookings(clubId, date)]);
    if (a.status === 'fulfilled') setDay(a.value);
    if (b.status === 'fulfilled') setList(Array.isArray(b.value) ? b.value : (b.value?.bookings ?? []));
    setError(a.status === 'rejected' ? a.reason : b.status === 'rejected' ? b.reason : null);
  }, [clubId, date]);

  useEffect(() => {
    setDay(null);
    setList(null);
    load();
    const stream = streamClub(clubId, { events: ['booking', 'session', 'hall'], onEvent: () => load(), onOpen: load });
    const t = setInterval(load, 60_000);
    return () => {
      stream.close();
      clearInterval(t);
    };
  }, [clubId, date]);

  const bookings = list ?? [];
  const win = useMemo(() => timelineWindow(day, bookings), [day, bookings]);
  const rows = day ? lanes(day, bookings) : [];
  const live = bookings.filter((b) => b.status !== 'canceled').sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const fmtT = (x) => formatTime(x, timeZone);
  const nowPos = win.to > win.from && now >= win.from && now <= win.to ? ((now - win.from) / (win.to - win.from)) * 100 : null;
  // Сегодня лента сама прокручивается к «сейчас» (час назад — у левого края), один раз на день
  const tlRef = useRef(null);
  const scrolledFor = useRef(null);
  useEffect(() => {
    const el = tlRef.current;
    if (!el || nowPos === null || scrolledFor.current === date) return;
    scrolledFor.current = date;
    const inner = el.firstElementChild;
    const lane = inner?.querySelector('.tl__lane');
    if (!lane) return;
    const x = lane.offsetLeft + (lane.offsetWidth * nowPos) / 100 - lane.offsetWidth / win.hours.length;
    el.scrollLeft = Math.max(0, x - (inner.querySelector('.tl__table')?.offsetWidth ?? 0));
  }, [day, nowPos === null, date]);

  const tools = (
    <div class="datenav" role="group" aria-label="День">
      <button type="button" class="icon-btn" aria-label="Предыдущий день" onClick={() => setDate((d) => addDays(d, -1))}>
        <Icon name="back" />
      </button>
      <button type="button" class={`btn btn--sm ${date === today ? 'btn--secondary' : 'btn--quiet'}`} onClick={() => setDate(today)} aria-pressed={date === today ? 'true' : 'false'}>
        Сегодня
      </button>
      <button type="button" class="icon-btn" aria-label="Следующий день" onClick={() => setDate((d) => addDays(d, 1))}>
        <Icon name="forward" />
      </button>
    </div>
  );

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="bookings" title="Брони" wide>
      <div class="page bookings">
        <div class="bookings__head">
          {tools}
          <h2 class="section-title">
            {date === today ? 'Сегодня, ' : ''}
            {day ? formatDate(day.open_at, timeZone) : formatDate(Date.parse(`${date}T12:00:00Z`), 'UTC')}
            <span class="count">{live.length}</span>
          </h2>
          <button type="button" class="btn btn--primary" onClick={() => setCreating({})}>
            <Icon name="phone" />
            Бронь по телефону
          </button>
        </div>
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Обновить
          </button>
        </ErrorNote>
        {!day && !error ? <p class="muted loading">Загружаем брони…</p> : null}

        {day ? (
          <div class="tl" role="region" aria-label="Лента броней по столам" tabIndex={0} ref={tlRef}>
            <div class="tl__inner" style={{ '--hours': win.hours.length }}>
              <div class="tl__corner" aria-hidden="true" />
              <div class="tl__hours" aria-hidden="true">
                {win.hours.map((h) => (
                  <span key={h} class="tl__hour mono">
                    {fmtT(h)}
                  </span>
                ))}
              </div>
              {rows.map((row) => (
                <div class="tl__row" key={row.resource.id}>
                  <div class="tl__table">
                    <span class="tl__num">{resourceName(row.resource)}</span>
                  </div>
                  <div class="tl__lane">
                    {row.busy.map((x, i) => {
                      const p = place(win, x.from, x.to);
                      return (
                        <span key={i} class={`tl__busy tl__busy--${x.kind}`} style={{ left: `${p.left}%`, width: `${p.width}%` }} aria-hidden="true">
                          {p.width > 6 ? BUSY_WORD[x.kind] ?? '' : ''}
                        </span>
                      );
                    })}
                    {row.bookings.map((b) => {
                      const p = place(win, b.starts_at, b.ends_at);
                      return (
                        <button
                          type="button"
                          key={b.id}
                          class={`tl__bk tl__bk--${b.status}`}
                          style={{ left: `${p.left}%`, width: `${p.width}%` }}
                          onClick={() => setOpen(b)}
                        >
                          {/* Имя кнопки — из содержимого: видимое время и гость плюс скрытые стол и статус (axe label-content-name-mismatch, WCAG 2.5.3) */}
                          <span class="visually-hidden">{resourceName(row.resource)}, </span>
                          <span class="tl__bk-time mono">
                            {fmtT(b.starts_at)}–{fmtT(b.ends_at)}
                          </span>
                          <span class="visually-hidden">, </span>
                          <span class="tl__bk-who">{b.guest?.name ?? 'Приложение'}</span>
                          <span class="visually-hidden">, {BOOKING_STAFF_WORD[b.status] ?? b.status}</span>
                        </button>
                      );
                    })}
                    {nowPos !== null ? <span class="tl__now" style={{ left: `${nowPos}%` }} aria-hidden="true" /> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {day ? (
          <section aria-labelledby="bk-list">
            <h3 class="tables__title" id="bk-list">
              Списком
            </h3>
            {live.length ? (
              <ul class="bklist">
                {live.map((b) => (
                  <li key={b.id}>
                    <button type="button" class={`bkrow bkrow--${b.status}`} onClick={() => setOpen(b)}>
                      <span class="bkrow__time mono">
                        {fmtT(b.starts_at)}–{fmtT(b.ends_at)}
                      </span>
                      <span class="bkrow__table">{resourceName(b.resource ?? 'table', b.resource?.number)}</span>
                      <span class="bkrow__who">
                        {b.guest?.name ?? 'Гость приложения'}
                        {b.guest?.phone_masked ? <span class="bkrow__phone mono">{b.guest.phone_masked}</span> : null}
                      </span>
                      <span class={`bkrow__state bkrow__state--${b.status}`}>{BOOKING_STAFF_WORD[b.status] ?? b.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="empty-queue">
                <Ill name="lamp" />
                <span class="empty-queue__title">Броней на этот день нет</span>
                Гости бронируют в приложении, звонки записывайте кнопкой «Бронь по телефону».
              </p>
            )}
          </section>
        ) : null}
      </div>

      <BookingDialog booking={open} role={role} timeZone={timeZone} onClose={() => setOpen(null)} onChanged={() => (setOpen(null), load())} />
      <PhoneBookingDialog open={Boolean(creating)} day={day} clubId={clubId} timeZone={timeZone} onClose={() => setCreating(null)} onDone={() => (setCreating(null), load())} />
    </Shell>
  );
}

function BookingDialog({ booking: b, role, timeZone, onClose, onChanged }) {
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    setReason('');
    setCancelling(false);
    setError(null);
    setTried(false);
  }, [b?.id]);
  if (!b) return <Dialog open={false} onClose={onClose} title="" />;
  const fmtT = (x) => formatTime(x, timeZone);
  // Право отмены по №115 решает сервер: can_cancel в ответе списка броней для запрашивающего
  const cancelOk = b.can_cancel === true;

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`${resourceName(b.resource ?? 'table', b.resource?.number)}, ${fmtT(b.starts_at)}–${fmtT(b.ends_at)}`} labelledBy="bk-dlg">
      <div class="form">
        <dl class="receipt">
          <div class="receipt__row">
            <dt>Гость</dt>
            <dd>
              {b.guest?.name ?? 'Гость приложения'}
              {b.guest?.phone_masked ? (
                <>
                  {' · '}
                  <span class="mono">{b.guest.phone_masked}</span>
                </>
              ) : null}
            </dd>
          </div>
          <div class="receipt__row">
            <dt>Статус</dt>
            <dd>{BOOKING_STAFF_WORD[b.status] ?? b.status}</dd>
          </div>
          <div class="receipt__row">
            <dt>Источник</dt>
            <dd>{SOURCE_LABEL[b.source] ?? b.source}</dd>
          </div>
          <div class="receipt__row">
            <dt>Время</dt>
            <dd>
              {formatDate(b.starts_at, timeZone)}, {minutesShort(b.minutes)}, удержим до {fmtT(b.hold_until)}
            </dd>
          </div>
          <div class="receipt__row">
            <dt>По тарифу</dt>
            <dd class="receipt__sum">{formatMoney(b.amount_kopecks ?? 0)}</dd>
          </div>
          {b.paid_kopecks ? (
            <div class="receipt__row">
              <dt>Предоплата внесена</dt>
              <dd class="receipt__sum">{formatMoney(b.paid_kopecks)}</dd>
            </div>
          ) : null}
        </dl>
        {b.source === 'app' || b.source === 'site' ? <p class="hint">Гость начнёт игру сам: отсканирует QR на столе, оплата — по брони.</p> : null}
        <ErrorNote error={error} />
        {canArrive(b) && !cancelling ? (
          <button type="button" class="btn btn--primary btn--block btn--lg" disabled={busy} onClick={() => run(() => api.arriveBooking(b.id))}>
            <Icon name="check" />
            Гость пришёл
          </button>
        ) : null}
        {canArrive(b) && !cancelling ? <p class="hint">Бронь закроется, стол освободится от брони. Время игры примите как обычно — на кассе или в заявке.</p> : null}
        {cancelOk && !cancelling ? (
          <button type="button" class="btn btn--quiet btn--block" onClick={() => setCancelling(true)}>
            Отменить бронь
          </button>
        ) : null}
        {!cancelOk && ['pending_payment', 'confirmed', 'reserved'].includes(b.status) && role === 'reception' ? (
          <p class="hint">Бронь с предоплатой или из приложения отменяет управляющий: так предоплата вернётся гостю без ошибок.</p>
        ) : null}
        {cancelling ? (
          <form
            class="form"
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              if (reason.trim().length < 3) return;
              run(() => api.cancelBooking(b.id, reason.trim()));
            }}
            noValidate
          >
            <div class="field">
              <label class="field__label" for="bk-reason">
                Причина отмены
              </label>
              <textarea id="bk-reason" class="field__input" rows={2} maxLength={300} value={reason} aria-invalid={tried && reason.trim().length < 3 ? 'true' : undefined} onInput={(e) => setReason(e.currentTarget.value)} />
              {tried && reason.trim().length < 3 ? <p class="field__error">Напишите причину — её увидит владелец.</p> : <p class="field__hint">Например: «Гость позвонил и отменил». Уйдёт в журнал и владельцу.</p>}
            </div>
            {b.paid_kopecks ? <p class="note note--lamp">Предоплата {formatMoney(b.paid_kopecks)} вернётся гостю полностью.</p> : null}
            <div class="dialog__actions dialog__actions--row">
              <button type="submit" class="btn btn--danger btn--lg" disabled={busy}>
                {busy ? 'Отменяем…' : 'Отменить бронь'}
              </button>
              <button type="button" class="btn btn--quiet btn--lg" onClick={() => setCancelling(false)}>
                Не отменять
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </Dialog>
  );
}

const DURATIONS = [60, 90, 120, 180, 240];

/** Бронь по телефону: стол, начало, длительность, имя и телефон гостя, источник. Без предоплаты (server/bookings). */
function PhoneBookingDialog({ open, day, clubId, timeZone, onClose, onDone }) {
  const [resourceId, setResourceId] = useState('');
  const [start, setStart] = useState('');
  const [minutes, setMinutes] = useState(120);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState('phone');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setResourceId(day?.resources?.[0]?.id ?? '');
    setStart('');
    setMinutes(120);
    setName('');
    setPhone('');
    setSource('phone');
    setTried(false);
    setError(null);
  }, [open]);

  if (!open || !day) return <Dialog open={false} onClose={onClose} title="" />;
  const starts = startOptions(day);
  const at = start ? Number(start) : null;
  // M5.8 (№204): корт бронируется слотами — 1, 2, 3… слота до предела брони клуба; без тарифа корта слота нет
  const res = day.resources.find((r) => r.id === resourceId) ?? null;
  const court = familyOf(res) === 'court';
  const slot = court ? slotMinutesOf(res) : null;
  const lengths = court ? (slot ? slotOptions(slot, Math.max(1, Math.floor((day.max_minutes ?? 240) / slot))) : []) : DURATIONS;
  const durationsAt = (t) => (court ? slotDurations(day, res, t) : durationsFor(day, resourceId, t, DURATIONS));
  const lengthLabel = (m) => (court && slot ? `${slotsText(m / slot)} · ${slotLabel(m)}` : minutesShort(m));
  const allowed = at && resourceId ? durationsAt(at) : [];
  const phoneOk = normalizePhone(phone);
  const valid = resourceId && at && allowed.includes(minutes) && name.trim() && phoneOk;

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.createPhoneBooking(clubId, { resource_id: resourceId, starts_at: new Date(at).toISOString(), minutes, name: name.trim(), phone: phoneOk, source });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Бронь по телефону" labelledBy="pb-title" wide>
      <form class="form pbook" onSubmit={submit} noValidate>
        <div class="pbook__grid">
          <div class="field">
            <label class="field__label" for="pb-table">
              {day.resources.some((r) => familyOf(r) === 'court') ? 'Стол или корт' : 'Стол'}
            </label>
            <select
              id="pb-table"
              class="field__input"
              value={resourceId}
              onChange={(e) => {
                const next = day.resources.find((r) => r.id === e.currentTarget.value);
                setResourceId(e.currentTarget.value);
                // Корт — длительность слотами: при смене стола на корт и обратно берём первую подходящую длину
                const s = familyOf(next) === 'court' ? slotMinutesOf(next) : null;
                if (s) setMinutes(s);
                else if (familyOf(next) !== 'court' && !DURATIONS.includes(minutes)) setMinutes(120);
              }}
            >
              {day.resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {resourceName(r)}
                  {r.title && !/^(стол|корт)\s*\d+$/i.test(r.title.trim()) ? ` — ${r.title}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label class="field__label" for="pb-start">
              Начало, {formatDate(day.open_at, timeZone)}
            </label>
            <select id="pb-start" class="field__input" value={start} aria-invalid={tried && !at ? 'true' : undefined} onChange={(e) => setStart(e.currentTarget.value)}>
              <option value="">Выберите время</option>
              {starts.map((t) => {
                const free = durationsAt(t).length > 0;
                return (
                  <option key={t} value={String(t)} disabled={!free}>
                    {formatTime(t, timeZone)}
                    {free ? '' : ' — занято'}
                  </option>
                );
              })}
            </select>
            {tried && !at ? <p class="field__error">Выберите время начала.</p> : null}
          </div>
        </div>
        <fieldset>
          <legend class="field__label">Сколько</legend>
          <div class="pills">
            {lengths.map((m) => (
              <label class="pill" key={m}>
                <input type="radio" name="pb-len" checked={minutes === m} disabled={at !== null && !allowed.includes(m)} onChange={() => setMinutes(m)} />
                <span>{lengthLabel(m)}</span>
              </label>
            ))}
          </div>
          {court && !slot ? <p class="field__error">У корта нет цены слота: задайте цены кортов в мастере тарифов, тогда корт можно будет забронировать.</p> : null}
          {at && lengths.length && !allowed.includes(minutes) ? <p class="field__error">{familyText(`С ${formatTime(at, timeZone)} стол свободен меньше — выберите длительность короче или другой стол.`, res)}</p> : null}
        </fieldset>
        <div class="pbook__grid">
          <div class="field">
            <label class="field__label" for="pb-name">
              Имя гостя
            </label>
            <input id="pb-name" class="field__input" autoComplete="off" maxLength={100} value={name} aria-invalid={tried && !name.trim() ? 'true' : undefined} onInput={(e) => setName(e.currentTarget.value)} />
            {tried && !name.trim() ? <p class="field__error">Как обращаться к гостю.</p> : null}
          </div>
          <div class="field">
            <label class="field__label" for="pb-phone">
              Телефон
            </label>
            <input id="pb-phone" class="field__input mono" type="tel" inputMode="tel" autoComplete="off" placeholder="+7 900 000-00-00" value={phone} aria-invalid={tried && !phoneOk ? 'true' : undefined} onInput={(e) => setPhone(e.currentTarget.value)} />
            {tried && !phoneOk ? <p class="field__error">Номер из 10 цифр после +7.</p> : <p class="field__hint">В программе будет виден маской.</p>}
          </div>
        </div>
        <fieldset>
          <legend class="field__label">Откуда бронь</legend>
          <div class="pills">
            <label class="pill">
              <input type="radio" name="pb-src" checked={source === 'phone'} onChange={() => setSource('phone')} />
              <span>Позвонил</span>
            </label>
            <label class="pill">
              <input type="radio" name="pb-src" checked={source === 'staff'} onChange={() => setSource('staff')} />
              <span>Пришёл на ресепшн</span>
            </label>
          </div>
        </fieldset>
        <p class="hint">Бронь по телефону — без предоплаты: стол держим 15 минут после начала. Гость платит при приходе.</p>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Бронируем…' : at && allowed.includes(minutes) ? `Забронировать ${formatTime(at, timeZone)}–${formatTime(at + minutes * MIN, timeZone)}` : 'Забронировать'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
