// Интерфейс брони для других модулей (контракт M3 §3). Все функции принимают db — клиента
// транзакции вызывающего с контекстом клуба (RLS: брони только этого клуба).
//
//   nextBookingStart(db, { resourceId, after }) → Date | null
//       Начало ближайшей живой брони стола (pending_payment, confirmed, reserved), которая не
//       кончилась к after. Бронь в удержании (началась, гость ещё не пришёл) возвращает своё
//       начало в прошлом — продлить и начать чужую игру нельзя. Котировка (money) ограничивает
//       игру началом минус 5 минут (№106).
//   nextBooking(db, { resourceId, after }) → { id, starts_at, ends_at, source, status } | null
//       Та же ближайшая живая бронь целиком (ISO-время), без имени и телефона гостя.
//   bookingForArrival(db, { resourceId, userId, at }) → бронь | null
//       Бронь гостя на этом столе, которую можно начать в at (с учётом раннего прихода и
//       удержания): { id, club_id, resource_id, status, starts_at, ends_at, hold_until,
//       prepaid_kopecks, amount_kopecks, prepayment_id, early }.
//   markStarted(db, { bookingId, sessionId }) → { ok, already }
//       Бронь началась (status started, outbox booking.started). Повтор безопасен.
//
// До init() модуля (скрипты, тесты соседей) работает автономный экземпляр с системными часами:
// журнал и outbox — core напрямую, без SSE и уведомлений.

import { appendAudit } from '../lib/audit.mjs';
import { enqueue } from '../outbox.mjs';
import { bookingsOrNull } from './index.mjs';
import { createBookingService } from './service.mjs';

let standalone = null;

function service() {
  const s = bookingsOrNull();
  if (s) return s.service;
  if (!standalone) {
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    standalone = createBookingService({
      log,
      clock: { now: () => new Date() },
      deps: {
        audit: { appendAudit },
        outbox: { enqueue },
        notify: { send: async () => null },
        alarms: { raise: async () => null },
        sse: { publish() {} },
        light: {},
        payments: {},
        tariffs: {},
      },
    });
  }
  return standalone;
}

export function nextBookingStart(db, { resourceId, after }) {
  return service().nextBookingStart(db, { resourceId, after });
}

export function nextBooking(db, { resourceId, after }) {
  return service().nextBooking(db, { resourceId, after });
}

export function bookingForArrival(db, { resourceId, userId, at }) {
  return service().bookingForArrival(db, { resourceId, userId, at });
}

export function markStarted(db, { bookingId, sessionId }) {
  return service().markStarted(db, { bookingId, sessionId });
}
