import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../../components/Icon.jsx';
import { ErrorNote } from '../../components/ErrorNote.jsx';
import { QrCode } from '../../components/QrCode.jsx';
import { api } from '../../lib/api.js';
import { guestTableUrl } from '../../lib/onboarding.js';

/**
 * Шаг «Тестовый режим» (№153): что работает по-настоящему, что тестовое, и проверка глазами гостя —
 * QR стола на экране: отсканируйте телефоном, оплатите тестовой картой, свет включится.
 */
export function TestStep({ ctx, live }) {
  const clubId = ctx.club.club_id;
  const [hall, setHall] = useState(null);
  const [error, setError] = useState(null);
  const [tableId, setTableId] = useState('');

  useEffect(() => {
    api
      .hall(clubId)
      .then((h) => {
        const list = (h ?? []).filter((t) => t.resource.code).sort((a, b) => a.resource.number - b.resource.number);
        setHall(list);
        setTableId(list.find((t) => t.device?.online)?.resource.id ?? list[0]?.resource.id ?? '');
      })
      .catch(setError);
  }, [clubId]);

  const table = hall?.find((t) => t.resource.id === tableId) ?? null;
  const url = guestTableUrl(globalThis.location?.origin, table?.resource.code);

  return (
    <div class="stack ob__content">
      {live ? (
        <p class="note note--free">
          <Icon name="check" />
          <span class="note__title">Клуб уже в боевом режиме: оплаты настоящие. Тестовые игры и продажи остались в журнале с отметкой «тест».</span>
        </p>
      ) : (
        <p class="lead">Пока клуб в тестовом режиме, всё работает как в жизни, кроме денег. Пройдите путь гостя сами.</p>
      )}
      <div class="tm">
        <section class="tm__col tm__col--real" aria-labelledby="tm-real">
          <h3 class="section-title" id="tm-real">
            <Icon name="lamp" />
            По-настоящему
          </h3>
          <ul class="tm__list">
            <li>Свет над столом включается и гаснет командой сервера, каждая команда — в журнале.</li>
            <li>Таймер игры, предупреждение о конце времени, продление и льгота.</li>
            <li>Приложение гостя, заявки на ресепшен, заказы бара.</li>
          </ul>
        </section>
        <section class="tm__col" aria-labelledby="tm-test">
          <h3 class="section-title" id="tm-test">
            <Icon name="flask" />
            Тестовое
          </h3>
          <ul class="tm__list">
            <li>Онлайн-оплаты идут в тестовый магазин ЮKassa: деньги не списываются.</li>
            <li>На кассе ресепшена продажи тестовые: ККТ печатает документ «ТЕСТ» без фискального чека.</li>
            <li>Тестовые игры и продажи не попадают в отчёты, утреннюю сводку, рейтинг и каталог.</li>
            <li>Гость видит плашку «Тестовый режим клуба — деньги не списываются».</li>
          </ul>
        </section>
      </div>

      <section class="panel" aria-labelledby="tm-guest">
        <h3 class="section-title" id="tm-guest">
          Проверить как гость
        </h3>
        <ErrorNote error={error} />
        {hall && !hall.length ? <p class="hint">Добавьте стол на шаге «План зала» — здесь появится его QR-код.</p> : null}
        {hall?.length ? (
          <>
            <ol class="howto">
              <li>
                <span>Отсканируйте QR телефоном — откроется стол, как у гостя.</span>
              </li>
              <li>
                <span>Выберите время и оплатите тестовой картой из документации ЮKassa.</span>
              </li>
              <li>
                <span>Посмотрите на стол: свет включится, а когда время выйдет — погаснет.</span>
              </li>
            </ol>
            <div class="field">
              <label class="field__label" for="tm-table">
                Стол
              </label>
              <select id="tm-table" class="field__input" value={tableId} onChange={(e) => setTableId(e.currentTarget.value)}>
                {hall.map((t) => (
                  <option key={t.resource.id} value={t.resource.id}>
                    Стол {t.resource.number}
                    {t.device?.online ? '' : ' — контроллер не на связи'}
                  </option>
                ))}
              </select>
            </div>
            {table && !table.device?.online ? <p class="small field__error">Контроллер этого стола не на связи: оплату примет, а свет не включится. Проверьте шаг «Контроллеры».</p> : null}
            {url ? (
              <div class="tm__qr">
                <QrCode data={url} label={`QR-код стола ${table.resource.number}`} />
                <a class="btn btn--secondary" href={url} target="_blank" rel="noopener">
                  <Icon name="external" />
                  Открыть стол {table.resource.number} как гость
                </a>
                <p class="small muted mono tm__code">Код стола: {table.resource.code}</p>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
