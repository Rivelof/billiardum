// Состояния и переходы контроллера — docs/protocol.md §5 и PRODUCT §3.
// Исполняет lib/machine.mjs; таблица здесь — для чтения и для тестов согласованности.

export const MODES = Object.freeze(['free', 'pending', 'reserved', 'active', 'ending', 'grace', 'service', 'fault']);

export const LEDS = Object.freeze([
  'off', 'green_dim', 'white_blink', 'blue', 'yellow_blink', 'red', 'red_fast', 'purple', 'identify',
]);

// Индикатор и реле в каждом состоянии (PRODUCT §3, «Состояния стола»).
export const MODE_OUTPUTS = Object.freeze({
  free: { relay: false, led: 'green_dim' },
  pending: { relay: false, led: 'white_blink' },
  reserved: { relay: false, led: 'blue' },
  active: { relay: true, led: 'off' },
  ending: { relay: true, led: 'yellow_blink' },
  grace: { relay: true, led: 'red' }, // приглушение до grace_dim или мигание раз в grace_blink_s
  service: { relay: true, led: 'purple' },
  fault: { relay: false, led: 'red_fast' },
});

// Режимы с идущей сессией и режимы без света.
export const SESSION_MODES = Object.freeze(new Set(['active', 'ending', 'grace']));
export const IDLE_MODES = Object.freeze(new Set(['free', 'pending', 'reserved']));

// Переходы §5. Ключ — команда или внутреннее событие (в скобках), значение — новое состояние.
// `session.extend` из ending/grace ведёт в active или ending в зависимости от остатка и warn_ms.
// Команда, которой нет в строке состояния, отвечает так (lib/machine.mjs):
// - session.start, session.resume, state.free — из любого состояния (сервер главный);
// - session.extend, session.stop без идущей сессии с тем же session_id — wrong_session;
// - service.start, state.pending, state.reserved во время сессии — wrong_session;
// - state.pending, state.reserved в service — wrong_session; service.stop не в service — ok, ничего.
export const TRANSITIONS = Object.freeze({
  free: {
    'state.pending': 'pending',
    'state.reserved': 'reserved',
    'session.start': 'active|ending',
    'session.resume': 'active|ending',
    'service.start': 'service',
    '(ток при выключенном реле)': 'fault',
  },
  pending: {
    'session.start': 'active|ending',
    'state.pending': 'pending',
    'state.reserved': 'reserved',
    'state.free': 'free',
    'service.start': 'service',
    '(until_ms)': 'free',
  },
  reserved: {
    'session.start': 'active|ending',
    'state.pending': 'pending',
    'state.reserved': 'reserved',
    'state.free': 'free',
    'service.start': 'service',
    '(until_ms)': 'free',
  },
  active: {
    '(remaining<=warn_ms[0])': 'ending',
    'session.extend': 'active|ending',
    'session.stop': 'free',
    'state.free': 'free',
  },
  ending: {
    '(remaining=0)': 'grace',
    'session.extend': 'active|ending',
    'session.stop': 'free',
    'state.free': 'free',
  },
  grace: {
    '(grace_ms)': 'free',
    'session.extend': 'active|ending',
    'session.stop': 'free',
    'state.free': 'free',
  },
  service: {
    '(duration_ms)': 'free',
    'service.stop': 'free',
    'service.start': 'service',
    'state.free': 'free',
  },
  fault: {
    '(ток в норме)': 'free|pending|reserved',
  },
});

// Типы команд протокола §3.3.
export const COMMAND_TYPES = Object.freeze([
  'session.start', 'session.resume', 'session.extend', 'session.stop',
  'service.start', 'service.stop',
  'state.reserved', 'state.pending', 'state.free',
  'identify', 'config.set', 'ota.start', 'ping',
]);

export function relayFor(mode) {
  return MODE_OUTPUTS[mode].relay;
}

export function ledFor(mode) {
  return MODE_OUTPUTS[mode].led;
}
