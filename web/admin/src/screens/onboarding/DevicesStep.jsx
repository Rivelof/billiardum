import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { plural } from '@billiardum/shared/format';
import { normalizePhone } from '@billiardum/shared/booking';
import { Icon } from '../../components/Icon.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { DeviceBind } from '../../components/DeviceBind.jsx';
import { CopyButton } from '../../components/InviteShare.jsx';
import { api, streamClub } from '../../lib/api.js';
import { mergeHall } from '../../lib/hall.js';
import { ELECTRICIAN_TEXT, canWebShare, kitLeadBody } from '../../lib/onboarding.js';
import { signalWord } from '../../lib/devices.js';

const CONTROLLERS = ['контроллер', 'контроллера', 'контроллеров'];

/**
 * Шаг «Контроллеры» (№159): по контроллеру на стол. Свои — привязка по QR с корпуса (сканер) или вручную;
 * нет своих — «Заказать комплект» (заявка Андрею). Монтаж — электрик клуба по инструкции.
 * Статус «на связи» по столам обновляется сам (SSE hall и опрос).
 */
export function DevicesStep({ ctx, reload }) {
  const clubId = ctx.club.club_id;
  const [hall, setHall] = useState(null);
  const [error, setError] = useState(null);
  const prevOnline = useRef(0);

  const load = useCallback(async () => {
    try {
      setHall(await api.hall(clubId));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);
  useEffect(() => {
    load();
    const stream = streamClub(clubId, { events: ['hall'], onEvent: (name, d) => name === 'hall' && d && setHall((h) => mergeHall(h, d)), onOpen: load });
    const poll = setInterval(load, 10000);
    return () => {
      stream.close();
      clearInterval(poll);
    };
  }, [clubId, load]);

  const tables = (hall ?? []).slice().sort((a, b) => a.resource.number - b.resource.number);
  const online = tables.filter((t) => t.device?.id && t.device.online).length;
  const missing = tables.filter((t) => !t.device?.id).length;
  // Новый контроллер вышел на связь — отметка шага на сервере могла измениться
  useEffect(() => {
    if (online !== prevOnline.current) {
      prevOnline.current = online;
      reload();
    }
  }, [online]);

  return (
    <div class="stack ob__content">
      <p class="lead">На каждый стол — контроллер: он включает свет над столом только по команде сервера после оплаты.</p>
      <ErrorNote error={error} />
      {hall && !tables.length ? (
        <p class="note note--lamp">
          <Icon name="info" />
          <span class="note__title">Сначала добавьте столы на шаге «План зала» — контроллер привязывается к столу.</span>
        </p>
      ) : null}

      {tables.length ? (
        <section aria-labelledby="dv-status">
          <h3 class="section-title" id="dv-status">
            На связи {online} из {tables.length}
          </h3>
          <ul class="dvs">
            {tables.map((t) => {
              const d = t.device ?? {};
              const state = !d.id ? 'none' : d.online ? 'on' : 'off';
              return (
                <li key={t.resource.id} class={`dvs__item dvs__item--${state}`}>
                  <span class="display dvs__num">Стол {t.resource.number}</span>
                  <span class={`badge ${state === 'on' ? 'badge--free' : state === 'off' ? 'badge--alert' : 'badge--off'}`}>
                    <Icon name={state === 'on' ? 'check' : state === 'off' ? 'alert' : 'minus'} />
                    {state === 'on' ? 'На связи' : state === 'off' ? 'Нет связи' : 'Не привязан'}
                  </span>
                  {state === 'on' && Number.isFinite(d.rssi) ? <span class="small muted">Wi-Fi {signalWord(d.rssi)}</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {tables.length ? <DeviceBind clubId={clubId} tables={tables} timeZone={ctx.timeZone} headingLevel={3} /> : null}

      <KitOrder clubId={clubId} clubName={ctx.club.name ?? 'Клуб'} count={missing || tables.length || 1} />
      <Electrician />
    </div>
  );
}

/** «Заказать комплект» → заявка kind: kit (в форме лида M4: имя, телефон, город, согласие). */
function KitOrder({ clubId, clubName, count }) {
  const started = useRef(Date.now());
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', city: '', count: String(count), comment: '', consent: false });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const phone = normalizePhone(form.phone);
  const n = Number(form.count);
  const errors = {
    ...(form.name.trim().length < 2 ? { name: 'Как к вам обращаться.' } : {}),
    ...(!phone ? { phone: 'Номер из 10 цифр после +7.' } : {}),
    ...(form.city.trim().length < 2 ? { city: 'Куда везти комплект.' } : {}),
    ...(!Number.isInteger(n) || n < 1 || n > 200 ? { count: 'От 1 до 200.' } : {}),
    ...(!form.consent ? { consent: 'Без согласия мы не сможем связаться по заявке.' } : {}),
  };
  const show = (k) => tried && errors[k];
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  if (sent) {
    return (
      <section class="panel" aria-labelledby="kit-title">
        <h3 class="section-title" id="kit-title">
          Комплект контроллеров
        </h3>
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">Заявка отправлена. Мы позвоним, уточним зал и сроки доставки.</span>
        </p>
      </section>
    );
  }

  return (
    <section class="panel" aria-labelledby="kit-title">
      <h3 class="section-title" id="kit-title">
        Нет своих контроллеров?
      </h3>
      <p class="hint">Закажите комплект: контроллеры с наклейками QR, автоматы и корпуса. Монтаж делает электрик клуба по инструкции ниже.</p>
      {!open ? (
        <button type="button" class="btn btn--secondary" onClick={() => setOpen(true)}>
          <Icon name="box" />
          Заказать комплект
        </button>
      ) : (
        <form
          class="form kit"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setTried(true);
            if (Object.keys(errors).length) {
              document.getElementById(`kit-${Object.keys(errors)[0]}`)?.focus();
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await api.kitLead(kitLeadBody({ ...form, phone }, { clubId, clubName, city: form.city.trim(), elapsedMs: Date.now() - started.current }));
              setSent(true);
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div class="kit__grid">
            <KitField id="kit-name" label="Имя" value={form.name} error={show('name')} onInput={(v) => set({ name: v })} autoComplete="name" />
            <KitField id="kit-phone" label="Телефон" value={form.phone} error={show('phone')} onInput={(v) => set({ phone: v })} type="tel" autoComplete="tel" mono />
            <KitField id="kit-city" label="Город доставки" value={form.city} error={show('city')} onInput={(v) => set({ city: v })} autoComplete="address-level2" />
            <KitField id="kit-count" label="Сколько контроллеров" value={form.count} error={show('count')} onInput={(v) => set({ count: v })} inputMode="numeric" mono hint={Number.isInteger(n) && n > 0 ? `${n} ${plural(n, CONTROLLERS)}` : null} />
          </div>
          <div class="field">
            <label class="field__label" for="kit-comment">
              Комментарий (по желанию)
            </label>
            <textarea id="kit-comment" class="field__input field__input--area" rows={2} maxLength={1000} value={form.comment} onInput={(e) => set({ comment: e.currentTarget.value })} />
          </div>
          <label class="check">
            <input id="kit-consent" type="checkbox" checked={form.consent} aria-invalid={show('consent') ? 'true' : undefined} onChange={(e) => set({ consent: e.currentTarget.checked })} />
            <span>
              Согласен на обработку имени и телефона, чтобы со мной связались по заявке, по{' '}
              <a href="/app/privacy" target="_blank" rel="noopener">
                политике обработки персональных данных
              </a>
              .
            </span>
          </label>
          {show('consent') ? <p class="field__error">{errors.consent}</p> : null}
          <ErrorNote error={error} />
          <button type="submit" class="btn btn--primary" disabled={busy}>
            {busy ? 'Отправляем…' : 'Отправить заявку на комплект'}
          </button>
        </form>
      )}
    </section>
  );
}

function KitField({ id, label, value, error, onInput, hint, mono, ...rest }) {
  return (
    <div class="field">
      <label class="field__label" for={id}>
        {label}
      </label>
      <input id={id} class={`field__input${mono ? ' mono' : ''}`} value={value} aria-invalid={error ? 'true' : undefined} aria-describedby={error || hint ? `${id}-e` : undefined} onInput={(e) => onInput(e.currentTarget.value)} {...rest} />
      {error || hint ? (
        <p class={error ? 'field__error' : 'field__hint'} id={`${id}-e`}>
          {error || hint}
        </p>
      ) : null}
    </div>
  );
}

/** Инструкция электрику: текстом на экране, «Скопировать» и «Поделиться». */
function Electrician() {
  const share = { title: 'Монтаж контроллеров Бильярдума', text: ELECTRICIAN_TEXT };
  const sharable = canWebShare(globalThis.navigator, share);
  const [title, ...lines] = ELECTRICIAN_TEXT.split('\n').filter(Boolean);
  return (
    <section class="panel" aria-labelledby="el-title">
      <h3 class="section-title" id="el-title">
        Инструкция электрику
      </h3>
      <details class="eltext">
        <summary>{title}</summary>
        <ol class="eltext__list">
          {lines.map((l) => (
            <li key={l}>{l.replace(/^\d+\.\s*/, '')}</li>
          ))}
        </ol>
      </details>
      <div class="row">
        {sharable ? (
          <button type="button" class="btn btn--secondary" onClick={() => navigator.share(share).catch(() => {})}>
            <Icon name="share" />
            Отправить электрику
          </button>
        ) : null}
        <CopyButton text={ELECTRICIAN_TEXT} label="Скопировать инструкцию" />
      </div>
    </section>
  );
}
