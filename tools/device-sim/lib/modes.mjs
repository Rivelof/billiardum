// Состояния и переходы контроллера — docs/protocol.md §5 и PRODUCT §3.
// В M0 таблица задаёт структуру; исполняются только ping и identify.
// Сессии, сигналы, перезагрузки (правило 4) и датчик тока — M1.

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

// Переходы §5. Ключ — команда или внутреннее событие (в скобках), значение — новое состояние.
// `session.extend` из ending/grace ведёт в active или ending в зависимости от остатка и warn_ms[0].
export const TRANSITIONS = Object.freeze({
  free: {
    'state.pending': 'pending',
    'state.reserved': 'reserved',
    'session.start': 'active',
    'session.resume': 'active',
    'service.start': 'service',
  },
  pending: {
    'session.start': 'active',
    'state.reserved': 'reserved',
    'state.free': 'free',
    '(until_ms)': 'free',
  },
  reserved: {
    'session.start': 'active',
    'state.pending': 'pending',
    'state.free': 'free',
    '(until_ms)': 'free',
  },
  active: {
    '(remaining<=warn_ms[0])': 'ending',
    'session.extend': 'active',
    'session.stop': 'free',
  },
  ending: {
    '(remaining=0)': 'grace',
    'session.extend': 'active|ending',
    'session.stop': 'free',
  },
  grace: {
    '(grace_ms)': 'free',
    'session.extend': 'active|ending',
    'session.stop': 'free',
  },
  service: {
    '(duration_ms)': 'free',
    'service.stop': 'free',
  },
  fault: {},
});

// Типы команд протокола §3.3 и что из них исполняет симулятор в M0.
export const COMMAND_TYPES = Object.freeze([
  'session.start', 'session.extend', 'session.stop', 'session.resume',
  'service.start', 'service.stop',
  'state.reserved', 'state.pending', 'state.free',
  'identify', 'config.set', 'ota.start', 'ping',
]);

export const EXECUTED_IN_M0 = Object.freeze(new Set(['ping', 'identify']));

export function relayFor(mode) {
  return MODE_OUTPUTS[mode].relay;
}

export function ledFor(mode) {
  return MODE_OUTPUTS[mode].led;
}
