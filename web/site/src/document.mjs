/**
 * HTML-документ страницы: мета, канонический адрес, OG, JSON-LD, критический CSS инлайн, предзагрузка своих
 * шрифтов, тема до первой отрисовки, острова. CSP — с хешами встроенного CSS и скриптов, без 'unsafe-inline'.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'preact-render-to-string';
import { html } from './html.mjs';
import { BottomNav, Footer, Header, MockNote } from './components.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHARED = fileURLToPath(new URL('../../../shared/', import.meta.url));

/** Лёгкая минификация CSS: комментарии и лишние пробелы. */
export function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

let cssCache = null;
/** Весь CSS страницы одной строкой и его хеш для CSP. reload — перечитать файлы (режим разработки). */
export function siteCss(reload = false) {
  if (cssCache && !reload) return cssCache;
  const fonts = readFileSync(`${SHARED}fonts.css`, 'utf8').replaceAll("url('./fonts/", "url('/shared/fonts/");
  const parts = [
    fonts,
    readFileSync(`${SHARED}tokens.css`, 'utf8'),
    readFileSync(`${SHARED}ui.css`, 'utf8'),
    readFileSync(`${SHARED}hall.css`, 'utf8'),
    readFileSync(`${ROOT}src/styles/site.css`, 'utf8'),
  ];
  const css = minifyCss(parts.join('\n'));
  cssCache = { css, hash: sha256(css) };
  return cssCache;
}

export function sha256(s) {
  return `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
}

// Тема до первой отрисовки: тёмная по умолчанию, светлая — если её выбрали (тот же ключ, что у приложения гостя).
// Класс js на <html> — тоже до отрисовки: то, что заменяют острова (кнопка «Показать клубы» у фильтров), скрыто
// стилями сразу, а не после загрузки острова — без сдвига вёрстки (CLS, Д6 приёмки M4).
const THEME_INIT = "document.documentElement.classList.add('js');try{if(localStorage.getItem('bl-theme')==='light')document.documentElement.setAttribute('data-theme','light')}catch(e){}";

/** Остров → путь к файлу сборки (dist/manifest.json от scripts/build.mjs). Без сборки островов нет. */
let manifestCache = null;
export function islands(reload = false) {
  if (manifestCache && !reload) return manifestCache;
  const file = `${ROOT}dist/manifest.json`;
  manifestCache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return manifestCache;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JSON внутри <script>: «</» и разделители строк не должны закрыть тег. */
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function metrikaScript(id) {
  // Метрика без Вебвизора и без карты кликов (решение №141): только посещаемость и цели
  return `(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");ym(${Number(id)},"init",{webvisor:false,clickmap:false,trackLinks:true,accurateTrackBounce:true});`;
}

/**
 * @param {object} p
 * @param {object} p.cfg loadConfig()
 * @param {string} p.path канонический путь страницы, например '/ekaterinburg/'
 * @param {string} p.title
 * @param {string} p.description
 * @param {import('preact').VNode} p.body содержимое <main>
 * @param {string[]} [p.islands] имена островов: site (всегда), break, hall, owners
 * @param {object[]} [p.jsonld]
 * @param {{ image?: string, type?: string }} [p.og]
 * @param {boolean} [p.noindex]
 * @param {string} [p.active] пункт меню
 * @param {string} [p.citySlug]
 * @param {{ slug, name }[]} [p.cities] для подвала
 * @returns {{ html: string, csp: string }}
 */
export function renderDocument(p) {
  const { cfg } = p;
  const { css, hash: cssHash } = siteCss(cfg.dev);
  const canonical = cfg.origin + p.path;
  const image = p.og?.image ? (p.og.image.startsWith('http') ? p.og.image : cfg.origin + p.og.image) : `${cfg.origin}/og/site.png`;
  const manifest = islands(cfg.dev);
  const scripts = [...new Set(['site', ...(p.islands ?? [])])].map((n) => manifest[n]).filter(Boolean);
  const robots = cfg.noindex || p.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large';
  const inlineScripts = [THEME_INIT];
  if (cfg.metrika) inlineScripts.push(metrikaScript(cfg.metrika));

  const body = render(html`<a class="skip" href="#main">К содержанию</a>
    ${cfg.mock ? html`<${MockNote} />` : null}
    <${Header} active=${p.active} citySlug=${p.citySlug} />
    <main id="main" tabindex="-1">${p.body}</main>
    <${Footer} cities=${p.cities ?? []} />
    <${BottomNav} active=${p.active} citySlug=${p.citySlug} />`);

  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    `<meta name="robots" content="${robots}">`,
    '<meta name="theme-color" content="#120E0B">',
    '<meta name="color-scheme" content="dark light">',
    cfg.verification ? `<meta name="yandex-verification" content="${esc(cfg.verification)}">` : '',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="preload" href="/shared/fonts/geologica-cyrillic-wght-normal.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="preload" href="/shared/fonts/dela-gothic-one-cyrillic-400-normal.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="preload" href="/shared/fonts/geologica-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>',
    `<meta property="og:type" content="${esc(p.og?.type ?? 'website')}">`,
    '<meta property="og:site_name" content="Бильярдум">',
    '<meta property="og:locale" content="ru_RU">',
    `<meta property="og:title" content="${esc(p.og?.title ?? p.title)}">`,
    `<meta property="og:description" content="${esc(p.description)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<style>${css}</style>`,
    `<script>${THEME_INIT}</script>`,
    ...(p.jsonld ?? []).map((j) => `<script type="application/ld+json">${jsonForScript(j)}</script>`),
    ...scripts.map((s) => `<script type="module" src="${esc(s)}"></script>`),
    cfg.metrika ? `<script>${inlineScripts[1]}</script>` : '',
  ].filter(Boolean).join('\n');

  const noscriptMetrika = cfg.metrika
    ? `<noscript><div><img src="https://mc.yandex.ru/watch/${Number(cfg.metrika)}" class="ym-pixel" alt=""></div></noscript>`
    : '';

  const doc = `<!doctype html>\n<html lang="ru">\n<head>\n${head}\n</head>\n<body>\n${body}\n${noscriptMetrika}\n</body>\n</html>\n`;

  const ym = cfg.metrika ? ' https://mc.yandex.ru' : '';
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${inlineScripts.map(sha256).join(' ')}${ym}`,
    `style-src 'self' ${cssHash}`,
    `img-src 'self' data:${ym}`,
    "font-src 'self'",
    `connect-src 'self'${ym}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { html: doc, csp };
}
