import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatDate } from '@billiardum/shared/format';
import { normalizePhone } from '@billiardum/shared/booking';
import { Shell } from '../components/Shell.jsx';
import { Icon } from '../components/Icon.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { ROLE_LABEL } from '../lib/words.js';
import { BASE } from '../lib/env.js';
import { linkHandler } from '../lib/router.js';
import { Terminals } from './Terminals.jsx';
import { InviteShare } from '../components/InviteShare.jsx';

/** Роли, которые владелец выдаёт сам (server/staff INVITE_ROLES): владельца приглашать нельзя. */
export const INVITE_ROLES = ['manager', 'reception', 'bar', 'installer'];
const ROLE_HINT = {
  manager: 'Смены и отчёты, склад, меню, скидки выше лимита, отмена броней',
  reception: 'Касса, приём оплаты за стол, бар, брони по телефону',
  bar: 'Только экран бара и стоп-лист',
  installer: 'Привязка контроллеров к столам',
};

/**
 * Персонал клуба (владелец, №111): список, приглашение по телефону с ролью на 7 дней, смена роли,
 * отзыв доступа в один шаг с подтверждением — членство, PIN и все входы сотрудника гаснут сразу.
 */
export function Staff({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  if (ctx.id === 'terminals') {
    return (
      <Shell club={club} role={role} user={user} timeZone={timeZone} active="staff" title="Персонал">
        <div class="page staff-page">
          <StaffTabs clubId={clubId} current="terminals" />
          <Terminals clubId={clubId} timeZone={timeZone} />
        </div>
      </Shell>
    );
  }
  return <People ctx={ctx} />;
}

/** Разделы персонала: сотрудники и терминалы ресепшена. */
function StaffTabs({ clubId, current }) {
  const base = `${BASE}c/${encodeURIComponent(clubId)}/staff`;
  return (
    <nav class="subnav" aria-label="Персонал">
      <a class="subnav__item" href={base} onClick={linkHandler} aria-current={current === 'people' ? 'page' : undefined}>
        <Icon name="users" />
        Сотрудники
      </a>
      <a class="subnav__item" href={`${base}/terminals`} onClick={linkHandler} aria-current={current === 'terminals' ? 'page' : undefined}>
        <Icon name="key" />
        Терминалы
      </a>
    </nav>
  );
}

function People({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [notice, setNotice] = useState(null);
  const [shared, setShared] = useState(null); // M5.1: текст приглашения со ссылкой

  const load = useCallback(async () => {
    try {
      setData(await api.staff(clubId));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [clubId]);
  useEffect(() => {
    load();
  }, [load]);

  const staff = (data?.staff ?? []).filter((s) => s.active);
  const invites = data?.invites ?? [];

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="staff" title="Персонал">
      <div class="page staff-page">
        <StaffTabs clubId={clubId} current="people" />
        <div class="bookings__head">
          <p class="hint">Сотрудник входит со своего телефона. Приглашение действует 7 дней и привязывается при первом входе с этим номером.</p>
          <button type="button" class="btn btn--primary" onClick={() => setInviting(true)}>
            <Icon name="plus" />
            Пригласить
          </button>
        </div>
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
            Обновить
          </button>
        </ErrorNote>
        {notice ? (
          <p class="note note--free" role="status">
            <Icon name="check" />
            <span class="note__title">{notice}</span>
          </p>
        ) : null}
        {shared ? <InviteShare invite={shared} /> : null}
        {data === null && !error ? <p class="muted loading">Загружаем персонал…</p> : null}

        {staff.length ? (
          <section aria-labelledby="st-list">
            <h2 class="tables__title" id="st-list">
              Сотрудники <span class="count">{staff.length}</span>
            </h2>
            <ul class="people">
              {staff.map((s) => {
                const self = s.user_id === user?.id;
                return (
                  <li class={`person person--${s.role}`} key={s.user_id}>
                    <span class="person__avatar display" aria-hidden="true">
                      {initials(s.name)}
                    </span>
                    <span class="person__main">
                      <span class="person__name">
                        {s.name ?? 'Без имени'}
                        {self ? <span class="person__tag">это вы</span> : null}
                      </span>
                      <span class="person__sub">
                        <span class="mono">{s.phone_masked ?? '—'}</span> · {s.network_id ? 'Управляющий сети' : (ROLE_LABEL[s.role] ?? s.role)}
                        {s.pin_set ? ' · PIN задан' : ' · без PIN'}
                      </span>
                      {/* M5.5 (№192): доступ выдан сетью — роль и отзыв меняет владелец сети в разделе «Сеть» (иначе 409 network_locked) */}
                      {s.network_id ? <span class="person__sub">Доступ выдан сетью клубов: роль и отзыв — в разделе «Сеть».</span> : null}
                    </span>
                    {s.role !== 'owner' && !self && !s.network_id ? (
                      <span class="person__tools">
                        <button type="button" class="btn btn--secondary btn--sm" onClick={() => setEditing(s)}>
                          Сменить роль
                        </button>
                        <button type="button" class="btn btn--quiet btn--sm person__revoke" onClick={() => setRevoking(s)}>
                          Отозвать доступ
                        </button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {invites.length ? (
          <section aria-labelledby="st-inv">
            <h2 class="tables__title" id="st-inv">
              Приглашения <span class="count">{invites.length}</span>
            </h2>
            <ul class="people">
              {invites.map((i) => (
                <li class="person person--invite" key={i.id}>
                  <span class="person__main">
                    <span class="person__name mono">{i.phone_masked}</span>
                    <span class="person__sub">
                      {ROLE_LABEL[i.role] ?? i.role} · ждём первого входа до {formatDate(i.expires_at, timeZone)}
                    </span>
                  </span>
                  <span class="person__tools">
                    <button
                      type="button"
                      class="btn btn--quiet btn--sm person__revoke"
                      onClick={async () => {
                        try {
                          await api.revokeInvite(clubId, i.id);
                          setNotice(`Приглашение на ${i.phone_masked} отозвано.`);
                          load();
                        } catch (err) {
                          setError(err);
                        }
                      }}
                    >
                      Отозвать приглашение
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <InviteDialog
        open={inviting}
        clubId={clubId}
        onClose={() => setInviting(false)}
        onDone={(inv) => {
          setInviting(false);
          setNotice(`Приглашение создано: ${inv.phone_masked}, ${(ROLE_LABEL[inv.role] ?? inv.role).toLowerCase()}. Действует до ${formatDate(inv.expires_at, timeZone)}.`);
          setShared(inv);
          load();
        }}
      />
      <RoleDialog
        person={editing}
        clubId={clubId}
        onClose={() => setEditing(null)}
        onDone={(p, r) => {
          setEditing(null);
          setNotice(`${p.name ?? p.phone_masked}: теперь ${(ROLE_LABEL[r] ?? r).toLowerCase()}.`);
          load();
        }}
      />
      <RevokeDialog
        person={revoking}
        clubId={clubId}
        onClose={() => setRevoking(null)}
        onDone={(p, res) => {
          setRevoking(null);
          setNotice(`Доступ ${p.name ?? p.phone_masked} отозван${res?.tokens_revoked ? `: закрыто входов — ${res.tokens_revoked}` : ''}. PIN стёрт.`);
          load();
        }}
      />
    </Shell>
  );
}

function RoleChoice({ value, onChange, name }) {
  return (
    <fieldset>
      <legend class="field__label">Роль</legend>
      <div class="rolechoice">
        {INVITE_ROLES.map((r) => (
          <label class="rolechoice__item" key={r}>
            <input type="radio" name={name} checked={value === r} onChange={() => onChange(r)} />
            <span class="rolechoice__box">
              <span class="rolechoice__title">{ROLE_LABEL[r]}</span>
              <span class="rolechoice__sub">{ROLE_HINT[r]}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function InviteDialog({ open, clubId, onClose, onDone }) {
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('reception');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (open) {
      setPhone('');
      setRole('reception');
      setTried(false);
      setError(null);
    }
  }, [open]);
  const e164 = normalizePhone(phone);
  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (!e164) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.inviteStaff(clubId, e164, role));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Пригласить сотрудника" labelledBy="inv-title">
      <form class="form" onSubmit={submit} noValidate>
        <div class="field">
          <label class="field__label" for="inv-phone">
            Телефон сотрудника
          </label>
          <input id="inv-phone" class="field__input mono" type="tel" inputMode="tel" autoComplete="off" placeholder="+7 900 000-00-00" value={phone} aria-invalid={tried && !e164 ? 'true' : undefined} onInput={(ev) => setPhone(ev.currentTarget.value)} />
          {tried && !e164 ? <p class="field__error">Номер из 10 цифр после +7.</p> : <p class="field__hint">Сотрудник войдёт с этим номером через бота MAX или Telegram.</p>}
        </div>
        <RoleChoice value={role} onChange={setRole} name="inv-role" />
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Приглашаем…' : `Пригласить: ${ROLE_LABEL[role].toLowerCase()}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function RoleDialog({ person, clubId, onClose, onDone }) {
  const [role, setRole] = useState('reception');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (person) {
      setRole(INVITE_ROLES.includes(person.role) ? person.role : 'reception');
      setError(null);
    }
  }, [person?.user_id]);
  if (!person) return <Dialog open={false} onClose={onClose} title="" />;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setStaffRole(clubId, person.user_id, role);
      onDone(person, role);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Роль: ${person.name ?? person.phone_masked}`} labelledBy="role-title">
      <form class="form" onSubmit={submit} noValidate>
        <RoleChoice value={role} onChange={setRole} name="edit-role" />
        <ErrorNote error={error} />
        <div class="dialog__actions">
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy || role === person.role}>
            {busy ? 'Сохраняем…' : role === person.role ? 'Роль не изменилась' : `Сделать: ${ROLE_LABEL[role].toLowerCase()}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function RevokeDialog({ person, clubId, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setError(null), [person?.user_id]);
  if (!person) return <Dialog open={false} onClose={onClose} title="" />;
  return (
    <Dialog open onClose={onClose} title="Отозвать доступ?" labelledBy="rv-title">
      <div class="form">
        <p class="lead">
          <b>{person.name ?? 'Сотрудник'}</b>, <span class="mono">{person.phone_masked}</span>, {(ROLE_LABEL[person.role] ?? person.role).toLowerCase()}.
        </p>
        <div class="note note--error">
          <Icon name="alert" />
          <p class="note__title">Сразу и на всех устройствах</p>
          <p class="note__body">Сотрудник выйдет из программы, его PIN на терминалах перестанет работать. Действие попадёт в журнал. Вернуть доступ — новым приглашением.</p>
        </div>
        <ErrorNote error={error} />
        <div class="dialog__actions dialog__actions--row">
          <button
            type="button"
            class="btn btn--danger btn--lg"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                onDone(person, await api.revokeStaff(clubId, person.user_id));
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Отзываем…' : 'Отозвать доступ'}
          </button>
          <button type="button" class="btn btn--quiet btn--lg" onClick={onClose}>
            Не отзывать
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Монограмма сотрудника: первые буквы имени и фамилии («Анна К.» → «АК»). */
function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? '·') + (parts[1]?.[0] ?? '');
}
