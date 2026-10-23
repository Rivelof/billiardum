import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listArticles, markdown, parseArticle } from '../src/journal.mjs';
import { minifyCss } from '../src/document.mjs';

test('Markdown: заголовки, списки, ссылки только https и свои, сырой HTML экранируется', () => {
  const h = markdown('# Заголовок\n\nТекст **жирный** и *курсив* и `код`.\n\n- раз\n- два\n\n1. первый\n\n> цитата\n\n[свой](/plus/) [чужой](https://example.org) [плохой](javascript:alert(1)) <script>alert(1)</script>');
  assert.match(h, /<h2>Заголовок<\/h2>/);
  assert.match(h, /<strong>жирный<\/strong> и <em>курсив<\/em> и <code>код<\/code>/);
  assert.match(h, /<ul><li>раз<\/li><li>два<\/li><\/ul>/);
  assert.match(h, /<ol><li>первый<\/li><\/ol>/);
  assert.match(h, /<blockquote><p>цитата<\/p><\/blockquote>/);
  assert.match(h, /<a href="\/plus\/">свой<\/a>/);
  assert.match(h, /<a href="https:\/\/example\.org" rel="noopener nofollow">чужой<\/a>/);
  assert.doesNotMatch(h, /javascript:|<script>/);
  assert.match(h, /&lt;script&gt;/);
});

test('статья: шапка, дата, порядок новые сверху, файлы с неправильным именем пропускаются', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bl-zhurnal-'));
  writeFileSync(join(dir, 'staraya.md'), '---\ntitle: Старая\ndate: 2026-01-01\n---\nТекст');
  writeFileSync(join(dir, 'novaya.md'), '---\ntitle: Новая\ndate: 2026-10-01\naudience: Игрокам\n---\nТекст');
  writeFileSync(join(dir, 'README.md'), '# не статья');
  writeFileSync(join(dir, 'Плохое имя.md'), 'x');
  const list = listArticles({ dirs: [`${dir}/`] });
  assert.deepEqual(list.map((a) => a.slug), ['novaya', 'staraya']);
  assert.equal(list[0].audience, 'Игрокам');
  assert.equal(parseArticle('x', 'Без шапки').title, 'x');
});

test('в репозитории нет статей для прода — только README (демо — в mock/zhurnal)', () => {
  assert.deepEqual(listArticles({ mock: false }), []);
  assert.ok(listArticles({ mock: true }).length >= 1);
});

test('минификация CSS не ломает правила', () => {
  assert.equal(minifyCss('/* x */\na  {  color : red ; }\n\n b > c { x: y; }'), 'a{color : red}b>c{x: y}');
});
