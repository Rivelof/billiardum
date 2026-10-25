import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { formatDate, formatMoney } from '@billiardum/shared/format';
import { Shell } from '../../components/Shell.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Dialog } from '../../components/Dialog.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { InviteShare } from '../../components/InviteShare.jsx';
import { useClubNetwork } from '../../components/NetworkNote.jsx';
import { api } from '../../lib/api.js';
import { auth, can, loadMe } from '../../lib/auth.js';
import { useStore } from '../../lib/store.js';
import { BASE } from '../../lib/env.js';
import { linkHandler, navigate } from '../../lib/router.js';
import {
  MODE_LABEL,
  PERSONAL_LOGIN_TEXT,
  addClubError,
  addClubPlan,
  addableClubs,
  cleanName,
  clubsWord,
  managerStatusText,
  networkNameError,
  networkRights,
  normalizePhone,
  pickNetwork,
  productsWord,
  reasonError,
  sectionsFor,
} from '../../lib/networks.js';
import { ClubModeBadge, ConfirmDialog, ReasonField } from './parts.jsx';
import { NetworkTariffs } from './NetworkTariffs.jsx';
import { NetworkMenu } from './NetworkMenu.jsx';
import '../../styles/dashboard.css';
import '../../styles/network.css';

const PIN_NOTE_ID = 'net-pin';

/**
 * M5.5 «Сеть» (№190–194, server/networks/README.md): сеть клубов владельца — состав, режимы шаблонов, управляющие сети,
 * шаблоны тарифов и меню. Владелец меняет, управляющий сети читает. Только личный вход: при PIN — плашка, кнопки неактивны.
 * Путь — /club/c/{club}/network[/{network_id}], раздел — ?s=clubs|managers|tariffs|menu. Отдельный чанк.
 */
export function Network({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const { networks, principal } = useStore(auth);
  const pin = principal === 'pin';
  const chosen = pickNetwork(networks, club, ctx.id);
  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="network" title="Сеть">
      <div class="page net">
        {pin ? (
          <div class="note note--lamp" id={PIN_NOTE_ID}>
            <Icon name="lock" />
            <p class="note__title">Вы вошли по PIN на терминале</p>
            <p class="note__body">{PERSONAL_LOGIN_TEXT}</p>
          </div>
        ) : null}
        {pin ? (
          <PinView ctx={ctx} />
        ) : chosen ? (
          <>
            {networks.length > 1 ? <NetworkPick networks={networks} value={chosen.network_id} clubId={club.club_id} /> : null}
            <NetworkView key={chosen.network_id} id={chosen.network_id} ctx={ctx} />
          </>
        ) : (
          <NoNetwork ctx={ctx} />
        )}
      </div>
    </Shell>
  );
}

const netPath = (clubId, id, section) => `${BASE}c/${encodeURIComponent(clubId)}/network${id ? `/${encodeURIComponent(id)}` : ''}${section && section !== 'clubs' ? `?s=${section}` : ''}`;

function NetworkPick({ networks, value, clubId }) {
  return (
    <label class="dfield net__pick">
      <span class="dfield__label">Сеть</span>
      <select class="field__input" value={value} onChange={(e) => navigate(netPath(clubId, e.currentTarget.value))}>
        {networks.map((n) => (
          <option key={n.network_id} value={n.network_id}>
            {n.name} · {clubsWord(n.clubs ?? 0)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** По PIN список сетей сервер не отдаёт: показываем сеть этого клуба (GET /api/clubs/{club}/network) и неактивные кнопки. */
function PinView({ ctx }) {
  const [net] = useClubNetwork(ctx.club.club_id);
  if (net === undefined) return <p class="muted loading">Загружаем сеть клуба…</p>;
  if (!net) {
    return (
      <section class="panel net__intro" aria-labelledby="net-none">
        <h2 class="section-title" id="net-none">
          Клуб не входит в сеть
        </h2>
        <p>Сеть объединяет клубы одного владельца: общие тарифы и меню, управляющие сети и сравнение клубов на дашборде.</p>
        <button type="button" class="btn btn--primary" disabled aria-describedby={PIN_NOTE_ID}>
          <Icon name="plus" />
          Создать сеть
        </button>
      </section>
    );
  }
  return (
    <section class="panel net__intro" aria-labelledby="net-pin-title">
      <h2 class="section-title" id="net-pin-title">
        Клуб в сети «{net.name}»
      </h2>
      <dl class="net__facts">
        <div>
          <dt>Шаблон тарифов</dt>
          <dd>{net.tariffs?.template ? `${MODE_LABEL[net.tariffs.mode] ?? net.tariffs.mode}${net.tariffs.override ? ', в клубе свои тарифы' : ''}` : 'нет'}</dd>
        </div>
        <div>
          <dt>Шаблон меню</dt>
          <dd>{net.menu?.template ? `${MODE_LABEL[net.menu.mode] ?? net.menu.mode}${net.menu.overrides ? `, изменено в клубе: ${productsWord(net.menu.overrides)}` : ''}` : 'нет'}</dd>
        </div>
      </dl>
      <div class="row">
        <button type="button" class="btn btn--secondary" disabled aria-describedby={PIN_NOTE_ID}>
          <Icon name="edit" />
          Изменить сеть
        </button>
      </div>
    </section>
  );
}

/** Сети нет: владельцу — что это и форма «Создать сеть», остальным — объяснение. */
function NoNetwork({ ctx }) {
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const owner = can.owner(ctx.role);
  const err = networkNameError(name);
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (err) {
      document.getElementById('net-name')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const n = await api.createNetwork(cleanName(name));
      await loadMe().catch(() => {});
      navigate(netPath(ctx.club.club_id, n?.id));
    } catch (ex) {
      setError(ex);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="panel net__intro" aria-labelledby="net-none">
      <h2 class="section-title" id="net-none">
        {owner ? 'Объедините свои клубы в сеть' : 'У вас пока нет сети клубов'}
      </h2>
      <ul class="net__points">
        <li>
          <Icon name="list" />
          <span>Общие тарифы и меню: шаблон сети записывается в каждый клуб, цены — по местному времени клуба.</span>
        </li>
        <li>
          <Icon name="users" />
          <span>Управляющий сети работает во всех клубах сети как управляющий — без денег по способам оплаты и выгрузок.</span>
        </li>
        <li>
          <Icon name="chart" />
          <span>Сравнение клубов на дашборде: загрузка и выручка со стола, рейтинг.</span>
        </li>
      </ul>
      {owner ? (
        <form class="form net__create" onSubmit={submit} noValidate>
          <div class="field">
            <label class="field__label" for="net-name">
              Название сети
            </label>
            <input id="net-name" class="field__input" maxLength={120} value={name} aria-invalid={tried && err ? 'true' : undefined} aria-describedby="net-name-e" onInput={(e) => setName(e.currentTarget.value)} />
            <p class={tried && err ? 'field__error' : 'field__hint'} id="net-name-e">
              {tried && err ? err : 'Его видите вы и управляющие сети. Гостям название сети не показывается.'}
            </p>
          </div>
          <ErrorNote error={error} />
          <button type="submit" class="btn btn--primary" disabled={busy}>
            <Icon name="plus" />
            {busy ? 'Создаём сеть…' : 'Создать сеть'}
          </button>
          <p class="small muted">Добавить в сеть можно только клубы, где вы владелец. Клуб входит не больше чем в одну сеть.</p>
        </form>
      ) : (
        <p class="hint">Сеть создаёт владелец клубов. Если вас пригласили управляющим сети, войдите с номера из приглашения — доступ откроется сам.</p>
      )}
    </section>
  );
}

function NetworkView({ id, ctx }) {
  const { club, timeZone } = ctx;
  const { clubs: memberships, principal } = useStore(auth);
  const [n, setN] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [section, setSection] = useState(() => new URLSearchParams(location.search).get('s') || 'clubs');
  const load = useCallback(async () => {
    try {
      setN(await api.network(id));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (error && !n) {
    return (
      <ErrorNote error={error}>
        <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
          Повторить
        </button>
      </ErrorNote>
    );
  }
  if (!n) return <p class="muted loading">Загружаем сеть…</p>;
  const rights = networkRights(n, principal);
  const sections = sectionsFor(n.role);
  const current = sections.some((s) => s.value === section) ? section : 'clubs';
  const choose = (s) => {
    setSection(s);
    setNotice(null);
    history.replaceState(null, '', netPath(club.club_id, id, s));
  };
  const changed = (next, text) => {
    if (next) setN(next);
    else load();
    if (text) setNotice(text);
    loadMe().catch(() => {});
  };
  return (
    <>
      <header class="net__head">
        <div class="net__title">
          <h2 class="net__name display">{n.name}</h2>
          <p class="net__sub">
            <span class="nbadge nbadge--net">
              <Icon name={n.role === 'owner' ? 'key' : 'user'} />
              {n.role === 'owner' ? 'Вы — владелец сети' : 'Вы — управляющий сети'}
            </span>
            <span>{clubsWord(n.clubs?.length ?? 0)}</span>
          </p>
        </div>
        <a class="btn btn--quiet btn--sm" href={`${BASE}c/${encodeURIComponent(club.club_id)}/dashboard?tab=network`} onClick={linkHandler}>
          <Icon name="chart" />
          Сравнить клубы
        </a>
      </header>
      {notice ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">{notice}</span>
        </p>
      ) : null}
      <ErrorNote error={error} />
      <SectionTabs sections={sections} value={current} onChange={choose} />
      <div class="net__panel" role="tabpanel" id={`net-panel-${current}`} aria-labelledby={`net-tab-${current}`} tabIndex={-1}>
        {current === 'clubs' ? <ClubsSection n={n} rights={rights} memberships={memberships} ctx={ctx} onChanged={changed} /> : null}
        {current === 'managers' ? <ManagersSection n={n} rights={rights} timeZone={timeZone} /> : null}
        {current === 'tariffs' ? <NetworkTariffs n={n} rights={rights} ctx={ctx} onNetwork={changed} /> : null}
        {current === 'menu' ? <NetworkMenu n={n} rights={rights} ctx={ctx} onNetwork={changed} /> : null}
      </div>
    </>
  );
}

/** Разделы сети: на телефоне — сегменты сеткой, на широком — строка; стрелки переключают. */
function SectionTabs({ sections, value, onChange }) {
  const refs = useRef({});
  const onKeyDown = (e) => {
    const i = sections.findIndex((t) => t.value === value);
    const map = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 };
    let next = null;
    if (map[e.key]) next = sections[(i + map[e.key] + sections.length) % sections.length];
    else if (e.key === 'Home') next = sections[0];
    else if (e.key === 'End') next = sections[sections.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    refs.current[next.value]?.focus();
  };
  return (
    <div class={`ntabs ntabs--${sections.length}`} role="tablist" aria-label="Разделы сети" onKeyDown={onKeyDown}>
      {sections.map((t) => (
        <button
          key={t.value}
          ref={(el) => (refs.current[t.value] = el)}
          type="button"
          role="tab"
          id={`net-tab-${t.value}`}
          class="dtabs__tab ntabs__tab"
          aria-selected={t.value === value ? 'true' : 'false'}
          aria-controls={t.value === value ? `net-panel-${t.value}` : undefined}
          tabIndex={t.value === value ? 0 : -1}
          onClick={() => onChange(t.value)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------- клубы сети ----------

function ClubsSection({ n, rights, memberships, ctx, onChanged }) {
  const [adding, setAdding] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [needReason, setNeedReason] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // addClubError(): { error, clubName, hint }
  const [removing, setRemoving] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const candidates = addableClubs(memberships, n);
  const clubs = Array.isArray(n.clubs) ? n.clubs : [];
  const disabledWhy = rights.pin ? PIN_NOTE_ID : undefined;
  // M5.5: шаблоны сети применяются к клубу сразу; клуб в боевом режиме — ручное действие с причиной
  const pickedId = adding || candidates[0]?.club_id;
  const picked = candidates.find((c) => c.club_id === pickedId) ?? null;
  const plan = addClubPlan(n, picked);
  const reasonShown = plan.reasonNeeded || needReason;
  const rErr = reasonShown ? reasonError(reason, true) : null;
  const pick = (value) => {
    setAdding(value);
    setNeedReason(false);
    setError(null);
  };
  const add = async (e) => {
    e.preventDefault();
    const id = pickedId;
    if (!id) return;
    setTried(true);
    if (rErr) {
      document.getElementById('net-add-reason')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const name = picked?.name ?? 'Клуб';
    try {
      const next = await api.addNetworkClub(n.id, id, reasonShown ? reason.trim() : undefined);
      setAdding('');
      setReason('');
      setTried(false);
      setNeedReason(false);
      onChanged(next, `«${name}» теперь в сети «${n.name}».${plan.warning ? ' Шаблоны сети применены.' : ''}`);
    } catch (err) {
      const view = addClubError(err, name);
      if (view.needReason) {
        setNeedReason(true);
        setTried(true);
      }
      setError(view);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="net__stack">
      <section class="panel" aria-labelledby="net-clubs">
        <div class="net__row">
          <h3 class="section-title" id="net-clubs">
            Клубы сети <span class="count">{clubs.length}</span>
          </h3>
          {rights.owner ? (
            <button type="button" class="btn btn--quiet btn--sm" onClick={() => setRenaming(true)} disabled={!rights.edit} aria-describedby={disabledWhy}>
              <Icon name="edit" />
              Переименовать сеть
            </button>
          ) : null}
        </div>
        {clubs.length ? (
          <ul class="nclubs">
            {clubs.map((c) => (
              <li key={c.club_id} class="nclub">
                <div class="nclub__main">
                  <p class="nclub__name">{c.name ?? 'Клуб'}</p>
                  <p class="nclub__sub">
                    {[c.city, c.timezone ? `пояс ${c.timezone}` : null, `сутки с ${c.day_start_local ?? '06:00'}`].filter(Boolean).join(' · ')}
                  </p>
                  <p class="nclub__tags">
                    <ClubModeBadge mode={c.mode} />
                    {n.tariffs?.template && c.tariffs_override && n.tariffs_mode !== 'hard' ? (
                      <span class="nbadge nbadge--own">
                        <Icon name="edit" />
                        Свои тарифы клуба
                      </span>
                    ) : null}
                  </p>
                </div>
                {rights.owner ? (
                  <button type="button" class="btn btn--quiet btn--sm nclub__act" onClick={() => setRemoving(c)} disabled={!rights.edit} aria-describedby={disabledWhy}>
                    Убрать из сети
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p class="hint">В сети пока нет клубов. Добавьте свой клуб — шаблоны и сравнение заработают сразу.</p>
        )}
      </section>

      {rights.owner ? (
        <section class="panel" aria-labelledby="net-add">
          <h3 class="section-title" id="net-add">
            Добавить клуб
          </h3>
          {candidates.length ? (
            <form class="net__add" onSubmit={add}>
              <label class="dfield">
                <span class="dfield__label">Ваш клуб</span>
                <select class="field__input" value={pickedId} onChange={(e) => pick(e.currentTarget.value)} disabled={!rights.edit}>
                  {candidates.map((c) => (
                    <option key={c.club_id} value={c.club_id}>
                      {c.name ?? 'Клуб'}
                    </option>
                  ))}
                </select>
              </label>
              {plan.warning ? (
                <p class="note note--lamp net__addnote">
                  <Icon name="info" />
                  <span class="note__title">Тарифы и меню клуба изменятся сразу</span>
                  <span class="note__body">{plan.warning}</span>
                </p>
              ) : null}
              {reasonShown ? (
                <ReasonField
                  id="net-add-reason"
                  label="Причина добавления"
                  hint="Клуб в боевом режиме: это ручное действие. Причина уйдёт в журнал клуба и владельцу в уведомлении."
                  value={reason}
                  onInput={setReason}
                  error={tried ? rErr : null}
                />
              ) : null}
              <button type="submit" class="btn btn--primary" disabled={busy || !rights.edit} aria-describedby={disabledWhy}>
                <Icon name="plus" />
                {busy ? 'Добавляем…' : plan.warning ? 'Добавить и применить шаблоны' : 'Добавить в сеть'}
              </button>
            </form>
          ) : (
            <p class="hint">
              Все клубы, где вы владелец, уже в этой сети.{' '}
              <a href={`${BASE}start`} onClick={linkHandler}>
                Подключить ещё клуб
              </a>
            </p>
          )}
          <p class="small muted">Добавить можно только клуб, где вы владелец. Клуб входит не больше чем в одну сеть, в сети — до 100 клубов.</p>
          <ErrorNote error={error?.error} clubName={error?.clubName}>
            {error?.hint ? <p class="small">{error.hint}</p> : null}
          </ErrorNote>
        </section>
      ) : null}

      <PlanNote plan={n.plan} clubs={clubs.length} />

      {rights.owner ? (
        <section class="panel net__danger" aria-labelledby="net-del">
          <h3 class="section-title" id="net-del">
            Удалить сеть
          </h3>
          <p class="hint">Клубы выйдут из сети, управляющие сети потеряют доступ. Тарифы и меню клубов останутся как есть.</p>
          <button type="button" class="btn btn--danger btn--sm" onClick={() => setArchiving(true)} disabled={!rights.edit} aria-describedby={disabledWhy}>
            <Icon name="trash" />
            Удалить сеть
          </button>
        </section>
      ) : null}

      <ConfirmDialog
        open={Boolean(removing)}
        title={removing ? `Убрать «${removing.name ?? 'клуб'}» из сети?` : ''}
        action="Убрать клуб из сети"
        danger
        labelId="net-rm"
        onClose={() => setRemoving(null)}
        run={async () => {
          const next = await api.removeNetworkClub(n.id, removing.club_id);
          const name = removing.name ?? 'Клуб';
          setRemoving(null);
          onChanged(next, `«${name}» больше не в сети. Его тарифы и меню остались как были.`);
        }}
      >
        <p>Тарифы и меню клуба останутся как есть, но шаблоны сети их больше не меняют. Управляющие сети сразу потеряют доступ к этому клубу.</p>
      </ConfirmDialog>
      <RenameDialog open={renaming} n={n} onClose={() => setRenaming(false)} onDone={(next) => {
        setRenaming(false);
        onChanged(next, `Сеть называется «${next?.name ?? n.name}».`);
      }} />
      <ConfirmDialog
        open={archiving}
        title={`Удалить сеть «${n.name}»?`}
        action="Удалить сеть"
        danger
        labelId="net-arch"
        onClose={() => setArchiving(false)}
        run={async () => {
          await api.deleteNetwork(n.id);
          setArchiving(false);
          await loadMe().catch(() => {});
          navigate(netPath(ctx.club.club_id));
        }}
      >
        <p>
          {clubsWord(clubs.length)} выйдут из сети, приглашения и доступ управляющих сети закроются. Тарифы и меню клубов останутся как есть. Вернуть сеть нельзя — только создать заново.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function PlanNote({ plan, clubs }) {
  if (!plan || !plan.active) return null;
  return (
    <section class="panel net__plan" aria-labelledby="net-plan">
      <h3 class="section-title" id="net-plan">
        Подписка «{plan.title ?? 'Сеть'}»
      </h3>
      <p>
        <b>{formatMoney(plan.price_per_table_kopecks)}</b> за стол в месяц для клубов сети из двух клубов и больше.
      </p>
      <p class={`nbadge${plan.applies ? ' nbadge--live' : ''}`}>
        <Icon name={plan.applies ? 'check' : 'info'} />
        {plan.applies ? 'Действует для клубов этой сети' : clubs < 2 ? 'Пока в сети один клуб — действует план «Клуб»' : 'Пока не действует'}
      </p>
      <p class="small muted">Персональная цена клуба, если она есть, главнее плана. Счета — в разделе «Подписка» каждого клуба.</p>
    </section>
  );
}

function RenameDialog({ open, n, onClose, onDone }) {
  const [name, setName] = useState(n.name);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setName(n.name);
    setTried(false);
    setError(null);
  }, [open]);
  const err = networkNameError(name);
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (err) return;
    setBusy(true);
    try {
      onDone(await api.updateNetwork(n.id, { name: cleanName(name) }));
    } catch (ex) {
      setError(ex);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Название сети" labelledBy="net-ren">
      <form class="form" onSubmit={submit} noValidate>
        <div class="field">
          <label class="field__label" for="net-ren-name">
            Название
          </label>
          <input id="net-ren-name" class="field__input" maxLength={120} value={name} aria-invalid={tried && err ? 'true' : undefined} aria-describedby="net-ren-e" onInput={(e) => setName(e.currentTarget.value)} />
          <p class={tried && err ? 'field__error' : 'field__hint'} id="net-ren-e">
            {tried && err ? err : 'До 100 символов.'}
          </p>
        </div>
        <ErrorNote error={error} />
        <button type="submit" class="btn btn--primary" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Сохранить название'}
        </button>
      </form>
    </Dialog>
  );
}

// ---------- управляющие сети (владелец) ----------

function ManagersSection({ n, rights, timeZone }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [inviting, setInviting] = useState(false);
  const [shared, setShared] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [notice, setNotice] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api.networkManagers(n.id));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [n.id]);
  useEffect(() => {
    load();
  }, [load]);
  const items = Array.isArray(data?.items) ? data.items : [];
  const active = items.filter((m) => m.status === 'active');
  const invited = items.filter((m) => m.status !== 'active');
  return (
    <div class="net__stack">
      <section class="panel" aria-labelledby="net-mgr">
        <div class="net__row">
          <h3 class="section-title" id="net-mgr">
            Управляющие сети
          </h3>
          <button type="button" class="btn btn--primary btn--sm" onClick={() => setInviting(true)} disabled={!rights.edit} aria-describedby={rights.pin ? PIN_NOTE_ID : undefined}>
            <Icon name="plus" />
            Пригласить управляющего
          </button>
        </div>
        <p class="hint">Управляющий сети работает во всех клубах сети как управляющий: зал, тарифы, меню, смены, касса управляющего. Деньги по способам оплаты и выгрузки CSV ему не видны. Состав сети и шаблоны меняете только вы.</p>
        {notice ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">{notice}</span>
          </p>
        ) : null}
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Повторить
          </button>
        </ErrorNote>
        {shared ? <InviteShare invite={shared} title="Отправьте приглашение управляющему" /> : null}
        {!data && !error ? <p class="muted loading">Загружаем управляющих…</p> : null}
        {data && !items.length ? <p class="muted">Управляющих сети пока нет. Пригласите человека по номеру телефона — он войдёт со своего телефона, и доступ к клубам сети откроется сам.</p> : null}
        {active.length || invited.length ? (
          <ul class="people">
            {[...active, ...invited].map((m) => (
              <li key={m.id} class={`person${m.status === 'active' ? '' : ' person--invite'}`}>
                <span class="person__main">
                  <span class="person__name">{m.name ?? <span class="mono">{m.phone_masked}</span>}</span>
                  <span class="person__sub">
                    {m.name ? <span class="mono">{m.phone_masked}</span> : null}
                    {m.name ? ' · ' : ''}
                    {managerStatusText(m, timeZone)}
                  </span>
                </span>
                <span class="person__tools">
                  <span class={`nbadge${m.status === 'active' ? ' nbadge--live' : ' nbadge--test'}`}>
                    <Icon name={m.status === 'active' ? 'check' : 'clock'} />
                    {m.status === 'active' ? 'Работает' : 'Приглашён'}
                  </span>
                  <button type="button" class="btn btn--quiet btn--sm person__revoke" onClick={() => setRevoking(m)} disabled={!rights.edit} aria-describedby={rights.pin ? PIN_NOTE_ID : undefined}>
                    {m.status === 'active' ? 'Отозвать доступ' : 'Отозвать приглашение'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <InviteManagerDialog
        open={inviting}
        n={n}
        onClose={() => setInviting(false)}
        onDone={(inv) => {
          setInviting(false);
          setShared(inv);
          setNotice(`Приглашение на ${inv.phone_masked} создано. Действует до ${formatDate(inv.expires_at, timeZone)}.`);
          load();
        }}
      />
      <ConfirmDialog
        open={Boolean(revoking)}
        title={revoking?.status === 'active' ? `Отозвать доступ ${revoking?.name ?? revoking?.phone_masked ?? ''}?` : `Отозвать приглашение на ${revoking?.phone_masked ?? ''}?`}
        action={revoking?.status === 'active' ? 'Отозвать доступ' : 'Отозвать приглашение'}
        danger
        labelId="net-revoke"
        onClose={() => setRevoking(null)}
        run={async () => {
          await api.revokeNetworkManager(n.id, revoking.id);
          const who = revoking.name ?? revoking.phone_masked;
          const wasActive = revoking.status === 'active';
          setRevoking(null);
          setShared(null);
          setNotice(wasActive ? `Доступ ${who} ко всем клубам сети закрыт. PIN стёрт, входы на терминалах закрыты.` : `Приглашение на ${who} отозвано.`);
          load();
        }}
      >
        <p>
          {revoking?.status === 'active'
            ? 'Доступ ко всем клубам сети закроется сразу: PIN стирается, входы на терминалах закрываются.'
            : 'Ссылка из приглашения перестанет работать. Пригласить снова можно в любой момент.'}
        </p>
      </ConfirmDialog>
    </div>
  );
}

function InviteManagerDialog({ open, n, onClose, onDone }) {
  const [phone, setPhone] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setPhone('');
    setTried(false);
    setError(null);
  }, [open]);
  const e164 = normalizePhone(phone);
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!e164) {
      document.getElementById('nm-phone')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await api.inviteNetworkManager(n.id, e164));
    } catch (err) {
      // 409 duplicate — уже управляющий сети или свой номер
      setError(err?.code === 'duplicate' ? { code: 'network_manager_duplicate' } : err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Пригласить управляющего сети" labelledBy="nm-title">
      <form class="form" onSubmit={submit} noValidate>
        <div class="field">
          <label class="field__label" for="nm-phone">
            Телефон
          </label>
          <input id="nm-phone" class="field__input mono" type="tel" inputMode="tel" autoComplete="off" placeholder="+7 900 000-00-00" value={phone} aria-invalid={tried && !e164 ? 'true' : undefined} aria-describedby="nm-phone-e" onInput={(ev) => setPhone(ev.currentTarget.value)} />
          <p class={tried && !e164 ? 'field__error' : 'field__hint'} id="nm-phone-e">
            {tried && !e164 ? 'Нужен российский номер: +7 и 10 цифр.' : `Приглашение действует 7 дней. Человек войдёт с этим номером — и получит доступ ко всем клубам сети «${n.name}».`}
          </p>
        </div>
        <ErrorNote error={error} />
        <button type="submit" class="btn btn--primary" disabled={busy}>
          {busy ? 'Создаём приглашение…' : 'Создать приглашение'}
        </button>
      </form>
    </Dialog>
  );
}
