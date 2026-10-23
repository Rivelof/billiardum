import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../components/Icon.jsx';
import { ErrorNote } from '../components/ErrorNote.jsx';
import { api } from '../lib/api.js';
import { auth, loadMe, logout } from '../lib/auth.js';
import { useStore } from '../lib/store.js';
import { navigate, linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import '../styles/m5.css';
import { RU_ZONES, claimableListings, cityList, clubStartBody, clubStartErrors, tzForCity } from '../lib/clubStart.js';

/**
 * «Подключить клуб» (M5.1, №152): вошедший по телефону создаёт клуб сам. Клуб стартует в тестовом режиме,
 * вошедший — его владелец. Если у него одобрена заявка «Подтвердить клуб», клуб можно сразу связать с карточкой.
 */
export function ClubStart() {
  const { user, clubs } = useStore(auth);
  const [cities, setCities] = useState([]);
  const [listings, setListings] = useState([]);
  const [form, setForm] = useState({ name: '', city: '', timezone: '', listing_id: '' });
  const [tzTouched, setTzTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.cities().then((r) => setCities(cityList(r))).catch(() => setCities([]));
    api.claimableListings().then((r) => setListings(claimableListings(r))).catch(() => setListings([]));
  }, []);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const onCity = (city) => {
    const tz = tzForCity(city, cities);
    set({ city, ...(tz && !tzTouched ? { timezone: tz } : {}) });
  };
  const pickListing = (l) => {
    if (!l) return set({ listing_id: '' });
    const tz = l.timezone ?? tzForCity(l.city, cities);
    set({ listing_id: l.id, name: form.name || l.name, city: form.city || l.city || '', ...(tz && !tzTouched ? { timezone: tz } : {}) });
  };

  const errors = clubStartErrors(form);
  const show = (k) => tried && errors[k];

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errors).length) {
      document.getElementById(`cs-${Object.keys(errors)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.createClub(clubStartBody(form, cities, listings.find((l) => l.id === form.listing_id)));
      await loadMe();
      navigate(`${BASE}c/${encodeURIComponent(res.club_id)}/onboarding`, { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <main class="signin cstart" data-theme="dark">
      <div class="signin__card signin__card--wide">
        <p class="signin__brand display">Бильярдум</p>
        <h1 class="signin__title">Подключить клуб</h1>
        <p class="lead">Создайте клуб — дальше мастер проведёт по шагам: зал, тарифы, меню, персонал, ЮKassa, контроллеры и наклейки.</p>
        <ul class="ticks cstart__facts">
          <li>
            <Icon name="flask" />
            <span>Клуб начнёт в тестовом режиме: свет над столом работает по-настоящему, оплаты тестовые, деньги не списываются.</span>
          </li>
          <li>
            <Icon name="check" />
            <span>В боевой режим вы переведёте клуб сами, когда пройдёте чек-лист запуска.</span>
          </li>
        </ul>

        <form class="form" onSubmit={submit} noValidate>
          {listings.length ? (
            <fieldset class="cstart__listing">
              <legend class="field__label">Ваша карточка в каталоге</legend>
              <p class="field__hint">Заявку «Подтвердить клуб» одобрили. Свяжите клуб с карточкой — гости увидят онлайн-оплату там, где уже находят вас.</p>
              <div class="rolechoice">
                {listings.map((l) => (
                  <label class="rolechoice__item" key={l.id}>
                    <input type="radio" name="cs-listing" checked={form.listing_id === l.id} onChange={() => pickListing(l)} />
                    <span class="rolechoice__box">
                      <span class="rolechoice__title">Связать с карточкой: {l.name}</span>
                      <span class="rolechoice__sub">{[l.city, l.address].filter(Boolean).join(', ') || 'Город не указан'}</span>
                    </span>
                  </label>
                ))}
                <label class="rolechoice__item">
                  <input type="radio" name="cs-listing" checked={!form.listing_id} onChange={() => pickListing(null)} />
                  <span class="rolechoice__box">
                    <span class="rolechoice__title">Не связывать</span>
                    <span class="rolechoice__sub">Карточка появится при переходе в боевой режим</span>
                  </span>
                </label>
              </div>
            </fieldset>
          ) : null}

          <div class="field">
            <label class="field__label" for="cs-name">
              Название клуба
            </label>
            <input
              id="cs-name"
              class="field__input"
              autoComplete="organization"
              maxLength={100}
              value={form.name}
              aria-invalid={show('name') ? 'true' : undefined}
              aria-describedby="cs-name-hint"
              onInput={(e) => set({ name: e.currentTarget.value })}
            />
            <p class={show('name') ? 'field__error' : 'field__hint'} id="cs-name-hint">
              {show('name') || 'Как клуб называют гости: так он будет подписан в приложении и в чеках.'}
            </p>
          </div>

          <div class="field">
            <label class="field__label" for="cs-city">
              Город
            </label>
            <input
              id="cs-city"
              class="field__input"
              list="cs-cities"
              autoComplete="address-level2"
              maxLength={100}
              value={form.city}
              aria-invalid={show('city') ? 'true' : undefined}
              aria-describedby="cs-city-hint"
              onInput={(e) => onCity(e.currentTarget.value)}
            />
            <datalist id="cs-cities">
              {cities.map((c) => (
                <option key={c.slug ?? c.name} value={c.name} />
              ))}
            </datalist>
            <p class={show('city') ? 'field__error' : 'field__hint'} id="cs-city-hint">
              {show('city') || 'Начните вводить — подскажем город из каталога.'}
            </p>
          </div>

          <div class="field">
            <label class="field__label" for="cs-timezone">
              Часовой пояс
            </label>
            <select
              id="cs-timezone"
              class="field__input"
              value={form.timezone}
              aria-invalid={show('timezone') ? 'true' : undefined}
              aria-describedby="cs-tz-hint"
              onChange={(e) => {
                setTzTouched(true);
                set({ timezone: e.currentTarget.value });
              }}
            >
              <option value="">Выберите пояс</option>
              {RU_ZONES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <p class={show('timezone') ? 'field__error' : 'field__hint'} id="cs-tz-hint">
              {show('timezone') || 'Подставляется по городу. По нему считаются тарифы «день и вечер» и время игры.'}
            </p>
          </div>

          <ErrorNote error={error} />
          <button type="submit" class="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy ? 'Создаём клуб…' : 'Создать клуб в тестовом режиме'}
          </button>
        </form>

        <div class="cstart__staff">
          <p class="hint">
            Вы сотрудник клуба? Клуб создавать не нужно: попросите владельца пригласить ваш номер{user?.phone_masked ? <> <span class="mono">{user.phone_masked}</span></> : null}, затем войдите снова.
          </p>
          <div class="row">
            {clubs.length ? (
              <a class="btn btn--quiet" href={BASE} onClick={linkHandler}>
                <Icon name="back" />
                Вернуться к клубам
              </a>
            ) : null}
            <button
              type="button"
              class="btn btn--quiet"
              onClick={async () => {
                await logout().catch(() => {});
                navigate(`${BASE}signin`, { replace: true });
              }}
            >
              <Icon name="logout" />
              Выйти
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
