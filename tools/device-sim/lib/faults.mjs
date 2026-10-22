// Режимы сбоя симулятора (protocol.md §9, агент firmware).
// Задаются флагами CLI при старте (`--fault имя[@стол][:мс]`) и меняются на ходу
// через HTTP-управление (lib/control.mjs). Исполняет их lib/device.mjs.

export const FAULTS = Object.freeze({
  'net-drop': 'обрыв связи без DISCONNECT (брокер публикует Last Will offline); :мс — сколько длится, по умолчанию 60000',
  reboot: 'перезагрузка: свет выключен, boot+1, событие boot, правило 4 §5; :мс — через сколько после старта, по умолчанию 60000',
  bypass: 'свет в обход: ток при выключенном реле, событие bypass_detected; :мс — сколько длится, без него — постоянно',
  'lamp-fault': 'неисправная лампа: реле включено, тока нет, событие lamp_fault; :мс — сколько длится, без него — постоянно',
  'slow-ack': 'медленный ack: ответ на команду с задержкой :мс, по умолчанию 5000 (сервер повторяет через 3 с)',
  'replay-old': 'повтор старой команды самому себе (T8): после каждой новой команды через :мс (по умолчанию 1000) подаётся предыдущая — replayed_seq',
});

// Значения :мс по умолчанию.
export const FAULT_DEFAULT_MS = Object.freeze({
  'net-drop': 60_000,
  reboot: 60_000,
  bypass: null,
  'lamp-fault': null,
  'slow-ack': 5000,
  'replay-old': 1000,
});

export const MAX_FAULT_MS = 86_400_000;

export class FaultSpecError extends Error {}

/**
 * Разбирает флаги вида `имя`, `имя@стол`, `имя:мс`, `имя@стол:мс` (номер стола из devices.json).
 * @param {string[]} specs
 * @returns {{ name: string, table: number | null, ms: number | null }[]}
 */
export function parseFaults(specs) {
  const out = [];
  for (const raw of specs) {
    for (const spec of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^([a-z-]+)(?:@([^:]*))?(?::(.*))?$/.exec(spec);
      if (!m || !Object.hasOwn(FAULTS, m[1])) {
        throw new FaultSpecError(`неизвестный режим сбоя «${spec}»; есть: ${Object.keys(FAULTS).join(', ')}`);
      }
      const [, name, table, ms] = m;
      if (table !== undefined && !/^[1-9][0-9]*$/.test(table)) throw new FaultSpecError(`номер стола в «${spec}» — целое больше 0`);
      if (ms !== undefined && !(/^[0-9]+$/.test(ms) && Number(ms) <= MAX_FAULT_MS)) {
        throw new FaultSpecError(`длительность в «${spec}» — миллисекунды от 0 до ${MAX_FAULT_MS}`);
      }
      out.push({ name, table: table === undefined ? null : Number(table), ms: ms === undefined ? null : Number(ms) });
    }
  }
  return out;
}

/** Режимы сбоя одного стола из флагов CLI. */
export class FaultFlags {
  #list;

  constructor(faults, tableNumber) {
    this.#list = faults.filter((f) => f.table === null || f.table === tableNumber);
  }

  has(name) {
    return this.#list.some((f) => f.name === name);
  }

  get names() {
    return [...new Set(this.#list.map((f) => f.name))];
  }

  /** [{ name, ms }] — последний флаг на режим главнее. */
  get list() {
    const byName = new Map();
    for (const f of this.#list) byName.set(f.name, f.ms);
    return [...byName].map(([name, ms]) => ({ name, ms }));
  }
}
