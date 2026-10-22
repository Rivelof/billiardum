// Одноразовые токены SSE для мини-приложений (контракт M1 §14, decisions №64): EventSource
// не передаёт Authorization, а cookie во фрейме веб-версии мессенджера может не дойти.
// POST /api/stream/token → токен на 60 с, привязанный к пользователю, его токену входа
// и каналу (club или session); GET /api/stream?...&token= принимает его один раз.
// Один процесс сервера: токены в памяти, как и сами потоки SSE. Хранится только sha256.

import { createHash, randomBytes } from 'node:crypto';

export const STREAM_TOKEN_TTL_MS = 60_000;
export const MAX_PER_USER = 20;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

/** Канал запроса потока: { club }, { session } или { me } (ровно одно; me — свой канал user:{id}). */
export function streamTarget(query) {
  const club = query?.club;
  const session = query?.session;
  const me = query?.me;
  const given = [club, session, me].filter((x) => x !== undefined).length;
  if (given !== 1) return null;
  if (me !== undefined) return me === '1' || me === 1 || me === true ? { kind: 'me', id: 'me' } : null;
  const id = club ?? session;
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  return club !== undefined ? { kind: 'club', id } : { kind: 'session', id };
}

export function createStreamTokens({ now = () => Date.now(), ttlMs = STREAM_TOKEN_TTL_MS } = {}) {
  /** @type {Map<string, { principal: object, target: { kind: string, id: string }, expiresAt: number }>} */
  const tokens = new Map();

  function sweep() {
    const t = now();
    for (const [k, v] of tokens) if (v.expiresAt <= t) tokens.delete(k);
  }

  return {
    /**
     * Выдать токен пользователю principal на канал target.
     * @returns {{ token: string, expiresAt: Date }}
     */
    issue(principal, target) {
      sweep();
      let mine = 0;
      for (const v of tokens.values()) if (v.principal.userId === principal.userId) mine += 1;
      if (mine >= MAX_PER_USER) return null;
      const token = randomBytes(32).toString('base64url');
      const expiresAt = now() + ttlMs;
      tokens.set(sha(token), { principal: { ...principal }, target: { ...target }, expiresAt });
      return { token, expiresAt: new Date(expiresAt) };
    },

    /**
     * Принять токен один раз для канала target. Возвращает principal или null
     * (нет, истёк, уже использован, другой канал).
     */
    consume(token, target) {
      if (typeof token !== 'string' || !TOKEN.test(token) || !target) return null;
      const key = sha(token);
      const entry = tokens.get(key);
      if (!entry) return null;
      tokens.delete(key);
      if (entry.expiresAt <= now()) return null;
      if (entry.target.kind !== target.kind || entry.target.id !== target.id) return null;
      return entry.principal;
    },

    get size() {
      return tokens.size;
    },
  };
}

/** Общее хранилище процесса. */
export const streamTokens = createStreamTokens();
