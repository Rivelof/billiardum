/**
 * Сканер QR камерой (M5.1, №159): QR на корпусе контроллера BLD1:{device_id}:{claim_code}.
 *
 * Сначала встроенный BarcodeDetector (Chrome на Android, Safari 17+ — без загрузки кода). Если его нет —
 * локальный jsQR (Apache-2.0, чистый JS без сети и WASM, ~46 КБ gzip), отдельный чанк: грузится только
 * у тех, кому он нужен, с нашего сервера (decisions №22). Кадры никуда не отправляются.
 */

/** Ошибка камеры словами: что случилось и что делать. */
export function cameraErrorText(code) {
  switch (code) {
    case 'camera_denied':
      return 'Браузер не дал доступ к камере. Разрешите камеру для этого сайта в настройках браузера или введите номер и код вручную.';
    case 'camera_missing':
      return 'Камера не найдена. Введите номер и код с наклейки вручную.';
    case 'camera_unavailable':
      return 'Камера здесь недоступна: откройте программу клуба по адресу https на телефоне или введите номер и код вручную.';
    default:
      return 'Камера не запустилась. Попробуйте ещё раз или введите номер и код вручную.';
  }
}

function cameraCode(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') return 'camera_denied';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'camera_missing';
  return 'camera_failed';
}

/**
 * Запустить сканер на <video>. onCode(text) — каждый распознанный QR; вызывающий решает, подходит ли он.
 * @returns {Promise<{ stop(): void, engine: 'native' | 'jsqr' }>}; ошибка — Error с .code из cameraErrorText
 */
export async function startScanner(video, onCode) {
  const md = globalThis.navigator?.mediaDevices;
  if (!md?.getUserMedia) throw Object.assign(new Error('camera'), { code: 'camera_unavailable' });
  let stream;
  try {
    stream = await md.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (err) {
    throw Object.assign(new Error('camera'), { code: cameraCode(err) });
  }
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play().catch(() => {});

  let stopped = false;
  let timer = null;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  };

  let detect;
  let engine = 'jsqr';
  const BD = globalThis.BarcodeDetector;
  if (BD) {
    try {
      const formats = (await BD.getSupportedFormats?.()) ?? ['qr_code'];
      if (formats.includes('qr_code')) {
        const detector = new BD({ formats: ['qr_code'] });
        detect = async () => (await detector.detect(video)).map((c) => c.rawValue);
        engine = 'native';
      }
    } catch {
      detect = null;
    }
  }
  if (!detect) {
    const { default: jsQR } = await import('jsqr');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    detect = async () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return [];
      const scale = Math.min(1, 640 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      return hit?.data ? [hit.data] : [];
    };
  }

  const loop = async () => {
    if (stopped) return;
    try {
      for (const text of await detect()) if (text) onCode(text);
    } catch {
      // кадр не прочитался — следующий
    }
    if (!stopped) timer = setTimeout(loop, 200);
  };
  loop();
  return { stop, engine };
}
