// Таблица повторов — docs/protocol.md §3.2.
//
// | Пришло                              | Решение   |
// |-------------------------------------|-----------|
// | seq больше сохранённого             | execute   |
// | seq равен сохранённому, id тот же   | resend    | не исполнять, отправить сохранённый ack
// | seq равен сохранённому, id другой   | replayed  | replayed_seq и событие
// | seq меньше сохранённого             | replayed  |

/**
 * @param {{ seq: number, id: string | null, ack: string | null } | null | undefined} saved
 * @param {number} seq
 * @param {string} id
 * @returns {'execute' | 'resend' | 'replayed'}
 */
export function decideReplay(saved, seq, id) {
  const savedSeq = saved?.seq ?? 0;
  if (seq > savedSeq) return 'execute';
  if (seq === savedSeq && saved?.id === id && typeof saved.ack === 'string') return 'resend';
  return 'replayed';
}
