import { useEffect, useRef, useState } from 'preact/hooks';
import { streamMe } from './api.js';

/**
 * Свой поток гостя без сессии (№120): GET /api/stream?me=1, события `booking` и `waitlist` (вид — в data.type).
 * onEvent(name, data) зовётся и с name 'open' при каждом (пере)подключении — перечитать то, что могли пропустить.
 * Возвращает true, пока поток открыт: опрос раз в 5 секунд остаётся запасным путём только на время обрыва.
 * @param {(name: string, data: any) => void} onEvent
 * @param {boolean} [enabled]
 */
export function useMeStream(onEvent, enabled = true) {
  const [live, setLive] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!enabled) return undefined;
    const s = streamMe({
      onEvent: (name, data) => handler.current?.(name, data),
      onOpen: () => handler.current?.('open', null),
      onState: (state) => setLive(state === 'open'),
    });
    return () => {
      s.close();
      setLive(false);
    };
  }, [enabled]);
  return live;
}
