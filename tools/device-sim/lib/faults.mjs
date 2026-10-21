// Режимы сбоя симулятора (protocol.md §9, агент firmware).
// В M0 — только флаги: их можно задать, симулятор пишет в лог, что режим
// не реализован до M1, и работает штатно.

export const FAULTS = Object.freeze({
  'net-drop': 'обрыв связи: соединение рвётся без DISCONNECT, брокер публикует Last Will offline',
  reboot: 'перезагрузка: свет выключен, boot+1, событие boot, правило 4 протокола §5',
  bypass: 'свет в обход: ток при выключенном реле, событие bypass_detected',
  'lamp-fault': 'неисправная лампа: реле включено, тока нет, событие lamp_fault',
  'slow-ack': 'медленный ack: ответ на команду с задержкой',
  'replay-old': 'повтор старой команды: ранее принятая команда подаётся повторно, replayed_seq',
});

export const FAULTS_IMPLEMENTED_IN = 'M1';

export class FaultSpecError extends Error {}

/**
 * Разбирает флаги вида `имя` или `имя@стол` (номер стола из devices.json).
 * @param {string[]} specs
 * @returns {{ name: string, table: number | null }[]}
 */
export function parseFaults(specs) {
  const out = [];
  for (const raw of specs) {
    for (const spec of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [name, table, extra] = spec.split('@');
      if (extra !== undefined || !Object.hasOwn(FAULTS, name)) {
        throw new FaultSpecError(`неизвестный режим сбоя «${spec}»; есть: ${Object.keys(FAULTS).join(', ')}`);
      }
      if (table === undefined) {
        out.push({ name, table: null });
        continue;
      }
      if (!/^[1-9][0-9]*$/.test(table)) throw new FaultSpecError(`номер стола в «${spec}» — целое больше 0`);
      out.push({ name, table: Number(table) });
    }
  }
  return out;
}

/** Флаги одного стола. `has()` — точки, где режим заработает в M1. */
export class FaultFlags {
  #names;

  constructor(faults, tableNumber) {
    this.#names = new Set(faults.filter((f) => f.table === null || f.table === tableNumber).map((f) => f.name));
  }

  has(name) {
    return this.#names.has(name);
  }

  get names() {
    return [...this.#names];
  }
}
