// Служба моста ККТ (decisions №77, №78, №85): исходящее WebSocket-соединение с сервером
// «Бильярдума», задания на чек — в веб-сервер драйвера АТОЛ на этом ПК, ответ — результатом.
// Мост ничего не слушает наружу.
//
// Протокол с сервером (JSON, по сообщению в кадре; описан в server/kkt/README.md):
//   мост → сервер: hello {v, name, version, atol_api}; result {job_id, uuid, kind, outcome, task_created,
//                  fiscal?, error?}; status {kkt}; pong
//   сервер → мост: welcome {bridge_id, club_id, ping_ms}; job {job_id, kind, uuid, request}; ack {uuid}; ping
// outcome: done — пробито (fiscal: fd, fp, fn, …); error — задание завершилось ошибкой, документа нет
// (error: code, description, category; task_created — есть ли в АТОЛ задание с этим UUID);
// skipped — смена ККТ уже в нужном состоянии; in_progress — ещё выполняется или ККТ заблокирована;
// unknown — исход неизвестен (UUID был отправлен, а АТОЛ его не знает): проверить руками.
//
// Идемпотентность по UUID задания (= receipt_id, №78): сначала мост спрашивает АТОЛ о статусе
// этого UUID и только если задания нет — ставит его. Повтор после обрыва не пробивает второй чек.

import { createAtolClient, AtolUnreachable, isFinal } from './atol.mjs';
import { categoryOf } from './codes.mjs';
import { createJournal } from './journal.mjs';

export const VERSION = '0.1.0';
export const PROTOCOL = 1;
/** Без сообщений от сервера столько интервалов ping — соединение считается мёртвым. */
const SILENCE_PINGS = 3;
const MAX_MESSAGE = 256 * 1024;

const JOB_KINDS = new Set(['receipt', 'open_shift', 'close_shift']);
const UUID_LIKE = /^[0-9A-Za-z-]{8,64}$/;

/** Фискальные реквизиты из результата АТОЛ (fiscalParams). */
export function parseFiscal(result) {
  const f = result?.fiscalParams;
  if (!f || typeof f !== 'object') return null;
  const fd = Number(f.fiscalDocumentNumber);
  if (!Number.isSafeInteger(fd) || fd <= 0) return null;
  const fpRaw = f.fiscalDocumentSign;
  const fp = fpRaw === undefined || fpRaw === null || fpRaw === '' ? null : String(fpRaw);
  const fn = typeof f.fnNumber === 'string' && /^\d{16}$/.test(f.fnNumber) ? f.fnNumber : null;
  return {
    fd,
    fp: fp && /^\d{1,10}$/.test(fp) ? fp : null,
    fn,
    receipt_number: Number.isSafeInteger(f.fiscalReceiptNumber) ? f.fiscalReceiptNumber : null,
    shift_number: Number.isSafeInteger(f.shiftNumber) ? f.shiftNumber : null,
    registration_number: typeof f.registrationNumber === 'string' ? f.registrationNumber.slice(0, 20) : null,
    datetime: typeof f.fiscalDocumentDateTime === 'string' ? f.fiscalDocumentDateTime.slice(0, 40) : null,
    total: typeof f.total === 'number' ? f.total : null,
    partial: !(fp && fn),
  };
}

/**
 * @param {{ config: object, log?: object, WebSocketImpl?: any, atol?: object, journal?: object,
 *           sleep?: (ms: number) => Promise<void>, random?: () => number }} options
 */
export function createBridge({ config, log = null, WebSocketImpl = globalThis.WebSocket, atol, journal, sleep, random = Math.random }) {
  const L = log ?? { info() {}, warn() {}, error() {}, debug() {} };
  const atolClient = atol ?? createAtolClient({ baseUrl: config.atolUrl, api: config.atolApi, deviceId: config.atolDeviceId, auth: config.atolAuth });
  const book = journal ?? createJournal({ dir: config.dataDir });
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let ws = null;
  let welcomed = false;
  let stopping = false;
  let delay = config.reconnectMinMs;
  let reconnectTimer = null;
  let silenceTimer = null;
  let statusTimer = null;
  let pingMs = 20_000;
  const queue = [];
  let current = null;
  let pumping = null;
  let kkt = { online: null, reason: 'not_checked' };
  let statusSupported = true;
  const counters = { connects: 0, jobs: 0, posted: 0, results: 0 };

  function send(msg) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      L.warn('bridge_send_failed', { error: err.message });
      return false;
    }
  }

  function armSilence() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      L.warn('bridge_server_silent', { ms: pingMs * SILENCE_PINGS });
      try {
        ws?.close(4000, 'silent');
      } catch {
        /* закрывается */
      }
    }, pingMs * SILENCE_PINGS);
    silenceTimer.unref?.();
  }

  function scheduleReconnect() {
    if (stopping || reconnectTimer) return;
    const jitter = 0.8 + random() * 0.4;
    const ms = Math.round(Math.min(delay, config.reconnectMaxMs) * jitter);
    delay = Math.min(delay * 2, config.reconnectMaxMs);
    L.info('bridge_reconnect_in', { ms });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, ms);
    // Таймер переподключения держит процесс: без соединения и задач цикл событий пуст,
    // и с unref процесс завершился бы с кодом 0 — касса молча перестала бы пробивать чеки.
  }

  function connect() {
    if (stopping) return;
    welcomed = false;
    let sock;
    try {
      sock = new WebSocketImpl(config.serverUrl, { headers: { authorization: `Bearer ${config.token}` } });
    } catch (err) {
      L.error('bridge_connect_failed', { error: err.message });
      scheduleReconnect();
      return;
    }
    ws = sock;
    counters.connects += 1;
    sock.onopen = () => {
      if (ws !== sock) return;
      L.info('bridge_connected', { url: new URL(config.serverUrl).host });
      send({ type: 'hello', v: PROTOCOL, name: config.name, version: VERSION, atol_api: config.atolApi });
      armSilence();
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      armSilence();
      const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      if (text.length > MAX_MESSAGE) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        L.warn('bridge_bad_message', {});
        return;
      }
      onMessage(msg);
    };
    sock.onerror = (ev) => {
      if (ws !== sock) return;
      L.warn('bridge_ws_error', { error: ev?.message ?? ev?.error?.message ?? 'error' });
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      welcomed = false;
      clearTimeout(silenceTimer);
      const code = ev?.code ?? 0;
      // 4001 — мост отозван, 4003 — токен не принят: повторять редко, ждать нового токена.
      if (code === 4001 || code === 4003) delay = config.reconnectMaxMs;
      L.warn('bridge_disconnected', { code, reason: String(ev?.reason ?? '').slice(0, 60) });
      scheduleReconnect();
    };
  }

  function onMessage(msg) {
    switch (msg?.type) {
      case 'welcome':
        welcomed = true;
        delay = config.reconnectMinMs;
        if (Number.isInteger(msg.ping_ms) && msg.ping_ms >= 1000 && msg.ping_ms <= 120_000) pingMs = msg.ping_ms;
        armSilence();
        L.info('bridge_welcome', { bridge_id: msg.bridge_id, club_id: msg.club_id });
        // Результаты, которые сервер не подтвердил до обрыва.
        for (const r of book.pendingResults()) send(r);
        send({ type: 'status', kkt });
        checkStatus();
        break;
      case 'job':
        onJob(msg);
        break;
      case 'ack':
        if (typeof msg.uuid === 'string') book.ackResult(msg.uuid);
        break;
      case 'ping':
        send({ type: 'pong', t: msg.t ?? null });
        break;
      default:
        break;
    }
  }

  function onJob(msg) {
    if (!JOB_KINDS.has(msg.kind) || typeof msg.uuid !== 'string' || !UUID_LIKE.test(msg.uuid) || !Array.isArray(msg.request) || msg.request.length === 0) {
      L.warn('bridge_bad_job', { kind: msg?.kind ?? null });
      return;
    }
    // Тот же UUID уже в работе или в очереди — результат придёт один раз.
    if (current?.uuid === msg.uuid || queue.some((j) => j.uuid === msg.uuid)) return;
    queue.push({ job_id: msg.job_id ?? null, kind: msg.kind, uuid: msg.uuid, request: msg.request });
    counters.jobs += 1;
    pump();
  }

  function pump() {
    if (pumping || stopping) return;
    pumping = (async () => {
      while (queue.length > 0 && !stopping) {
        current = queue.shift();
        let result;
        try {
          result = await processJob(current);
        } catch (err) {
          L.error('bridge_job_crashed', { uuid: current.uuid, error: err.message });
          result = { outcome: 'in_progress', task_created: book.wasPosted(current.uuid), error: { code: 'bridge_error', category: 'unknown' } };
        }
        // Ответ задания — свежее состояние ККТ: опрос состояния сообщит, когда связь вернётся.
        if (result.outcome === 'error' && result.error?.category === 'connection') kkt = { ...kkt, online: false, reason: result.error.code === 'atol_unreachable' ? 'atol_unreachable' : 'kkt_offline' };
        else if (result.outcome === 'done' || result.outcome === 'skipped') kkt = { ...kkt, online: true, reason: kkt.reason === 'paper' ? 'paper' : null };
        const message = { type: 'result', job_id: current.job_id, uuid: current.uuid, kind: current.kind, ...result };
        counters.results += 1;
        if (result.outcome !== 'in_progress') book.keepResult(current.uuid, message);
        L.info('bridge_job_result', { uuid: current.uuid, kind: current.kind, outcome: result.outcome, code: result.error?.code ?? null, fd: result.fiscal?.fd ?? null });
        send(message);
        current = null;
      }
    })().finally(() => {
      pumping = null;
    });
  }

  async function safeGet(uuid) {
    try {
      return await atolClient.getRequest(uuid);
    } catch (err) {
      if (err instanceof AtolUnreachable) return { found: false, unreachable: true };
      throw err;
    }
  }

  async function shiftState() {
    try {
      return await atolClient.shiftStatus({ pollMs: config.pollMs, sleep: wait });
    } catch {
      return null;
    }
  }

  /** Обработать задание: сначала статус UUID в АТОЛ, затем (если задания нет) поставить и ждать. */
  async function processJob(job) {
    const { uuid } = job;
    let got = await safeGet(uuid);
    if (got.unreachable || got.error) {
      // АТОЛ не ответил: если задание уже отправляли — исход неизвестен, повторит сервер.
      const posted = book.wasPosted(uuid);
      return { outcome: posted ? 'in_progress' : 'error', task_created: posted, error: { code: 'atol_unreachable', category: 'connection', description: 'веб-сервер АТОЛ недоступен' } };
    }
    if (!got.found) {
      if (book.wasPosted(uuid)) {
        // Мост уже ставил это задание, а АТОЛ его не знает: второй чек хуже проверки руками.
        return { outcome: 'unknown', task_created: true, error: { code: 'atol_task_lost', category: 'unknown', description: 'АТОЛ не знает отправленное задание' } };
      }
      book.markPosted(uuid);
      counters.posted += 1;
      let added;
      try {
        added = await atolClient.addRequest(uuid, job.request);
      } catch (err) {
        if (!(err instanceof AtolUnreachable)) throw err;
        // Не знаем, принял ли АТОЛ задание: спросить позже, не ставить заново.
        return { outcome: 'in_progress', task_created: true, error: { code: 'atol_unreachable', category: 'connection', description: 'обрыв при постановке' } };
      }
      if (!added.ok) {
        if (added.kind === 'conflict') {
          got = await safeGet(uuid);
          if (got.found) {
            // Задание с этим UUID уже есть (гонка): ждать его результата.
          } else {
            book.forget(uuid);
            return { outcome: 'error', task_created: false, error: { code: 'kkt_offline', category: 'connection', description: String(added.description).slice(0, 200) } };
          }
        } else {
          book.forget(uuid);
          const invalid = added.kind === 'bad_request';
          return {
            outcome: 'error',
            task_created: false,
            error: { code: invalid ? 'atol_bad_request' : added.kind === 'unauthorized' ? 'atol_unauthorized' : 'atol_rejected', category: invalid ? 'invalid' : 'connection', description: String(added.description).slice(0, 200) },
          };
        }
      }
    }

    const deadline = Date.now() + config.jobTimeoutMs;
    let blocked = null;
    for (;;) {
      got = await safeGet(uuid);
      if (!got.found && !got.unreachable && !got.error) {
        // Задание только что было в АТОЛ, а теперь его нет: второй раз не ставить.
        return { outcome: 'unknown', task_created: true, error: { code: 'atol_task_lost', category: 'unknown', description: 'АТОЛ не знает отправленное задание' } };
      }
      if (got.found) {
        if (isFinal(got.results)) return interpret(job, got.results);
        const b = got.results.find((r) => r.status === 'blocked');
        if (b && blocked !== b.code) {
          blocked = b.code;
          const category = categoryOf(b.code);
          kkt = { ...kkt, blocked: true, reason: category === 'paper' ? 'paper' : 'blocked' };
          send({ type: 'status', kkt });
        }
      }
      if (Date.now() >= deadline) {
        return { outcome: 'in_progress', task_created: true, ...(blocked !== null ? { error: { code: `atol_${blocked}`, category: categoryOf(blocked) } } : {}) };
      }
      await wait(config.pollMs);
    }
  }

  async function interpret(job, results) {
    const failed = results.find((r) => r.status !== 'ready');
    if (!failed) {
      const last = results[results.length - 1];
      const fiscal = parseFiscal(last.result);
      if (kkt.blocked) {
        kkt = { ...kkt, blocked: false, reason: null };
        send({ type: 'status', kkt });
      }
      if (!fiscal) return { outcome: 'unknown', task_created: true, error: { code: 'no_fiscal_params', category: 'unknown' } };
      return { outcome: 'done', task_created: true, fiscal };
    }
    const code = failed.code;
    const category = categoryOf(code);
    const error = { code: `atol_${code}`, atol_code: code, description: String(failed.description ?? '').slice(0, 200), category };
    if (job.kind === 'open_shift' || job.kind === 'close_shift') {
      const s = await shiftState();
      if (job.kind === 'open_shift' && s?.state === 'opened') return { outcome: 'skipped', task_created: true, shift: s };
      if (job.kind === 'close_shift' && s?.state === 'closed') return { outcome: 'skipped', task_created: true, shift: s };
    } else if (category === 'unknown') {
      const s = await shiftState();
      if (s?.state === 'expired') error.category = 'shift_expired';
    }
    return { outcome: 'error', task_created: true, error };
  }

  async function checkStatus() {
    if (!statusSupported) return;
    let next;
    try {
      const r = await atolClient.operation('queryDeviceStatus');
      if (r.ok) {
        const d = r.json?.deviceStatus ?? {};
        next = { online: true, reason: d.paperPresent === false ? 'paper' : d.coverOpened ? 'cover' : null, paper: d.paperPresent !== false };
      } else if (r.unsupported) {
        statusSupported = false;
        next = { online: null, reason: 'status_unsupported' };
      } else {
        next = { online: false, reason: 'kkt_offline' };
      }
    } catch (err) {
      if (!(err instanceof AtolUnreachable)) throw err;
      next = { online: false, reason: 'atol_unreachable' };
    }
    next.blocked = Boolean(kkt.blocked);
    const changed = next.online !== kkt.online || next.reason !== kkt.reason;
    kkt = next;
    if (changed) {
      L.info('bridge_kkt_status', { online: kkt.online, reason: kkt.reason });
      if (welcomed) send({ type: 'status', kkt });
    }
  }

  function statusLoop() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(async () => {
      try {
        await checkStatus();
      } catch (err) {
        L.warn('bridge_status_failed', { error: err.message });
      }
      if (!stopping) statusLoop();
    }, config.statusPollMs);
    // Опрос ККТ тоже держит процесс, пока мост запущен (stop() снимает таймер).
  }

  return {
    start() {
      stopping = false;
      connect();
      statusLoop();
    },
    async stop() {
      stopping = true;
      clearTimeout(reconnectTimer);
      clearTimeout(silenceTimer);
      clearTimeout(statusTimer);
      reconnectTimer = null;
      try {
        ws?.close(1000, 'stop');
      } catch {
        /* уже закрыт */
      }
      ws = null;
      await pumping;
    },
    /** Для тестов и наблюдения. */
    get state() {
      return { connected: Boolean(ws && ws.readyState === 1), welcomed, queue: queue.length, current: current?.uuid ?? null, kkt, counters: { ...counters } };
    },
    /** Разорвать соединение (тесты обрыва). */
    dropConnection() {
      try {
        ws?.close(4000, 'drop');
      } catch {
        /* уже закрыт */
      }
    },
    checkStatus,
  };
}
