// Таблица повторов — docs/protocol.md §3.2.
//
// | Пришло                              | Решение   |
// |-------------------------------------|-----------|
// | seq больше сохранённого             | execute   |
// | seq равен сохранённому, id тот же   | resend    | не исполнять, отправить сохранённый ack
// | seq равен сохранённому, id другой   | replayed  | replayed_seq и событие
// | seq меньше сохранённого             | replayed  |
//
// Блок в NVS (одна запись): { seq, id, ok, error, state_seq } — ack хранится компактно
// и собирается заново байт в байт (ackPayload).

/**
 * @param {{ seq: number, id: string } | null | undefined} saved
 * @param {number} seq
 * @param {string} id
 * @returns {'execute' | 'resend' | 'replayed'}
 */
export function decideReplay(saved, seq, id) {
  const savedSeq = saved?.seq ?? 0;
  if (seq > savedSeq) return 'execute';
  if (seq === savedSeq && typeof saved?.id === 'string' && saved.id === id) return 'resend';
  return 'replayed';
}

/** `ack` по §4 — одна функция и для ответа, и для повтора из NVS. */
export function ackPayload({ id, seq, ok, error, state_seq: stateSeq }) {
  return JSON.stringify({ v: 1, cmd_id: id, seq, ok, error: ok ? null : error, state_seq: stateSeq });
}
