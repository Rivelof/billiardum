// Лог — строки JSON в stdout: {"t","level","msg",...}. Без персональных данных:
// в поля попадают только идентификаторы и коды; телефоны маскируются maskPhone.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', write = (line) => process.stdout.write(`${line}\n`), now = () => new Date() } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    write(JSON.stringify({ t: now().toISOString(), level: lvl, msg, ...fields }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** +79991234567 → +7999***4567. */
export function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 8) return '***';
  return `${phone.slice(0, 5)}***${phone.slice(-4)}`;
}
