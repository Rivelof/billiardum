/**
 * Бильярдум — сайт-агрегатор (web/site/, контракт M4 §1 п.1): серверный рендер на Node 22 и Preact
 * renderToString, без фреймворка. Данные — только из публичного API (BL_API_URL), кэш 60 с. Статика —
 * острова из dist/assets (собирает scripts/build.mjs) и шрифты из shared/fonts. Ответы сжимаются здесь
 * (br или gzip), Caddy может сжимать поверх — двойного сжатия не будет: Content-Encoding уже стоит.
 *
 *   npm run build -w @billiardum/web-site && npm run start -w @billiardum/web-site
 */
import { Buffer } from 'node:buffer';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { createSite } from './src/app.mjs';
import { loadConfig } from './src/config.mjs';
import { createData } from './src/data.mjs';
import { clientIp } from './src/net.mjs';
import { ogAvailable } from './src/og.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const ASSETS = join(ROOT, 'dist/assets');
const FONTS = fileURLToPath(new URL('../../shared/fonts/', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const MAX_BODY = 16 * 1024;

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};


function compress(req, res, status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
  const type = String(headers['content-type'] ?? '');
  const accept = String(req.headers['accept-encoding'] ?? '');
  const compressible = buf.length > 1024 && /^(text\/|application\/(json|xml)|image\/svg)/.test(type);
  const out = { ...headers };
  let payload = buf;
  if (compressible && /\bbr\b/.test(accept)) {
    payload = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
    out['content-encoding'] = 'br';
  } else if (compressible && /\bgzip\b/.test(accept)) {
    payload = gzipSync(buf, { level: 6 });
    out['content-encoding'] = 'gzip';
  }
  if (compressible) out.vary = out.vary ? `${out.vary}, Accept-Encoding` : 'Accept-Encoding';
  out['content-length'] = payload.length;
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

/** Файл из папки без выхода за её пределы; для .js — заранее сжатые .br и .gz из сборки. */
function serveFile(req, res, dir, rel, cache) {
  const file = normalize(join(dir, rel));
  if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) return false;
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const accept = String(req.headers['accept-encoding'] ?? '');
  let path = file;
  const headers = { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' };
  if (type.startsWith('text/javascript') || type.startsWith('image/svg')) {
    headers.vary = 'Accept-Encoding';
    if (/\bbr\b/.test(accept) && existsSync(`${file}.br`)) {
      path = `${file}.br`;
      headers['content-encoding'] = 'br';
    } else if (/\bgzip\b/.test(accept) && existsSync(`${file}.gz`)) {
      path = `${file}.gz`;
      headers['content-encoding'] = 'gzip';
    }
  }
  headers['content-length'] = statSync(path).size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(path).pipe(res);
  return true;
}

export function startServer(cfg = loadConfig()) {
  const data = createData({ apiUrl: cfg.apiUrl, mock: cfg.mock, cacheMs: cfg.cacheMs });
  const handle = createSite({ cfg, data });

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://site');
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (url.pathname.startsWith('/assets/') && serveFile(req, res, ASSETS, url.pathname.slice(8), 'public, max-age=31536000, immutable')) return;
        if (url.pathname.startsWith('/shared/fonts/') && serveFile(req, res, FONTS, url.pathname.slice(14), 'public, max-age=2592000')) return;
        if (url.pathname === '/favicon.svg' && serveFile(req, res, PUBLIC, 'favicon.svg', 'public, max-age=86400')) return;
        if (url.pathname === '/health') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('ok');
          return;
        }
      }
      let body = '';
      if (req.method === 'POST') {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) {
            res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Слишком большой запрос');
            return;
          }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks).toString('utf8');
      }
      const ip = clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], cfg.trustedProxies);
      const out = await handle({ method: req.method, url, headers: req.headers, body, ip });
      compress(req, res, out.status, out.headers, out.body);
    } catch (err) {
      // В логе — путь и ошибка, без query (там могут быть данные формы) и без тела запроса
      console.error(`[site] ${req.method} ${url.pathname} ошибка: ${err?.stack ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Внутренняя ошибка сайта. Обновите страницу через минуту.');
      }
    } finally {
      if (cfg.dev) console.log(`[site] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started} мс`);
    }
  });
  server.listen(cfg.port, () => {
    console.log(`[site] http://localhost:${cfg.port} — данные: ${cfg.mock ? 'заглушка web/site/mock (демо)' : cfg.apiUrl}, кэш ${cfg.cacheMs} мс, Метрика: ${cfg.metrika ? 'включена' : 'выключена'}`);
    if (!existsSync(join(ROOT, 'dist/manifest.json'))) console.warn('[site] нет сборки островов (dist/manifest.json): npm run build -w @billiardum/web-site');
    ogAvailable().then((ok) => {
      if (!ok) console.warn('[site] @resvg/resvg-js не установлен: OG-картинки отдаются как SVG');
    });
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) startServer();
