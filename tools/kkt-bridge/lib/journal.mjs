// Журнал моста на диске ПК ресепшена: UUID заданий, которые мост уже отправил в АТОЛ,
// и результаты, которые сервер ещё не подтвердил.
//
// Зачем: задание на чек идемпотентно по UUID (decisions №78). Если веб-сервер АТОЛ вдруг
// не знает UUID, который мост уже отправлял (переустановка драйвера, очистка заданий),
// мост не пробивает чек заново, а сообщает серверу «исход неизвестен» — второй чек хуже
// проверки руками. Неподтверждённые результаты досылаются после переподключения.
//
// Файл пишется атомарно (временный файл и rename). Хранится не больше MAX_ENTRIES UUID и
// не дольше KEEP_MS; персональных данных нет — только UUID, время и фискальные реквизиты.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_ENTRIES = 5_000;
export const KEEP_MS = 45 * 24 * 3600_000;

/**
 * @param {{ dir: string|null, now?: () => number }} options dir = null — только в памяти (тесты)
 */
export function createJournal({ dir, now = () => Date.now() }) {
  const file = dir ? join(dir, 'journal.json') : null;
  let data = { v: 1, posted: {}, results: {} };
  if (file) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && parsed.v === 1 && typeof parsed.posted === 'object' && typeof parsed.results === 'object') data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`журнал моста ${file} не читается: ${err.message}`, { cause: err });
    }
  }

  function prune() {
    const cutoff = now() - KEEP_MS;
    const entries = Object.entries(data.posted).filter(([, t]) => t >= cutoff).sort((a, b) => a[1] - b[1]);
    data.posted = Object.fromEntries(entries.slice(-MAX_ENTRIES));
    const results = Object.entries(data.results).filter(([, r]) => (r?.at ?? 0) >= cutoff).sort((a, b) => a[1].at - b[1].at);
    data.results = Object.fromEntries(results.slice(-MAX_ENTRIES));
  }

  function save() {
    if (!file) return;
    prune();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
  }

  return {
    wasPosted: (uuid) => uuid in data.posted,
    /** Отметить до отправки в АТОЛ: сбой процесса после POST не даст отправить второй раз вслепую. */
    markPosted(uuid) {
      data.posted[uuid] = now();
      save();
    },
    /** АТОЛ не принял задание (ККТ не подключена) — задания с этим UUID нет, его можно отправить снова. */
    forget(uuid) {
      delete data.posted[uuid];
      delete data.results[uuid];
      save();
    },
    /** Результат, который сервер ещё не подтвердил (досылается после переподключения). */
    keepResult(uuid, message) {
      data.results[uuid] = { at: now(), message };
      save();
    },
    ackResult(uuid) {
      if (uuid in data.results) {
        delete data.results[uuid];
        save();
      }
    },
    pendingResults: () => Object.values(data.results).map((r) => r.message).filter(Boolean),
  };
}
