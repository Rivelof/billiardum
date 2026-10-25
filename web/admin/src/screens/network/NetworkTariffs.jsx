import { useCallback, useEffect, useState } from 'preact/hooks';
import { Icon } from '../../components/Icon.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { TariffWizard, TypedWeek } from '../../components/TariffEditor.jsx';
import { api } from '../../lib/api.js';
import { COURT_KIND, networkKinds, rulesSlot, TYPE_WORD } from '../../lib/tariffs.js';
import { clubTariffState, clubsWord, isLive, liveTouched, problemText, tariffTouched, withReason } from '../../lib/networks.js';
import { ClubModeBadge, ConfirmDialog, ModeBlock } from './parts.jsx';

/**
 * Шаблон тарифов сети (№191): тот же редактор, что в мастере тарифов клуба (components/TariffEditor.jsx).
 * Правила — по местному времени: в каждом клубе шаблон действует по его поясу и рабочим суткам. Сервер проверяет неделю
 * каждого клуба: 400 tariff_gap | tariff_overlap { club_id, … } — ничего не записывается. Затронуты боевые клубы — причина.
 * M5.8: корты хотя бы в одном клубе сети — блок корта обязателен (400 tariff_gap { kind: 'padel_court', club_id }),
 * кортов нет — цены кортов можно задать впрок.
 */
export function NetworkTariffs({ n, rights, onNetwork }) {
  const [t, setT] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState(null);
  const load = useCallback(async () => {
    try {
      setT(await api.networkTariffs(n.id));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [n.id]);
  useEffect(() => {
    load();
  }, [load, n.tariffs_mode]);

  if (error && !t) {
    return (
      <ErrorNote error={error}>
        <button type="button" class="btn btn--secondary btn--sm" onClick={load}>
          Повторить
        </button>
      </ErrorNote>
    );
  }
  if (!t) return <p class="muted loading">Загружаем шаблон тарифов…</p>;
  const clubs = Array.isArray(t.clubs) ? t.clubs : [];
  // Виды ресурсов в работе — по всем клубам сети (clubs[].kinds ответа): шаблон с разными ценами по видам должен покрыть каждый
  const { types, courts } = networkKinds(clubs);
  const dayStarts = [...new Set(clubs.map((c) => c.day_start_local ?? '06:00'))];
  const dayStart = dayStarts[0] ?? '06:00';
  const touched = tariffTouched(clubs, t.mode);
  const live = liveTouched(touched);
  const skipped = clubs.filter((c) => !touched.includes(c));
  const nameOf = (err) => clubs.find((c) => c.club_id === err?.data?.club_id)?.name ?? null;

  if (editing) {
    return (
      <div class="net__stack">
        <p class="lead">
          Шаблон запишется в тарифы {clubsWord(touched.length)} сети. Время — местное: «с 18:00» значит 18:00 по часам каждого клуба.
          {dayStarts.length > 1 ? ` Сутки клубов начинаются в разное время (${dayStarts.join(', ')}) — неделя ниже показана от ${dayStart}.` : ''}
        </p>
        <TariffWizard
          types={types}
          courts={courts}
          offerCourts
          slot={rulesSlot(t.rules)}
          dayStart={dayStart}
          live={live.length > 0}
          canCancel
          onCancel={() => setEditing(false)}
          saveLabel="Сохранить шаблон сети"
          reasonLabel="Причина изменения шаблона"
          reasonHint="Уйдёт в журнал каждого боевого клуба и владельцу в уведомлении."
          reasonMissing="В сети есть клубы в боевом режиме: без причины шаблон не сохранится."
          errorClubName={nameOf}
          previewNote={<TouchNote touched={touched} live={live} skipped={skipped} />}
          onSave={async (rules, reason) => {
            const res = await api.saveNetworkTariffs(n.id, withReason({ rules }, reason));
            setT(res);
            setEditing(false);
            setNotice(`Шаблон тарифов сохранён${Number.isInteger(res?.version) ? ` (версия ${res.version})` : ''} и записан в ${clubsWord(touched.length)}.`);
            onNetwork(null);
          }}
        />
      </div>
    );
  }

  return (
    <div class="net__stack">
      {notice ? (
        <p class="note note--free" role="status">
          <Icon name="check" />
          <span class="note__title">{notice}</span>
        </p>
      ) : null}
      <ModeBlock n={n} scope="tariffs" rights={rights} onNetwork={onNetwork} />
      <section class="panel" aria-labelledby="nt-week">
        <div class="net__row">
          <h3 class="section-title" id="nt-week">
            {t.template ? `Шаблон тарифов · версия ${t.version}` : 'Шаблона тарифов ещё нет'}
          </h3>
          {rights.owner ? (
            <div class="row">
              <button type="button" class="btn btn--primary btn--sm" onClick={() => setEditing(true)} disabled={!rights.edit || !clubs.length} aria-describedby={rights.pin ? 'net-pin' : undefined}>
                <Icon name={t.template ? 'edit' : 'plus'} />
                {t.template ? 'Изменить шаблон' : 'Создать шаблон тарифов'}
              </button>
              {t.template ? (
                <button type="button" class="btn btn--quiet btn--sm" onClick={() => setRemoving(true)} disabled={!rights.edit} aria-describedby={rights.pin ? 'net-pin' : undefined}>
                  Снять шаблон
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {t.template && Array.isArray(t.rules) && t.rules.length ? (
          <>
            <p class="hint">Цены по дням и часам — местное время каждого клуба. Неделя показана от {dayStart}: ночь после полуночи считается по предыдущему дню.</p>
            <TypedWeek rules={t.rules} types={types} courts={courts} dayStart={dayStart} />
          </>
        ) : (
          <p class="hint">
            {rights.owner
              ? 'Создайте шаблон — он запишется в тарифы всех клубов сети. Каждый клуб будет считать цены по своему местному времени и рабочим суткам.'
              : 'Владелец сети ещё не задал шаблон тарифов: у каждого клуба свои тарифы.'}
          </p>
        )}
      </section>
      <section class="panel" aria-labelledby="nt-clubs">
        <h3 class="section-title" id="nt-clubs">
          Тарифы в клубах
        </h3>
        {clubs.length ? (
          <ul class="nclubs">
            {clubs.map((c) => {
              const st = clubTariffState(c, t.mode);
              const pr = problemText(c.problem);
              return (
                <li key={c.club_id} class={`nclub${c.problem ? ' nclub--problem' : ''}`}>
                  <div class="nclub__main">
                    <p class="nclub__name">{c.name ?? 'Клуб'}</p>
                    <p class="nclub__sub">
                      {[c.timezone ? `пояс ${c.timezone}` : null, `сутки с ${c.day_start_local ?? '06:00'}`, t.template && Number.isInteger(c.applied_version) ? `версия шаблона ${c.applied_version}` : null].filter(Boolean).join(' · ')}
                    </p>
                    <p class="nclub__tags">
                      <ClubModeBadge mode={c.mode} />
                      {t.template ? (
                        <span class={`nbadge nbadge--${st.tone}`}>
                          <Icon name={st.icon} />
                          {st.text}
                        </span>
                      ) : null}
                    </p>
                    {pr ? (
                      <p class="nclub__problem">
                        <Icon name="alert" />
                        <span>
                          {pr} {c.problem?.kind === COURT_KIND ? 'В клубе есть корты, а в шаблоне нет цены кортов на эти часы.' : 'Шаблон не покрывает неделю этого клуба — например, после добавления стола нового типа.'} {rights.owner ? 'Задайте цену на эти часы в шаблоне.' : 'Сообщите владельцу сети.'}
                        </span>
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p class="hint">В сети пока нет клубов.</p>
        )}
        {t.template && t.mode !== 'hard' && clubs.some((c) => c.override) ? (
          <p class="small muted">«Изменено в клубе» — клуб сохранил свои тарифы и новые версии шаблона не получает. Вернуть его к шаблону может управляющий клуба (в тарифах клуба) или вы — сделав шаблон жёстким.</p>
        ) : null}
      </section>
      <ConfirmDialog
        open={removing}
        title="Снять шаблон тарифов?"
        action="Снять шаблон"
        labelId="nt-rm"
        onClose={() => setRemoving(false)}
        run={async () => {
          setT(await api.deleteNetworkTariffs(n.id));
          setRemoving(false);
          setNotice('Шаблон тарифов снят. Тарифы клубов остались как были — теперь каждый клуб меняет их сам.');
          onNetwork(null);
        }}
      >
        <p>Тарифы клубов останутся как есть, но дальше каждый клуб меняет их сам. Создать шаблон заново можно в любой момент.</p>
      </ConfirmDialog>
    </div>
  );
}

/** Кого коснётся сохранение: боевые клубы — ручное действие с причиной и уведомлением, переопределившие — не меняются. */
function TouchNote({ touched, live, skipped }) {
  return (
    <div class={`note${live.length ? ' note--lamp' : ''}`}>
      <Icon name={live.length ? 'alert' : 'info'} />
      <p class="note__title">{live.length ? 'В сети есть клубы в боевом режиме' : `Шаблон запишется в ${clubsWord(touched.length)}`}</p>
      <div class="note__body">
        {live.length ? (
          <p>
            {live.map((c) => c.name ?? 'Клуб').join(', ')}: изменение тарифа — ручное действие. Нужна причина; владельцу клуба сразу уйдёт уведомление, запись появится в журнале каждого клуба.
          </p>
        ) : null}
        {touched.filter((c) => !isLive(c)).length ? <p>В тестовом режиме: {touched.filter((c) => !isLive(c)).map((c) => c.name ?? 'Клуб').join(', ')} — только запись в журнал.</p> : null}
        {skipped.length ? <p>Не изменятся — свои тарифы клуба: {skipped.map((c) => c.name ?? 'Клуб').join(', ')}.</p> : null}
        {touched.some((c) => c.problem?.kind && TYPE_WORD[c.problem.kind]) ? <p>Проверьте цены на все типы столов в клубах сети.</p> : null}
        {touched.some((c) => c.problem?.kind === COURT_KIND) ? <p>В клубах с кортами шаблон без цен кортов не сохранится: задайте цену слота.</p> : null}
      </div>
    </div>
  );
}
