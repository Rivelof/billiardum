/**
 * Разработка сайта без Docker, одинаково в Linux, macOS и Windows: пересборка островов (esbuild watch)
 * и сервер сайта на заглушке API с перезапуском при изменении src/, mock/, shared/.
 *
 *   npm run dev -w @billiardum/web-site   → http://localhost:3100
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, BL_SITE_DEV: '1' };
const children = [
  spawn(process.execPath, ['scripts/build.mjs', '--watch'], { cwd: root, env, stdio: 'inherit' }),
  spawn(process.execPath, ['--watch-path=src', '--watch-path=mock', '--watch-path=../../shared', 'server.mjs'], { cwd: root, env, stdio: 'inherit' }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exitCode = code;
}
for (const c of children) c.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
