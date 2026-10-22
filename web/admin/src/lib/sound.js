/**
 * Звук новой заявки — синтез WebAudio, без файлов из интернета: два мягких удара, как шар о шар, и тон выше.
 * Браузер разрешает звук только после действия человека, поэтому на ресепшене есть кнопка «Включить звук».
 */

let ctx = null;

/** Ноты сигнала: [частота Гц, задержка с, длительность с, громкость]. Вынесено для теста. */
export const CHIME = [
  [1046.5, 0, 0.5, 0.28],
  [1568, 0.14, 0.9, 0.24],
];

export function audioState() {
  return ctx?.state ?? 'none';
}

/** Разблокировать звук: вызывать из обработчика нажатия. */
export async function unlockAudio() {
  const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AC) return false;
  ctx ??= new AC();
  if (ctx.state !== 'running') await ctx.resume();
  return ctx.state === 'running';
}

/** Сыграть сигнал заявки. Возвращает false, если звук ещё не разрешён. */
export function chime() {
  if (!ctx || ctx.state !== 'running') return false;
  const t = ctx.currentTime + 0.02;
  for (const [freq, delay, dur, vol] of CHIME) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t + delay);
    gain.gain.setValueAtTime(0.0001, t + delay);
    gain.gain.exponentialRampToValueAtTime(vol, t + delay + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + delay);
    osc.stop(t + delay + dur + 0.05);
  }
  return true;
}
