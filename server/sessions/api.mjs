// Интерфейс light → money (контракт M1 §13). Все функции принимают db — клиента транзакции
// (withContext из server/lib/store.mjs); блокировки и команды контроллеру — в этой транзакции.
//
//   getResourceByCode(db, code)             → { resource, club } | null
//       Код нормализуется (Crockford: регистр, I/L → 1, O → 0). Переводит транзакцию
//       в контекст клуба стола (если контекста не было или он тот же).
//   getResourceStatus(db, resourceId, { userId }?) → { status, busy_until, session_id, pending_mine? }
//       status: free | pending | reserved | busy | service | offline
//   holdPending(db, { resourceId, userId, until }) → { ok: true, hold_id, until }
//       ошибка — LightError с code table_busy | table_pending | table_offline | table_service
//       (status 409), not_found (404), bad_request (400). Повтор тем же гостем продлевает удержание.
//   releasePending(db, { resourceId, userId }) → { ok: true, released }
//   getSessionForExtend(db, { sessionId, userId })
//       → { id, club_id, resource_id, paid_until, status, is_participant, is_payer, unlimited, grace_ms } | null
//
//   startFromBooking(db, { booking, userId, paidMinutes, paymentIds }) → session_id (M3)
//       booking: { id, club_id, resource_id }; время покрыто предоплатой и доплатой (paidMinutes);
//       идемпотентно по booking.id; стол занят — LightError table_busy | table_pending | table_service.
//   setReserved(db, { resourceId, until, userId?, source?, refId? }) → { ok, applied, until, reason? } (M3, №107, №122)
//       source: booking (по умолчанию) | waitlist | staff; refId — бронь или запись очереди (в плане зала hold.booking_id / hold.offer_id)
//   clearReserved(db, { resourceId }) → { ok, released }
//   startFromDeposit(db, { resourceId, userId?, staffId, depositKopecks }) → { session_id, paid_until, minutes } (№112)
//
// До init() модуля (тесты money, скрипты) работает автономный экземпляр: часы — системные,
// онлайн контроллера — по devices.last_seen_at (не старше 150 с).

import { appendAuditDirect } from './deps.mjs';
import { LightError } from './errors.mjs';
import { light } from './index.mjs';
import { createLightService } from './service.mjs';

export { LightError };

let standalone = null;

function service() {
  try {
    return light().service;
  } catch {
    if (!standalone) {
      const log = { debug() {}, info() {}, warn() {}, error() {} };
      standalone = createLightService({
        log,
        clock: { now: () => new Date() },
        deps: {
          audit: { appendAudit: appendAuditDirect },
          outbox: { enqueue: async () => {}, subscribe() {} },
          alarms: { raise: async () => null },
          notify: { send: async () => {} },
          sse: { publish() {} },
          tariffs: {},
          payments: { refund: async () => { throw new Error('refund без модуля light'); } },
          bookings: { nextBookingStart: async () => null, nextBooking: async () => null },
        },
      });
    }
    return standalone;
  }
}

export function getResourceByCode(db, code) {
  return service().getResourceByCode(db, code);
}

export function getResourceStatus(db, resourceId, opts = {}) {
  return service().resourceStatus(db, resourceId, opts);
}

export function holdPending(db, { resourceId, userId, until }) {
  return service().holdPending(db, { resourceId, userId, until });
}

export function releasePending(db, { resourceId, userId }) {
  return service().releasePending(db, { resourceId, userId });
}

export function getSessionForExtend(db, { sessionId, userId }) {
  return service().getSessionForExtend(db, { sessionId, userId });
}

export function startFromBooking(db, args) {
  return service().startFromBooking(db, args);
}

export function setReserved(db, args) {
  return service().setReserved(db, args);
}

export function clearReserved(db, args) {
  return service().clearReserved(db, args);
}

export function startFromDeposit(db, args) {
  return service().startFromDeposit(db, args);
}
