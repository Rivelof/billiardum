/**
 * Журнал (решение №140): статьи — Markdown в web/site/content/zhurnal/, без CMS. В проде пусто, пока Андрей
 * не добавит статьи. Демо-статьи лежат в mock/zhurnal/ и читаются только на заглушке.
 *
 * Файл: slug.md (латиница), в начале — шапка:
 *   ---
 *   title: Как выбрать кий
 *   description: Короткое описание для поиска и карточки
 *   date: 2026-10-20
 *   audience: Игрокам | Владельцам
 *   ---
 * Разметка: ## и ### заголовки, абзацы, списки «- » и «1. », **жирный**, *курсив*, `код`, [ссылка](https://…), > цитата.
 * Сырой HTML в статье не поддерживается: всё экранируется.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SLUG } from './lib.mjs';

const CONTENT = fileURLToPath(new URL('../content/zhurnal/', import.meta.url));
const MOCK = fileURLToPath(new URL('../mock/zhurnal/', import.meta.url));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  // Ссылки: только https:// и свои пути. Внешние — rel="noopener nofollow"
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const h = href.replace(/&amp;/g, '&');
    if (/^https:\/\//.test(h)) return `<a href="${esc(h)}" rel="noopener nofollow">${label}</a>`;
    if (/^\/[^/]/.test(h) || h === '/') return `<a href="${esc(h)}">${label}</a>`;
    return label;
  });
  return s;
}

/** Markdown → HTML (подмножество выше). Заголовок первого уровня в тексте становится h2: h1 — у страницы. */
export function markdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { type: 'ul' | 'ol', items: [] }
  let quote = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`);
    quote = [];
  };
  const flush = () => {
    flushPara();
    flushList();
    flushQuote();
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) {
      flush();
    } else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flush();
      const level = Math.min(3, Math.max(2, m[1].length + (m[1].length === 1 ? 1 : 0)));
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      flushPara();
      flushQuote();
      if (list?.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(m[1]);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara();
      flushQuote();
      if (list?.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(m[1]);
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flushPara();
      flushList();
      quote.push(m[1]);
    } else {
      flushList();
      flushQuote();
      para.push(line.trim());
    }
  }
  flush();
  return out.join('\n');
}

export function parseArticle(slug, src) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src.replace(/\r\n?/g, '\n'));
  const meta = {};
  const body = m ? m[2] : src;
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
      if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  return {
    slug,
    title: meta.title || slug,
    description: meta.description || '',
    date: /^\d{4}-\d{2}-\d{2}$/.test(meta.date ?? '') ? meta.date : null,
    audience: meta.audience || null,
    html: markdown(body),
  };
}

function readDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && SLUG.test(f.slice(0, -3)))
    .map((f) => ({ slug: f.slice(0, -3), file: dir + f, mtime: statSync(dir + f).mtimeMs }));
}

const cache = new Map();

/** Все статьи, новые сверху. mock — добавить демо-статьи заглушки. */
export function listArticles({ mock = false, dirs } = {}) {
  const files = (dirs ?? [CONTENT, ...(mock ? [MOCK] : [])]).flatMap(readDir);
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (seen.has(f.slug)) continue;
    seen.add(f.slug);
    const key = `${f.file}:${f.mtime}`;
    if (!cache.has(key)) cache.set(key, parseArticle(f.slug, readFileSync(f.file, 'utf8')));
    out.push(cache.get(key));
  }
  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.title.localeCompare(b.title, 'ru'));
}

export function getArticle(slug, opts) {
  if (!SLUG.test(slug)) return null;
  return listArticles(opts).find((a) => a.slug === slug) ?? null;
}
