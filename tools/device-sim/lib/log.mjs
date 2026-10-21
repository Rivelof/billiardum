// Лог — строки JSON в stdout: {"t":"…","level":"info","msg":"…", …поля}.
// Секретов (пароль MQTT, device_key, подписи) в полях быть не должно: вызывающий
// код передаёт только идентификаторы, номера и коды.

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

/**
 * @param {{ level?: string, write?: (line: string) => void, now?: () => Date }} [options]
 */
export function createLogger(options = {}) {
  const threshold = LEVELS[options.level] ?? LEVELS.info;
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const emit = (level, msg, fields = {}) => {
    if (LEVELS[level] < threshold) return;
    write(JSON.stringify({ t: now().toISOString(), level, msg, ...fields }));
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child(base) {
      const parent = this;
      return {
        debug: (msg, fields) => parent.debug(msg, { ...base, ...fields }),
        info: (msg, fields) => parent.info(msg, { ...base, ...fields }),
        warn: (msg, fields) => parent.warn(msg, { ...base, ...fields }),
        error: (msg, fields) => parent.error(msg, { ...base, ...fields }),
        child: (more) => parent.child({ ...base, ...more }),
      };
    },
  };
}

/** URL без логина и пароля — для лога. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '(неверный URL)';
  }
}
