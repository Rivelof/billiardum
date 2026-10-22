import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatMoney, plural } from '@billiardum/shared/format';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { parseRubles } from '../lib/cash.js';
import { packagePerHour } from '../lib/packages.js';

const HOURS = ['час', 'часа', 'часов'];
const DAYS = ['день', 'дня', 'дней'];

/**
 * Пакеты часов (управляющий, №112): «N часов за X ₽ на M дней». Создать и снять с продажи — с причиной:
 * журнал tariff.package_*, владельцу уходит уведомление. Купленные часы у гостей остаются до конца срока.
 */
export function Packages({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const l = await api.packages(clubId);
      setList(Array.isArray(l) ? l : []);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="packages" title="Пакеты часов">
      <div class="page packages">
        <div class="bookings__head">
          <p class="hint">Гость покупает пакет в приложении или на кассе и оплачивает им игру у стола. Чек — при покупке, зачёт — при списании часов.</p>
          <button type="button" class="btn btn--primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            Новый пакет
          </button>
        </div>
        <ErrorNote error={error} />
        {notice ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">{notice}</span>
          </p>
        ) : null}
        {list === null && !error ? <p class="muted">Загружаем пакеты…</p> : null}
        {list?.length === 0 ? (
          <p class="empty-queue">
            <span class="empty-queue__title">Пакетов в продаже нет</span>
            Создайте первый: например, «10 часов за 5 500 ₽ на 60 дней» — дешевле, чем по тарифу, для постоянных гостей.
          </p>
        ) : null}
        {list?.length ? (
          <ul class="plist">
            {list.map((p) => (
              <li class="prow" key={p.id}>
                <div class="prow__main">
                  <p class="prow__name">{p.title}</p>
                  <p class="prow__sub">
                    {p.hours} {plural(p.hours, HOURS)} · действует {p.valid_days} {plural(p.valid_days, DAYS)} · {formatMoney(packagePerHour(p))}/ч
                  </p>
                </div>
                <p class="prow__price mono">{formatMoney(p.price_kopecks)}</p>
                <button type="button" class="btn btn--quiet btn--sm" onClick={() => setArchiving(p)}>
                  Снять с продажи
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <CreateDialog
        open={creating}
        clubId={clubId}
        onClose={() => setCreating(false)}
        onDone={(p) => {
          setCreating(false);
          setNotice(`Пакет «${p.title}» в продаже. Владелец получил уведомление.`);
          load();
        }}
      />
      <ArchiveDialog
        pack={archiving}
        onClose={() => setArchiving(null)}
        onDone={(p) => {
          setArchiving(null);
          setNotice(`Пакет «${p.title}» снят с продажи. Купленные часы у гостей остаются.`);
          load();
        }}
      />
    </Shell>
  );
}

function CreateDialog({ open, clubId, onClose, onDone }) {
  const [title, setTitle] = useState('');
  const [hours, setHours] = useState('10');
  const [price, setPrice] = useState('');
  const [days, setDays] = useState('60');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setHours('10');
    setPrice('');
    setDays('60');
    setReason('');
    setTried(false);
    setError(null);
  }, [open]);
  const h = Number(hours);
  const d = Number(days);
  const k = parseRubles(price);
  const ok = {
    hours: Number.isInteger(h) && h >= 1 && h <= 1000,
    days: Number.isInteger(d) && d >= 1 && d <= 730,
    price: k !== null && k >= 100,
    reason: reason.trim().length >= 3,
  };
  const autoTitle = ok.hours ? `${h} ${plural(h, HOURS)}` : '';
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!Object.values(ok).every(Boolean)) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.createPackage(clubId, { title: title.trim() || autoTitle, hours: h, price_kopecks: k, valid_days: d, reason: reason.trim() }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Новый пакет часов" labelledBy="pk-title">
      <form class="form" onSubmit={submit} noValidate>
        <div class="pbook__grid">
          <div class="field">
            <label class="field__label" for="pk-hours">
              Часов
            </label>
            <input id="pk-hours" class="field__input mono" inputMode="numeric" value={hours} aria-invalid={tried && !ok.hours ? 'true' : undefined} onInput={(e) => setHours(e.currentTarget.value.replace(/\D/g, ''))} />
            {tried && !ok.hours ? <p class="field__error">Целое число часов, от 1.</p> : null}
          </div>
          <div class="field">
            <label class="field__label" for="pk-price">
              Цена, ₽
            </label>
            <input id="pk-price" class="field__input mono" inputMode="decimal" value={price} aria-invalid={tried && !ok.price ? 'true' : undefined} onInput={(e) => setPrice(e.currentTarget.value)} />
            {tried && !ok.price ? <p class="field__error">Цена не меньше 1 ₽.</p> : ok.price && ok.hours ? <p class="field__hint">{formatMoney(Math.round(k / h / 100) * 100)} за час</p> : null}
          </div>
          <div class="field">
            <label class="field__label" for="pk-days">
              Действует, дней
            </label>
            <input id="pk-days" class="field__input mono" inputMode="numeric" value={days} aria-invalid={tried && !ok.days ? 'true' : undefined} onInput={(e) => setDays(e.currentTarget.value.replace(/\D/g, ''))} />
            {tried && !ok.days ? <p class="field__error">От 1 до 730 дней.</p> : null}
          </div>
          <div class="field">
            <label class="field__label" for="pk-name">
              Название
            </label>
            <input id="pk-name" class="field__input" maxLength={100} placeholder={autoTitle || 'Например: «Утро, 8 часов»'} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
            <p class="field__hint">Пусто — «{autoTitle || 'N часов'}».</p>
          </div>
        </div>
        <div class="field">
          <label class="field__label" for="pk-reason">
            Причина
          </label>
          <input id="pk-reason" class="field__input" maxLength={300} value={reason} aria-invalid={tried && !ok.reason ? 'true' : undefined} onInput={(e) => setReason(e.currentTarget.value)} />
          {tried && !ok.reason ? <p class="field__error">Напишите причину — её увидит владелец.</p> : <p class="field__hint">Например: «Акция для постоянных гостей на ноябрь».</p>}
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Создаём…' : 'Выставить в продажу'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ArchiveDialog({ pack, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setReason('');
    setTried(false);
    setError(null);
  }, [pack?.id]);
  if (!pack) return <Dialog open={false} onClose={onClose} title="" />;
  return (
    <Dialog open onClose={onClose} title={`Снять «${pack.title}» с продажи?`} labelledBy="ar-title">
      <form
        class="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (reason.trim().length < 3) return;
          setBusy(true);
          setError(null);
          try {
            await api.archivePackage(pack.id, reason.trim());
            onDone(pack);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
        noValidate
      >
        <p class="hint">Новые гости не смогут его купить. Часы, которые уже купили, остаются на балансе до конца срока.</p>
        <div class="field">
          <label class="field__label" for="ar-reason">
            Причина
          </label>
          <input id="ar-reason" class="field__input" maxLength={300} value={reason} aria-invalid={tried && reason.trim().length < 3 ? 'true' : undefined} onInput={(e) => setReason(e.currentTarget.value)} />
          {tried && reason.trim().length < 3 ? <p class="field__error">Напишите причину — её увидит владелец.</p> : null}
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions dialog__actions--row">
          <button type="submit" class="btn btn--danger btn--lg" disabled={busy}>
            {busy ? 'Снимаем…' : 'Снять с продажи'}
          </button>
          <button type="button" class="btn btn--quiet btn--lg" onClick={onClose}>
            Оставить
          </button>
        </div>
      </form>
    </Dialog>
  );
}
