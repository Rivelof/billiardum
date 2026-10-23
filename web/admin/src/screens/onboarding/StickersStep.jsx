import { useEffect, useState } from 'preact/hooks';
import { plural } from '@billiardum/shared/format';
import { Icon } from '../../components/Icon.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { api } from '../../lib/api.js';
import { kindLabel, kindOf } from '../../lib/hallEditor.js';

const STICKERS = ['наклейка', 'наклейки', 'наклеек'];

/** PDF в браузере: скачать файлом. */
export async function downloadPdf(res, name) {
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Шаг «QR-наклейки» (PRODUCT §16.8): PDF A4, по наклейке на стол — QR, номер стола и короткий код.
 * Можно выбрать столы: например, перепечатать одну стёртую наклейку.
 */
export function StickersStep({ ctx, ob, reload }) {
  const clubId = ctx.club.club_id;
  const [hall, setHall] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api
      .hall(clubId)
      .then((h) => {
        const list = (h ?? []).slice().sort((a, b) => a.resource.number - b.resource.number);
        setHall(list);
        setPicked(new Set(list.map((t) => t.resource.id)));
      })
      .catch(setError);
  }, [clubId]);

  const toggle = (id, on) =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const all = hall && picked.size === hall.length;

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const ids = all ? [] : hall.filter((t) => picked.has(t.resource.id)).map((t) => t.resource.id);
      await downloadPdf(await api.qrStickers(clubId, ids), 'billiardum-qr-stickers.pdf');
      setDone(true);
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const doneStep = ob.steps?.find((s) => s.id === 'stickers')?.done;

  return (
    <div class="stack ob__content">
      <p class="lead">Наклейка с QR-кодом на каждом столе: гость сканирует её, платит, и свет над столом включается.</p>
      <p class="hint">PDF на A4: на наклейке — QR, номер стола и короткий код для ручного ввода. Печатайте в масштабе 100%, без «вписать в страницу». Клейте у стола так, чтобы гость видел код со своего места.</p>
      <ErrorNote error={error} />
      {hall && !hall.length ? (
        <p class="note note--lamp">
          <Icon name="info" />
          <span class="note__title">Сначала добавьте столы на шаге «План зала».</span>
        </p>
      ) : null}
      {hall?.length ? (
        <fieldset class="stk">
          <legend class="field__label">Какие столы печатать</legend>
          <label class="check stk__all">
            <input type="checkbox" checked={all} onChange={(e) => setPicked(new Set(e.currentTarget.checked ? hall.map((t) => t.resource.id) : []))} />
            <span>Все столы</span>
          </label>
          <ul class="stk__list">
            {hall.map((t) => (
              <li key={t.resource.id}>
                <label class="check">
                  <input type="checkbox" checked={picked.has(t.resource.id)} onChange={(e) => toggle(t.resource.id, e.currentTarget.checked)} />
                  <span>
                    Стол {t.resource.number} <span class="muted small">· {kindLabel(kindOf(t.resource))}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      {done || doneStep ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">{done ? 'PDF скачан. Распечатайте и наклейте у столов.' : 'Наклейки уже печатали. Скачайте снова, если нужно перепечатать.'}</span>
        </p>
      ) : null}
      {hall?.length ? (
        <button type="button" class="btn btn--primary btn--lg" disabled={busy || !picked.size} onClick={download}>
          <Icon name="download" />
          {busy ? 'Готовим PDF…' : picked.size ? `Скачать PDF: ${picked.size} ${plural(picked.size, STICKERS)}` : 'Выберите столы'}
        </button>
      ) : null}
    </div>
  );
}
