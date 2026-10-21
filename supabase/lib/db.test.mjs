// Юнит-тесты инструментов базы (без Postgres).

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checksum, listMigrations, scramKeys, scramVerifier } from './db.mjs';

describe('SCRAM-SHA-256', () => {
  it('ключи совпадают с примером RFC 7677 (user / pencil)', () => {
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const { storedKey, serverKey } = scramKeys('pencil', salt, 4096);
    const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const authMessage = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
    const serverSignature = createHmac('sha256', serverKey).update(authMessage).digest('base64');
    assert.equal(serverSignature, '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
    const clientKey = Buffer.from(proof.map((b, i) => b ^ clientSignature[i]));
    assert.deepEqual(createHash('sha256').update(clientKey).digest(), storedKey);
  });

  it('формат pg_authid и проверка пароля', () => {
    const v = scramVerifier('correct-horse-battery', { salt: Buffer.alloc(16, 1) });
    assert.match(v, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
    assert.ok(!v.includes('correct-horse'));
    assert.notEqual(scramVerifier('correct-horse-battery'), scramVerifier('correct-horse-battery'), 'соль случайная');
    for (const bad of ['short', 'with space inside', 'пароль-кириллицей', '', undefined]) {
      assert.throws(() => scramVerifier(bad), /печатным ASCII/);
    }
  });
});

describe('учёт миграций', () => {
  it('checksum не зависит от CRLF', () => {
    assert.equal(checksum('a\r\nb\r\n'), checksum('a\nb\n'));
    assert.notEqual(checksum('a\nb\n'), checksum('a\nc\n'));
  });

  it('миграции репозитория идут по порядку и названы по шаблону', () => {
    const list = listMigrations();
    assert.ok(list.length >= 3);
    assert.deepEqual(list.map((m) => m.version), [...list.map((m) => m.version)].sort());
    assert.equal(list[0].name, '0001_roles_schema.sql');
    for (const m of list) assert.match(m.checksum, /^[0-9a-f]{64}$/);
  });

  it('отвергает кривые имена и повтор версии', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bl-migr-'));
    try {
      writeFileSync(path.join(dir, '0001_a.sql'), 'select 1;');
      writeFileSync(path.join(dir, '0001_b.sql'), 'select 2;');
      assert.throws(() => listMigrations(dir), /две миграции с версией 0001/);
      rmSync(path.join(dir, '0001_b.sql'));
      writeFileSync(path.join(dir, '2_bad-name.sql'), 'select 3;');
      assert.throws(() => listMigrations(dir), /не по шаблону/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
