import { Icon } from '../../components/Icon.jsx';
import { linkHandler } from '../../lib/router.js';
import { BASE } from '../../lib/env.js';
import { RU_ZONES } from '../../lib/clubStart.js';

/** Шаг 1 «Клуб»: клуб уже создан; адрес, часы и описание для гостей — в карточке клуба. */
export function ClubStep({ ctx, live }) {
  const { club, timeZone } = ctx;
  const zone = RU_ZONES.find(([id]) => id === timeZone)?.[1] ?? timeZone;
  return (
    <div class="stack ob__content">
      <p class="lead">Клуб создан. Проверьте название и часовой пояс: по поясу считаются тарифы и время игры.</p>
      <dl class="facts">
        <div>
          <dt>Название</dt>
          <dd>{club.name ?? 'Без названия'}</dd>
        </div>
        <div>
          <dt>Часовой пояс</dt>
          <dd>{zone}</dd>
        </div>
        <div>
          <dt>Режим</dt>
          <dd>{live ? 'Боевой: оплаты настоящие' : 'Тестовый: свет настоящий, оплаты тестовые'}</dd>
        </div>
      </dl>
      <div class="panel">
        <h3 class="section-title">Карточка для гостей</h3>
        <p class="hint">Адрес, телефон, часы работы и описание — в карточке клуба на сайте Бильярдума. Её можно заполнить сейчас или позже.</p>
        <a class="btn btn--secondary" href={`${BASE}c/${encodeURIComponent(club.club_id)}/listing`} onClick={linkHandler}>
          <Icon name="star" />
          Открыть карточку клуба
        </a>
      </div>
    </div>
  );
}
