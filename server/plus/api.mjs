// Интерфейс Бильярдум+ для других модулей (контракт M4 §3). Все функции принимают db — клиента
// транзакции вызывающего (withContext). Чужие профили и рейтинги читаются узкими функциями
// bl.plus_* (0850): RLS вызывающего не мешает.
//
//   ratingOf(db, { userId, discipline }) → { rating, games, level }
//       Общий рейтинг дисциплины (pyramid | pool | snooker); без партий — 1 200, 0, 'amateur'.
//       Для турниров: лимит рейтинга при записи (T24) и посев.
//   applyMatch(db, { matchId }) → { status, reject_reason } | null
//       Засчитать подтверждённую партию bl.matches и пересчитать Эло. Идемпотентно по партии:
//       повтор и параллельный вызов не меняют рейтинг второй раз (bl.plus_settle_match).
//       Турнирные партии (×1,5) создаёт сам plus по outbox tournament.match_finished.
//   playerCard(db, { userId, viewerId }) → { user_id, nick, ratings, achievements?, history? } | null
//       Карточка с приватностью игрока; зритель — пользователь из контекста транзакции
//       (app.user_id), viewerId только для ясности вызова.
//   nicksOf(db, { userIds }) → { [user_id]: nick | null }   (light: участники сессии)
//   levelOf(rating) → 'novice' | 'amateur' | 'experienced' | 'strong' | 'master'
//
// До init() модуля (тесты соседей, скрипты) работает автономный экземпляр с системными часами.

import { appendAudit } from '../lib/audit.mjs';
import { enqueue } from '../outbox.mjs';
import { levelOf } from './elo.mjs';
import { plusOrNull } from './index.mjs';
import { createPlusService } from './service.mjs';

export { levelOf };

let standalone = null;

function service() {
  const s = plusOrNull();
  if (s) return s.service;
  if (!standalone) {
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    standalone = createPlusService({
      log,
      clock: { now: () => new Date() },
      deps: {
        audit: { appendAudit },
        outbox: { enqueue },
        notify: { send: async () => null, sendToClubStaff: async () => ({ ids: [] }) },
        sse: { publish() {} },
        light: {},
        bookings: {},
        tournaments: {},
      },
    });
  }
  return standalone;
}

export function ratingOf(db, { userId, discipline }) {
  return service().ratingOf(db, { userId, discipline });
}

export function applyMatch(db, { matchId }) {
  return service().applyMatch(db, { matchId });
}

export function playerCard(db, { userId, viewerId = null }) {
  return service().playerCard(db, { userId, viewerId });
}

export function nicksOf(db, { userIds }) {
  return service().nicksOf(db, { userIds });
}
