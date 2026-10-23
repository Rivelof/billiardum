import { useCallback, useEffect, useState } from 'preact/hooks';
import { formatDate } from '@billiardum/shared/format';
import { Icon } from '../../components/Icon.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { InviteShare } from '../../components/InviteShare.jsx';
import { api } from '../../lib/api.js';
import { linkHandler } from '../../lib/router.js';
import { BASE } from '../../lib/env.js';
import { ROLE_LABEL } from '../../lib/words.js';
import { InviteDialog } from '../Staff.jsx';

/**
 * Шаг «Персонал» (№158): приглашение по телефону с ролью — тот же диалог, что на экране «Персонал»,
 * затем текст приглашения со ссылкой: «Поделиться» (Web Share) и «Скопировать». SMS-провайдера нет.
 */
export function StaffStep({ ctx, reload }) {
  const { club, timeZone } = ctx;
  const clubId = club.club_id;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState(null);

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
    <div class="stack ob__content">
      <p class="lead">Пригласите тех, кто будет работать в программе: ресепшн, управляющего, бармена, монтажника контроллеров.</p>
      <p class="hint">Сотрудник входит со своего телефона через MAX или Telegram. Приглашение действует 7 дней и срабатывает при первом входе с этим номером. Шаг можно пропустить и вернуться позже.</p>
      <div class="row">
        <button type="button" class="btn btn--primary" onClick={() => setInviting(true)}>
          <Icon name="plus" />
          Пригласить сотрудника
        </button>
        <a class="btn btn--quiet" href={`${BASE}c/${encodeURIComponent(clubId)}/staff`} onClick={linkHandler}>
          Персонал целиком
        </a>
      </div>
      <ErrorNote error={error} />
      {invite ? <InviteShare invite={invite} /> : null}
      {data ? (
        <ul class="people">
          {staff.map((s) => (
            <li class={`person person--${s.role}`} key={s.user_id}>
              <span class="person__main">
                <span class="person__name">{s.name ?? 'Без имени'}</span>
                <span class="person__sub">
                  <span class="mono">{s.phone_masked ?? '—'}</span> · {ROLE_LABEL[s.role] ?? s.role}
                </span>
              </span>
            </li>
          ))}
          {invites.map((i) => (
            <li class="person person--invite" key={i.id}>
              <span class="person__main">
                <span class="person__name mono">{i.phone_masked}</span>
                <span class="person__sub">
                  {ROLE_LABEL[i.role] ?? i.role} · приглашён, ждём первого входа до {formatDate(i.expires_at, timeZone)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <InviteDialog
        open={inviting}
        clubId={clubId}
        onClose={() => setInviting(false)}
        onDone={(inv) => {
          setInviting(false);
          setInvite(inv);
          load();
          reload();
        }}
      />
    </div>
  );
}
