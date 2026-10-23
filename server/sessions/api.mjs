// Интерфейс light → money (контракт M1 §13). Все функции принимают db — клиента транзакции
// (withContext из server/lib/store.mjs); блокировки и команды контроллеру — в этой транзакции.
//
//   getResourceByCode(db, code)             → { resource, club } | null
//       Код нормализуется (Crockford: регистр, I/L → 1, O → 0). Переводит транзакцию
//       в контекст клуба стола (если контекста не было или он тот же).
//   getResourceStatus(db, resourceId, { userId }?) → { status, busy_until, session_id, pending_mine? }
//       status: free | pending | reserved | busy | service | offline; online — связь с контроллером
//       сейчас при любом статусе (reserved/service/pending главнее offline, R1).
//   availabilityDuring(db, { resourceId, from, to, userId?, source?, refId? })
//       → { unavailable, reasons, intervals: [{ reason, from, to }] } (регресс R1, №128)
//       reasons: offline | session | service | inactive | foreign_hold — по истории (эпизоды без связи
//       bl.device_offline, сессии, удержания) и текущему состоянию. Не учитывает удержание этой
//       брони (source + refId) и игру самого гостя (userId; и сессию брони refId). from = to — «сейчас».
//   holdPending(db, { resourceId, userId, until }) → { ok: true, hold_id, until }
//       ошибка — LightError с code table_busy | table_pending | table_offline | table_service
//       (status 409), not_found (404), bad_request (400). Повтор тем же гостем продлевает удержание.
//       Стол ждёт брони этого же гостя — booking_start_required (409), err.data = { booking_id }:
//       игра по брони начинается через booking, а не обычной оплатой по QR (№128).
//   releasePending(db, { resourceId, userId }) → { ok: true, released }
//   getSessionForExtend(db, { sessionId, userId })
//       → { id, club_id, resource_id, paid_until, status, is_participant, is_payer, unlimited, grace_ms } | null
//
//   startFromBooking(db, { booking, userId, paidMinutes, paymentIds }) → session_id (M3)
//       booking: { id, club_id, resource_id }; время покрыто предоплатой и доплатой (paidMinutes);
//       идемпотентно по booking.id; стол занят — LightError table_busy | table_pending | table_service.
//   setReserved(db, { resourceId, until, userId?, source?, refId? }) → { ok, applied, until, reason? } (M3, №107, №122)
//       source: booking (по умолчанию) | waitlist | staff; refId — бронь или запись очереди (в плане зала hold.booking_id / hold.offer_id)
//   clearReserved(db, { resourceId, source?, refId? }) → { ok, released }
//       source/refId — снять только совпадающее удержание (бронь не снимает предложение очереди).
//   startFromDeposit(db, { resourceId, userId?, staffId, depositKopecks }) → { session_id, paid_until, minutes } (№112)
//       Бронь ближе минимума тарифа — booking_conflict (409); иначе время не дальше брони − 5 мин (№129).
//   Оплата start/extend (outbox payment.confirmed) тоже не заходит в бронь (№129): paid_until
//   обрезается до её начала − 5 мин, лишнее возвращается частичным возвратом (журнал
//   session.booking_cut, уведомление гостю); меньше минуты до брони — полный возврат.
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

export function availabilityDuring(db, args) {
  return service().availabilityDuring(db, args);
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
