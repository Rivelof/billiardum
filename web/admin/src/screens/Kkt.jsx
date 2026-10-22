import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { formatDate, formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api, streamClub } from '../lib/api.js';
import { kktState } from '../lib/pos.js';
import { can } from '../lib/auth.js';

/**
 * Касса ККТ (владелец, решения №77, №85): мост на ПК ресепшена — исходящее WebSocket-соединение к серверу,
 * на ПК ничего не открыто. Регистрация выдаёт токен моста один раз (в базе — хеш); дальше — инструкция запуска
 * tools/kkt-bridge и ожидание, пока мост выйдет на связь.
 */
export function Kkt({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [bridges, setBridges] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [issued, setIssued] = useState(null); // { bridge, token } — только до «Готово»
  const [revoking, setRevoking] = useState(null);
  const [receipts, setReceipts] = useState(null);
  const [fixing, setFixing] = useState(null); // { receipt, mode: 'retry' | 'printed' }
  const owner = can.kktBridges(role);

  const load = useCallback(async () => {
    try {
      const [list, st, rec] = await Promise.all([api.kktBridges(clubId), api.kktStatus(clubId).catch(() => null), api.kktReceipts(clubId, 'open').catch(() => null)]);
      setBridges(Array.isArray(list) ? list : Array.isArray(list?.items) ? list.items : []);
      setStatus(st);
      if (rec) setReceipts(Array.isArray(rec) ? rec : rec.items ?? []);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);

  useEffect(() => {
    load();
    const stream = streamClub(clubId, {
      events: ['kkt'],
      onEvent: (_n, data) => {
        if (data && typeof data === 'object' && data.state) setStatus(data);
        load();
      },
      onOpen: load,
    });
    // Пока ждём новый мост — опрос чаще: SSE могут не пропустить прокси
    const poll = setInterval(load, issued ? 3000 : 30000);
    return () => {
      stream.close();
      clearInterval(poll);
    };
  }, [clubId, load, Boolean(issued)]);

  const st = kktState(status);
  const active = (bridges ?? []).filter((b) => !b.revoked_at);
  const fmt = (iso) => `${formatDate(iso, timeZone)}, ${formatTime(iso, timeZone)}`;

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="kkt" title="Касса ККТ">
      <div class="page kkt">
        <p class="hint kkt__intro">
          Чеки за наличные и карту на ресепшене печатает касса клуба. Связь с ней держит мост — небольшая программа на компьютере ресепшена. Она сама подключается к серверу и
          передаёт кассе задания на чек; на компьютере ничего не открывается наружу.
        </p>
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Обновить
          </button>
        </ErrorNote>

        {st.known ? (
          <div class={`note kkt__state${st.online && !st.warning ? ' note--free' : ' note--error'}`} role="status">
            <Icon name={st.online && !st.warning ? 'check' : 'alert'} />
            <p class="note__title">{!st.online ? 'Касса не на связи' : st.warning ? 'Касса на связи, но есть проблемы с чеками' : 'Касса на связи'}</p>
            <p class="note__body">
              {st.pending ? `В очереди ${st.pending} ${plural(st.pending, ['чек', 'чека', 'чеков'])} — пробьются, как только касса ответит. ` : 'Очередь чеков пуста. '}
              {st.failed ? `Не пробились: ${st.failed}. ` : ''}
              {!st.online ? 'Проверьте, что компьютер ресепшена включён, мост запущен, а касса подключена и в ней есть бумага.' : ''}
            </p>
          </div>
        ) : null}

        <Receipts list={receipts} timeZone={timeZone} onFix={setFixing} />

        {issued ? <Issued issued={issued} bridges={bridges ?? []} onDone={() => (setIssued(null), load())} /> : null}

        <section aria-labelledby="bridges-title">
          <h2 class="section-title" id="bridges-title">
            Мосты
            {active.length ? <span class="count">{active.length}</span> : null}
          </h2>
          {bridges === null && !error ? <p class="muted loading">Загружаем…</p> : null}
          {bridges && !active.length && !issued ? (
            <p class="hint">Мост ещё не подключён. Пока его нет, чеки за наличные и карту на ресепшене ждут в очереди и пробьются после подключения.</p>
          ) : null}
          {active.length ? (
            <ul class="bridges">
              {active.map((b) => (
                <li class={`bridge${b.online ? '' : ' bridge--off'}`} key={b.id}>
                  <div class="bridge__head">
                    <p class="bridge__name">
                      <Icon name="printer" />
                      {b.name}
                    </p>
                    <p class={`badge ${b.online ? 'badge--free' : 'badge--alert'}`}>
                      <span class="badge__dot" aria-hidden="true" />
                      {b.online ? 'На связи' : 'Не на связи'}
                    </p>
                  </div>
                  <dl class="facts facts--compact">
                    <div>
                      <dt>Касса</dt>
                      <dd>{b.kkt_model ?? 'ещё не определена'}</dd>
                    </div>
                    <div>
                      <dt>Последняя связь</dt>
                      <dd>{b.last_seen_at ? fmt(b.last_seen_at) : 'ещё не выходил на связь'}</dd>
                    </div>
                    <div>
                      <dt>Подключён</dt>
                      <dd>{b.created_at ? fmt(b.created_at) : '—'}</dd>
                    </div>
                    {b.bridge_version ? (
                      <div>
                        <dt>Версия моста</dt>
                        <dd class="mono">{b.bridge_version}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {owner ? (
                    <button type="button" class="btn btn--danger btn--sm" onClick={() => setRevoking(b)}>
                      Отключить мост
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {!issued && owner ? <Register clubId={clubId} onIssued={(res) => (setIssued(res), load())} /> : null}
        {!owner ? <p class="hint">Подключить или отключить мост может владелец клуба.</p> : null}
      </div>
      <FixReceipt
        fix={fixing}
        onClose={() => setFixing(null)}
        onDone={() => {
          setFixing(null);
          load();
        }}
      />
      <RevokeDialog
        bridge={revoking}
        onClose={() => setRevoking(null)}
        onDone={() => {
          setRevoking(null);
          load();
        }}
      />
    </Shell>
  );
}

function Register({ clubId, onIssued }) {
  const [name, setName] = useState('ПК ресепшена');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.registerBridge(clubId, n);
      // backend-kkt: { bridge, token }; старый вид заглушки — поля моста рядом с token
      onIssued({ bridge: res?.bridge ?? res, token: res?.token });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="panel kkt__reg" onSubmit={submit} noValidate aria-labelledby="reg-title">
      <h2 class="section-title" id="reg-title">
        Подключить кассу
      </h2>
      <p class="hint">Программа выдаст токен для моста. Он показывается один раз: сразу перенесите его на компьютер ресепшена.</p>
      <div class="field">
        <label class="field__label" for="bridge-name">
          Название компьютера
        </label>
        <input id="bridge-name" class="field__input" maxLength={100} value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <p class="field__hint">Так мост будет подписан в программе клуба, например «ПК ресепшена».</p>
      </div>
      <ErrorNote error={error} />
      <button type="submit" class="btn btn--primary" disabled={busy || !name.trim()}>
        <Icon name="key" />
        {busy ? 'Выдаём токен…' : 'Выдать токен моста'}
      </button>
    </form>
  );
}

function Issued({ issued, bridges, onDone }) {
  const [copied, setCopied] = useState(false);
  const tokenRef = useRef(null);
  const live = bridges.find((b) => b.id === issued.bridge?.id);
  const online = Boolean(live?.online);
  const server = `wss://${location.host}/api/kkt/ws`;
  const config = JSON.stringify({ server_url: server, token_file: 'token.txt', atol_url: 'http://127.0.0.1:16732', name: issued.bridge?.name ?? 'Ресепшн' }, null, 2);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
    } catch {
      // буфер обмена недоступен — выделяем текст, его можно скопировать вручную
      const range = document.createRange();
      range.selectNodeContents(tokenRef.current);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  return (
    <section class="panel kkt__issued" aria-labelledby="issued-title">
      <h2 class="section-title" id="issued-title">
        Токен моста «{issued.bridge?.name}»
      </h2>
      <div class="note note--lamp" role="alert">
        <Icon name="alert" />
        <p class="note__title">Токен показывается один раз</p>
        <p class="note__body">Сохраните его в файл token.txt на компьютере ресепшена. Потеряете — отключите этот мост и подключите заново.</p>
      </div>
      <div class="token">
        <code class="token__value mono" ref={tokenRef}>
          {issued.token}
        </code>
        <button type="button" class="btn btn--secondary btn--sm" onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} />
          {copied ? 'Скопировано' : 'Скопировать токен'}
        </button>
      </div>
      <p class="visually-hidden" aria-live="polite">
        {copied ? 'Токен скопирован в буфер обмена' : ''}
      </p>

      <h3 class="kkt__subtitle">Как запустить мост</h3>
      <ol class="howto">
        <li>
          <span>На компьютере ресепшена установите Node.js 22 и драйвер АТОЛ. Включите в драйвере веб-сервер (порт 16732) и проверьте, что касса видна.</span>
        </li>
        <li>
          <span>
            Скопируйте папку <code class="mono">tools/kkt-bridge</code> на компьютер, например в <code class="mono">C:\kkt-bridge</code>.
          </span>
        </li>
        <li>
          <span>
            Создайте рядом файл <code class="mono">token.txt</code> с токеном и файл настроек <code class="mono">kkt-bridge.json</code>:
            <pre class="code mono howto__code">{config}</pre>
          </span>
        </li>
        <li>
          <span>
            Запустите мост: <code class="mono">node index.mjs --config C:\kkt-bridge\kkt-bridge.json</code>
          </span>
        </li>
        <li>
          <span>Дождитесь отметки «На связи» ниже — экран обновится сам.</span>
        </li>
      </ol>
      <p class={`badge ${online ? 'badge--free' : 'badge--pending'} kkt__wait`} role="status" aria-live="polite">
        <span class="badge__dot" aria-hidden="true" />
        {online ? 'Мост на связи — касса готова печатать чеки' : 'Ждём, когда мост выйдет на связь…'}
      </p>
      <button type="button" class="btn btn--primary" onClick={onDone}>
        {online ? 'Готово' : 'Токен сохранён, скрыть его'}
      </button>
    </section>
  );
}

function RevokeDialog({ bridge, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setError(null), [bridge?.id]);
  if (!bridge) return <Dialog open={false} onClose={onClose} title="" />;
  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.revokeBridge(bridge.id);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Отключить «${bridge.name}»?`} labelledBy="revoke-title">
      <div class="form">
        <p class="lead">Токен перестанет действовать, мост отключится от сервера. Чеки будут ждать в очереди, пока вы не подключите кассу снова.</p>
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="button" class="btn btn--danger btn--lg btn--block" disabled={busy} onClick={revoke}>
            {busy ? 'Отключаем…' : 'Отключить мост'}
          </button>
          <button type="button" class="btn btn--quiet btn--block" onClick={onClose}>
            Оставить подключённым
          </button>
        </div>
      </div>
    </Dialog>
  );
}

const RECEIPT_STATE = {
  pending: ['В очереди', 'Касса пробьёт, как только ответит.'],
  unknown: ['Исход неизвестен', 'Связь прервалась во время печати. Проверьте ленту кассы: есть чек — отметьте его пробитым, нет — повторите.'],
  failed: ['Не пробился', 'Касса вернула ошибку. Исправьте причину (бумага, смена ККТ) и повторите.'],
};

/** Очередь чеков ККТ (№84): в очереди, исход неизвестен, не пробились. Повтор и «пробит» — управляющий, с причиной. */
function Receipts({ list, timeZone, onFix }) {
  if (list === null) return null;
  return (
    <section aria-labelledby="receipts-title">
      <h2 class="section-title" id="receipts-title">
        Чеки в работе
        {list.length ? <span class="count">{list.length}</span> : null}
      </h2>
      {list.length ? (
        <ul class="rlist">
          {list.map((r) => {
            const [title, text] = RECEIPT_STATE[r.status] ?? RECEIPT_STATE.pending;
            return (
              <li class={`rrow rrow--${r.status}`} key={r.id}>
                <div class="rrow__main">
                  <p class="rrow__title">
                    {r.kind === 'refund' ? 'Чек возврата' : 'Чек продажи'} <span class="mono">{formatMoney(r.amount_kopecks ?? 0)}</span>
                  </p>
                  <p class="rrow__meta">
                    {formatTime(r.created_at, timeZone)}
                    {r.operator_name ? ` · кассир ${r.operator_name}` : ''}
                    {r.attempts ? ` · попыток ${r.attempts}` : ''}
                  </p>
                </div>
                <p class={`badge ${r.status === 'pending' ? 'badge--pending' : 'badge--alert'}`}>
                  <span class="badge__dot" aria-hidden="true" />
                  {title}
                </p>
                <p class="rrow__text">{text}</p>
                {r.status !== 'pending' ? (
                  <div class="row rrow__actions">
                    <button type="button" class="btn btn--secondary btn--sm" onClick={() => onFix({ receipt: r, mode: 'retry' })}>
                      <Icon name="refresh" />
                      Повторить чек
                    </button>
                    {r.status === 'unknown' ? (
                      <button type="button" class="btn btn--quiet btn--sm" onClick={() => onFix({ receipt: r, mode: 'printed' })}>
                        <Icon name="check" />
                        Чек есть на ленте
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="hint">Все чеки пробиты. Если касса не ответит, чек появится здесь и подождёт её.</p>
      )}
    </section>
  );
}

/** Повтор чека или «пробит вручную» — ручные действия: причина обязательна, владелец получит уведомление. */
function FixReceipt({ fix, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [fd, setFd] = useState('');
  const [fp, setFp] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setReason('');
    setFd('');
    setFp('');
    setTried(false);
    setError(null);
  }, [fix?.receipt?.id, fix?.mode]);
  if (!fix) return <Dialog open={false} onClose={onClose} title="" />;
  const printed = fix.mode === 'printed';
  const ok = reason.trim().length >= 3 && (!printed || (/^\d{1,10}$/.test(fd) && /^\d{1,10}$/.test(fp)));
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      if (printed) await api.markPrinted(fix.receipt.id, { fd: Number(fd), fp, reason: reason.trim() });
      else await api.retryReceipt(fix.receipt.id, reason.trim());
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={printed ? 'Чек есть на ленте' : 'Повторить чек'} labelledBy="fix-title">
      <form class="form" onSubmit={submit} noValidate>
        <p class="lead">
          {printed
            ? 'Перепишите номера с напечатанного чека. Касса не пробьёт его второй раз.'
            : 'Касса получит задание заново. Повторяйте, только если чека нет на ленте, — иначе гость получит два чека.'}
        </p>
        {printed ? (
          <div class="row">
            <div class="field">
              <label class="field__label" for="fix-fd">
                ФД, номер документа
              </label>
              <input id="fix-fd" class="field__input mono" inputMode="numeric" value={fd} aria-invalid={tried && !/^\d{1,10}$/.test(fd) ? 'true' : undefined} onInput={(e) => setFd(e.currentTarget.value.replace(/\D/g, ''))} />
            </div>
            <div class="field">
              <label class="field__label" for="fix-fp">
                ФП, фискальный признак
              </label>
              <input id="fix-fp" class="field__input mono" inputMode="numeric" value={fp} aria-invalid={tried && !/^\d{1,10}$/.test(fp) ? 'true' : undefined} onInput={(e) => setFp(e.currentTarget.value.replace(/\D/g, ''))} />
            </div>
          </div>
        ) : null}
        <div class="field">
          <label class="field__label" for="fix-reason">
            Причина
          </label>
          <input id="fix-reason" class="field__input" maxLength={300} value={reason} aria-invalid={tried && reason.trim().length < 3 ? 'true' : undefined} onInput={(e) => setReason(e.currentTarget.value)} />
          <p class={tried && reason.trim().length < 3 ? 'field__error' : 'field__hint'}>{printed ? 'Например: «Связь оборвалась, чек на ленте есть».' : 'Например: «Заменили бумагу».'} Причину увидит владелец.</p>
        </div>
        <ErrorNote error={error} />
        <button type="submit" class="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy ? 'Отправляем…' : printed ? 'Отметить чек пробитым' : 'Поставить чек в очередь заново'}
        </button>
      </form>
    </Dialog>
  );
}
