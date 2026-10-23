import { useCallback, useEffect, useState } from 'preact/hooks';
import { plural } from '@billiardum/shared/format';
import { Shell } from '../../components/Shell.jsx';
import { Icon } from '../../components/Icon.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { api } from '../../lib/api.js';
import { clubMode, setClubMode } from '../../lib/auth.js';
import { navigate, linkHandler } from '../../lib/router.js';
import { BASE } from '../../lib/env.js';
import { STEPS, nextStepOf, prevStepOf, stepById, stepIndex, stepsView } from '../../lib/onboarding.js';
import { ClubStep } from './ClubStep.jsx';
import { HallStep } from './HallStep.jsx';
import { TariffsStep } from './TariffsStep.jsx';
import { MenuStep } from './MenuStep.jsx';
import { StaffStep } from './StaffStep.jsx';
import { PaymentsStep } from './PaymentsStep.jsx';
import { DevicesStep } from './DevicesStep.jsx';
import { StickersStep } from './StickersStep.jsx';
import { TestStep } from './TestStep.jsx';
import { GoLiveStep } from './GoLiveStep.jsx';
import '../../styles/m5.css';

const CONTENT = {
  club: ClubStep,
  hall: HallStep,
  tariffs: TariffsStep,
  menu: MenuStep,
  staff: StaffStep,
  payments: PaymentsStep,
  devices: DevicesStep,
  stickers: StickersStep,
  test: TestStep,
  go_live: GoLiveStep,
};

/**
 * Мастер подключения клуба (M5.1, PRODUCT §16): 10 шагов с прогрессом, к любому шагу можно вернуться.
 * Шаг — в адресе: /club/c/{club}/onboarding/{step}. Отметки «готово» ставит сервер (GET …/onboarding).
 */
export function Onboarding({ ctx }) {
  const { club, role, user, timeZone } = ctx;
  const clubId = club.club_id;
  const [ob, setOb] = useState(null);
  const [error, setError] = useState(null);
  const [listOpen, setListOpen] = useState(false);
  const step = stepById(ctx.id)?.id ?? null;
  const base = `${BASE}c/${encodeURIComponent(clubId)}/onboarding`;

  const reload = useCallback(async () => {
    try {
      const res = await api.onboarding(clubId);
      setOb(res);
      setError(null);
      if (res?.mode) setClubMode(clubId, res.mode);
      return res;
    } catch (err) {
      setError(err);
      return null;
    }
  }, [clubId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const view = stepsView(ob);
  // Без шага в адресе — первый несделанный
  useEffect(() => {
    if (!step && ob) navigate(`${base}/${view.firstOpen}`, { replace: true });
  }, [step, ob]);
  useEffect(() => {
    setListOpen(false);
    document.getElementById('ob-step-title')?.focus();
  }, [step]);

  const current = view.steps.find((s) => s.id === step) ?? null;
  const prev = step ? prevStepOf(step) : null;
  const next = step ? nextStepOf(step) : null;
  const live = (ob?.mode ?? clubMode(club)) === 'live';
  const Content = step ? CONTENT[step] : null;

  return (
    <Shell club={club} role={role} user={user} timeZone={timeZone} active="onboarding" title="Подключение">
      <div class="page ob">
        <div class="ob__progress">
          <p class="ob__count">
            Готово <b>{view.done}</b> из {view.total} {plural(view.total, ['шага', 'шагов', 'шагов'])}
            {live ? ' · клуб в боевом режиме' : ' · тестовый режим'}
          </p>
          <div class="meter meter--wide" role="progressbar" aria-label="Подключение клуба" aria-valuemin={0} aria-valuemax={view.total} aria-valuenow={view.done} aria-valuetext={`Готово ${view.done} из ${view.total}`}>
            <span class="meter__fill" style={{ width: `${Math.round((view.done / view.total) * 100)}%` }} />
          </div>
        </div>
        <ErrorNote error={error}>
          <button type="button" class="btn btn--secondary btn--sm" onClick={reload}>
            Обновить
          </button>
        </ErrorNote>

        <div class="ob__grid">
          <nav class="ob__nav" aria-label="Шаги подключения">
            <button type="button" class="ob__toggle btn btn--secondary btn--block" aria-expanded={listOpen ? 'true' : 'false'} aria-controls="ob-steps" onClick={() => setListOpen((v) => !v)}>
              <span>
                Шаг {stepIndex(step) + 1} из {STEPS.length}: {current?.title ?? '…'}
              </span>
              <span class="ob__toggle-hint">{listOpen ? 'Скрыть шаги' : 'Все шаги'}</span>
            </button>
            <ol class={`ob__list${listOpen ? '' : ' ob__list--closed'}`} id="ob-steps">
              {view.steps.map((s, i) => (
                <li key={s.id}>
                  <a class={`ob__step${s.done ? ' ob__step--done' : ''}`} href={`${base}/${s.id}`} onClick={linkHandler} aria-current={s.id === step ? 'step' : undefined}>
                    <span class="ob__num" aria-hidden="true">
                      {s.done ? <Icon name="check" /> : i + 1}
                    </span>
                    <span class="ob__stepmain">
                      <span class="ob__steptitle">{s.title}</span>
                      <span class="ob__stepsub">{s.done ? 'Готово' : s.about}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <section class="ob__body" aria-labelledby="ob-step-title">
            {current ? (
              <>
                <p class="ob__kicker">
                  Шаг {stepIndex(step) + 1} из {STEPS.length}
                  {current.done ? (
                    <span class="badge badge--free ob__done">
                      <Icon name="check" />
                      Готово
                    </span>
                  ) : null}
                </p>
                <h2 class="ob__title display" id="ob-step-title" tabIndex={-1}>
                  {current.title}
                </h2>
                {ob ? <Content key={step} ctx={ctx} ob={ob} reload={reload} live={live} goTo={(id) => navigate(`${base}/${id}`)} /> : <p class="muted loading">Загружаем…</p>}
                <div class="ob__foot">
                  {prev ? (
                    <a class="btn btn--quiet" href={`${base}/${prev.id}`} onClick={linkHandler}>
                      <Icon name="back" />
                      Назад: {prev.title}
                    </a>
                  ) : (
                    <span />
                  )}
                  {next ? (
                    <a class="btn btn--primary" href={`${base}/${next.id}`} onClick={linkHandler}>
                      Дальше: {next.title}
                      <Icon name="forward" />
                    </a>
                  ) : null}
                </div>
              </>
            ) : (
              <p class="muted loading">Загружаем мастер…</p>
            )}
          </section>
        </div>
      </div>
    </Shell>
  );
}
