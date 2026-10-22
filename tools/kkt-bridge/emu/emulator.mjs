// Эмулятор веб-сервера драйвера ККТ АТОЛ (ДТО 10, «АТОЛ. Web Requests») для разработки и тестов.
//
// HTTP JSON, по умолчанию порт 16732, как у настоящего веб-сервера. Подмножество API:
//   POST   /api/v2/requests            { uuid, request: [задачи] } → 201 { number, uuid, isBlocked, blockedUUID, blockReason }
//                                      повтор uuid — 409; ККТ выключена (offlineMode reject) — 409
//   GET    /api/v2/requests/{uuid}     → { results: [{ error: { code, description }, status, result? }] }; нет — 404
//   DELETE /api/v2/requests/{uuid}     отменить ждущее задание (иначе 409)
//   GET    /api/v2/getRequestsQueueStatus, GET /api/v2/serverInfo
//   POST   /api/v2/operations/queryDeviceStatus | queryShiftStatus | queryFnStatus — без очереди
//   /requests, /requests/{uuid}         то же в старом формате веб-сервера ДТО 10 (errorCode, errorDescription)
// Задачи: sell, sellReturn, openShift, closeShift, getShiftStatus, getDeviceStatus, getFnStatus,
// continuePrint, reportX. Задачи задания выполняются по порядку; после ошибки остальные — interrupted (502).
//
// Состояние ККТ и сбои — /__emu/* (только для тестов; X-Emu-Token, если задан controlToken):
//   GET  /__emu/state, GET /__emu/documents, POST /__emu/reset
//   POST /__emu/power { on, mode?: reject|error|wait }   выключенная ККТ: отказ в приёме задания,
//                                                         ошибка «Нет связи» или ожидание в очереди
//   POST /__emu/paper { present, mode?: error|block }     нет бумаги: ошибка до документа или документ
//                                                         без печати и очередь стоит, пока бумагу не вставят
//   POST /__emu/fn { error: код | null }                  ошибка ФН на фискальных задачах
//   POST /__emu/delay { ms }                              задержка каждой фискальной задачи
//   POST /__emu/fault { kind: 'lose_after_fiscal', times } документ закрылся в ФН, связь оборвалась:
//                                                         задача blocked, затем ready только с номером ФД
//   POST /__emu/shift { expired: true }                   смена ККТ старше 24 часов
// Выдаёт номер ФД (сквозной), ФП (10 цифр, HMAC от ФН и ФД), номер чека в смене и номер смены.

import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import { CODES, describe, OPEN_STATUSES } from '../lib/codes.mjs';

export const DEFAULT_PORT = 16732;
const MAX_BODY = 1024 * 1024;

export const TAXATION_TYPES = ['osn', 'usnIncome', 'usnIncomeOutcome', 'envd', 'esn', 'patent'];
export const VAT_TYPES = ['none', 'vat0', 'vat10', 'vat20', 'vat22', 'vat110', 'vat120', 'vat122', 'vat5', 'vat7', 'vat105', 'vat107'];
export const PAYMENT_METHODS = ['fullPrepayment', 'prepayment', 'advance', 'fullPayment', 'partialPayment', 'credit', 'creditPayment'];
export const PAYMENT_OBJECTS = [
  'commodity', 'excise', 'job', 'service', 'gamblingBet', 'gamblingPrize', 'lottery', 'lotteryPrize',
  'intellectualActivity', 'payment', 'agentCommission', 'composite', 'another',
];
export const PAYMENT_TYPES = ['cash', 'electronically', 'prepaid', 'credit', 'other'];
const FISCAL = new Set(['sell', 'sellReturn', 'openShift', 'closeShift']);
const KNOWN = new Set([...FISCAL, 'getShiftStatus', 'getDeviceStatus', 'getFnStatus', 'continuePrint', 'reportX']);

class TaskError extends Error {
  constructor(code, description) {
    super(description ?? describe(code));
    this.code = code;
  }
}

class HttpFail extends Error {
  constructor(status, description) {
    super(description);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kop = (rub) => Math.round(Number(rub) * 100);

/** Время ККТ: ISO 8601 со смещением, как в fiscalDocumentDateTime («2026-10-22T15:25:00+00:00»). */
function kktDateTime(d) {
  return `${d.toISOString().slice(0, 19)}+00:00`;
}

/**
 * @param {{ clock?: { now(): Date }, log?: { info: Function, warn: Function } | null,
 *           fnNumber?: string, registrationNumber?: string, autoOpenShift?: boolean,
 *           shiftHours?: number, controlToken?: string|null, basicAuth?: { user: string, password: string } | null,
 *           recoverMs?: number }} [options]
 */
export function createAtolEmulator({
  clock = { now: () => new Date() },
  log = null,
  fnNumber = '9999078900012345',
  registrationNumber = '0000000001012345',
  autoOpenShift = true,
  shiftHours = 24,
  controlToken = null,
  basicAuth = null,
  recoverMs = 300,
} = {}) {
  const fpKey = randomBytes(32);
  let st;

  function reset() {
    st = {
      power: true,
      offlineMode: 'error',
      paper: true,
      paperMode: 'error',
      fnError: null,
      delayMs: 0,
      faults: [],
      fd: 0,
      shift: { state: 'closed', number: 0, openedAt: null, receipts: 0, docs: 0 },
      documents: [],
      requests: new Map(),
      waiting: [],
      number: 0,
      block: null,
      busy: false,
      stats: { posts: 0, gets: 0, deletes: 0, operations: 0 },
    };
  }
  reset();

  const fpOf = (fd) => String(createHmac('sha256', fpKey).update(`${fnNumber}:${fd}`).digest().readUInt32BE(0)).padStart(10, '0');

  function shiftExpired() {
    return st.shift.state === 'opened' && clock.now().getTime() - st.shift.openedAt.getTime() > shiftHours * 3600_000;
  }

  function shiftStatus() {
    const state = st.shift.state === 'closed' ? 'closed' : shiftExpired() ? 'expired' : 'opened';
    return {
      state,
      number: st.shift.number,
      documentsCount: st.shift.docs,
      expiredTime: st.shift.openedAt ? kktDateTime(new Date(st.shift.openedAt.getTime() + shiftHours * 3600_000)) : null,
    };
  }

  function deviceStatus() {
    return {
      blocked: false,
      coverOpened: false,
      paperPresent: st.paper,
      fiscal: true,
      fnFiscal: true,
      fnPresent: true,
      cashDrawerOpened: false,
      currentDateTime: kktDateTime(clock.now()),
      shift: st.shift.state === 'closed' ? 'closed' : shiftExpired() ? 'expired' : 'opened',
    };
  }

  function fiscalBase(fd, at) {
    return {
      fiscalDocumentDateTime: kktDateTime(at),
      fiscalDocumentNumber: fd,
      fiscalDocumentSign: fpOf(fd),
      fnNumber,
      registrationNumber,
      shiftNumber: st.shift.number,
      fnsUrl: 'www.nalog.gov.ru',
    };
  }

  function newDocument(kind, extra = {}) {
    st.fd += 1;
    st.shift.docs += 1;
    const at = clock.now();
    const doc = { fd: st.fd, fp: fpOf(st.fd), kind, at: at.toISOString(), shift_number: st.shift.number, printed: st.paper, ...extra };
    st.documents.push(doc);
    return { doc, at };
  }

  function openShiftDoc(operator) {
    st.shift = { state: 'opened', number: st.shift.number + 1, openedAt: clock.now(), receipts: 0, docs: 0 };
    return newDocument('openShift', { operator });
  }

  function validateReceipt(task) {
    const fail = (why) => {
      throw new TaskError(CODES.INVALID_PARAM, `Неверный параметр: ${why}`);
    };
    if (task.taxationType !== undefined && !TAXATION_TYPES.includes(task.taxationType)) fail('taxationType');
    if (!task.operator || typeof task.operator.name !== 'string' || task.operator.name.trim() === '' || task.operator.name.length > 64) fail('operator.name');
    if (!Array.isArray(task.items) || task.items.length === 0 || task.items.length > 100) fail('items');
    let total = 0;
    for (const [i, it] of task.items.entries()) {
      if (it.type !== undefined && it.type !== 'position') fail(`items[${i}].type`);
      if (typeof it.name !== 'string' || it.name.length < 1 || it.name.length > 128) fail(`items[${i}].name`);
      if (typeof it.price !== 'number' || !(it.price >= 0)) fail(`items[${i}].price`);
      if (typeof it.quantity !== 'number' || !(it.quantity > 0)) fail(`items[${i}].quantity`);
      if (typeof it.amount !== 'number' || !(it.amount >= 0)) fail(`items[${i}].amount`);
      if (Math.abs(kop(it.price) * it.quantity - kop(it.amount)) > 1) fail(`items[${i}].amount != price * quantity`);
      if (!it.tax || !VAT_TYPES.includes(it.tax.type)) fail(`items[${i}].tax.type`);
      if (!PAYMENT_METHODS.includes(it.paymentMethod)) fail(`items[${i}].paymentMethod`);
      if (!PAYMENT_OBJECTS.includes(it.paymentObject)) fail(`items[${i}].paymentObject`);
      total += kop(it.amount);
    }
    if (typeof task.total === 'number' && kop(task.total) !== total) fail('total != сумма позиций');
    if (!Array.isArray(task.payments) || task.payments.length === 0) fail('payments');
    let paid = 0;
    let nonCash = 0;
    for (const [i, p] of task.payments.entries()) {
      if (!PAYMENT_TYPES.includes(p.type)) fail(`payments[${i}].type`);
      if (typeof p.sum !== 'number' || !(p.sum > 0)) fail(`payments[${i}].sum`);
      paid += kop(p.sum);
      if (p.type !== 'cash') nonCash += kop(p.sum);
    }
    if (paid < total) fail('оплат меньше суммы чека');
    if (nonCash > total) fail('безналичных больше суммы чека');
    return { total, paid };
  }

  /** Выполнить одну задачу. Возвращает { result } или { result, block } ; ошибка — TaskError. */
  async function execute(task) {
    const type = task?.type;
    if (!KNOWN.has(type)) throw new TaskError(CODES.INVALID_PARAM, `Неизвестный тип задания: ${type}`);
    if (!st.power) throw new TaskError(CODES.NO_CONNECTION);
    if (type === 'getShiftStatus') return { result: { shiftStatus: shiftStatus() } };
    if (type === 'getDeviceStatus') return { result: { deviceStatus: deviceStatus() } };
    if (type === 'getFnStatus') return { result: { fnStatus: { fiscalDocumentNumber: st.fd, fnNumber, warnings: {} } } };
    if (type === 'continuePrint') {
      if (!st.paper) throw new TaskError(CODES.NO_PAPER);
      return { result: {} };
    }
    if (type === 'reportX') {
      if (!st.paper) throw new TaskError(CODES.NO_PAPER);
      return { result: {} };
    }

    // Фискальные задачи.
    if (st.delayMs > 0) await sleep(st.delayMs);
    if (!st.power) throw new TaskError(CODES.NO_CONNECTION);
    if (st.fnError) throw new TaskError(st.fnError);
    if (!st.paper && st.paperMode === 'error') throw new TaskError(CODES.NO_PAPER);
    const operator = task.operator?.name ?? null;

    let made;
    let result;
    if (type === 'openShift') {
      if (st.shift.state === 'opened') throw new TaskError(CODES.DENIED_IN_OPENED_SHIFT);
      made = openShiftDoc(operator);
      result = { fiscalParams: fiscalBase(made.doc.fd, made.at), warnings: null };
    } else if (type === 'closeShift') {
      if (st.shift.state !== 'opened') throw new TaskError(CODES.DENIED_IN_CLOSED_SHIFT);
      made = newDocument('closeShift', { operator });
      result = { fiscalParams: fiscalBase(made.doc.fd, made.at), warnings: null };
      st.shift = { ...st.shift, state: 'closed', openedAt: null };
    } else {
      const { total } = validateReceipt(task);
      if (shiftExpired()) throw new TaskError(CODES.SHIFT_EXPIRED);
      if (st.shift.state === 'closed') {
        if (!autoOpenShift) throw new TaskError(CODES.DENIED_IN_CLOSED_SHIFT);
        openShiftDoc(operator);
      }
      st.shift.receipts += 1;
      made = newDocument(type, {
        uuid: task.__uuid ?? null,
        total_kopecks: total,
        payments: task.payments.map((p) => ({ type: p.type, sum_kopecks: kop(p.sum) })),
        items: task.items.map((it) => ({ name: it.name, price_kopecks: kop(it.price), quantity: it.quantity, amount_kopecks: kop(it.amount), tax: it.tax.type, payment_object: it.paymentObject, payment_method: it.paymentMethod })),
        taxation_type: task.taxationType ?? null,
        operator,
        receipt_number: st.shift.receipts,
      });
      result = {
        fiscalParams: { ...fiscalBase(made.doc.fd, made.at), fiscalReceiptNumber: st.shift.receipts, total: total / 100 },
        warnings: null,
      };
    }

    const fault = st.faults.find((f) => f.remaining > 0);
    if (fault && fault.kind === 'lose_after_fiscal') {
      fault.remaining -= 1;
      // Документ закрыт в ФН, ответ потерян: после восстановления известен только номер ФД.
      return { result: { fiscalParams: { fiscalDocumentNumber: made.doc.fd }, warnings: { notPrinted: true } }, block: 'connectionError', lost: true };
    }
    if (!st.paper && st.paperMode === 'block') {
      result.warnings = { notPrinted: true };
      return { result, block: 'paperError' };
    }
    return { result };
  }

  function blockInfo() {
    if (!st.block) return { isBlocked: false, blockedUUID: '', blockReason: '' };
    return { isBlocked: true, blockedUUID: st.block.uuid, blockReason: st.block.reason };
  }

  function finish(req, from) {
    for (let i = from; i < req.tasks.length; i += 1) {
      req.results[i] = { code: CODES.INTERRUPTED, status: 'interrupted' };
    }
    req.state = 'done';
    req.doneAt = clock.now().getTime();
  }

  async function run(req) {
    req.state = 'inProgress';
    for (let i = req.next; i < req.tasks.length; i += 1) {
      req.results[i] = { code: 0, status: 'inProgress' };
      try {
        const out = await execute({ ...req.tasks[i], __uuid: req.uuid });
        if (out.block) {
          req.results[i] = out.lost ? { code: CODES.CONNECTION_LOST, status: 'blocked' } : { code: 0, status: 'ready', result: out.result };
          st.block = { uuid: req.uuid, reason: out.block, task: i, pending: out.lost ? out.result : null };
          req.state = 'blocked';
          req.next = i + 1;
          scheduleRecover();
          return;
        }
        req.results[i] = { code: 0, status: 'ready', result: out.result };
      } catch (err) {
        const code = err instanceof TaskError ? err.code : CODES.INCORRECT_DATA;
        req.results[i] = { code, description: err.message, status: 'error' };
        finish(req, i + 1);
        return;
      }
    }
    finish(req, req.tasks.length);
  }

  let recoverTimer = null;
  function scheduleRecover() {
    clearTimeout(recoverTimer);
    recoverTimer = setTimeout(recover, recoverMs);
    recoverTimer.unref?.();
  }

  function recover() {
    recoverTimer = null;
    const b = st.block;
    if (!b) return;
    if (!st.power || (b.reason === 'paperError' && !st.paper)) {
      scheduleRecover();
      return;
    }
    const req = st.requests.get(b.uuid);
    if (b.pending) req.results[b.task] = { code: 0, status: 'ready', result: b.pending };
    else if (req.results[b.task]?.result?.warnings) req.results[b.task].result.warnings.notPrinted = false;
    st.block = null;
    if (req.next >= req.tasks.length) finish(req, req.tasks.length);
    else {
      req.state = 'wait';
      st.waiting.unshift(req.uuid);
    }
    log?.info?.('atol_emu_recovered', { uuid: b.uuid, reason: b.reason });
    pump();
  }

  function pump() {
    if (st.busy || st.block || st.waiting.length === 0) return;
    if (!st.power && st.offlineMode === 'wait') return;
    st.busy = true;
    const uuid = st.waiting.shift();
    const req = st.requests.get(uuid);
    run(req)
      .catch((err) => log?.warn?.('atol_emu_run_failed', { error: err.message }))
      .finally(() => {
        st.busy = false;
        setImmediate(pump);
      });
  }

  function addRequest(body) {
    if (!body || typeof body !== 'object') throw new HttpFail(400, 'Неверный JSON');
    const { uuid, request } = body;
    if (typeof uuid !== 'string' || uuid.length < 1 || uuid.length > 64) throw new HttpFail(400, "Поле 'uuid' не задано");
    const tasks = Array.isArray(request) ? request : request && typeof request === 'object' ? [request] : null;
    if (!tasks || tasks.length === 0 || tasks.length > 20) throw new HttpFail(400, "Поле 'request' не задано или пустое");
    if (st.requests.has(uuid)) throw new HttpFail(409, `Не удалось добавить задание с UUID [${uuid}], задание с таким UUID уже есть`);
    if (!st.power && st.offlineMode === 'reject') throw new HttpFail(409, 'ККТ не подключена: Нет связи');
    st.number += 1;
    st.requests.set(uuid, {
      uuid,
      tasks,
      results: tasks.map(() => ({ code: 0, status: 'wait' })),
      state: 'wait',
      next: 0,
      addedAt: clock.now().getTime(),
    });
    st.waiting.push(uuid);
    setImmediate(pump);
    return { number: st.number, uuid, ...blockInfo() };
  }

  function resultsOf(uuid, legacy) {
    const req = st.requests.get(uuid);
    if (!req) throw new HttpFail(404, `Задание с UUID [${uuid}] не найдено`);
    return {
      results: req.results.map((r) => {
        const description = r.description ?? describe(r.code);
        const base = legacy
          ? { errorCode: r.code, errorDescription: description, status: r.status }
          : { error: { code: r.code, description }, status: r.status };
        if (r.status === 'ready') base.result = r.result ?? null;
        else if (legacy) base.result = null;
        return base;
      }),
    };
  }

  function cancelRequest(uuid) {
    const req = st.requests.get(uuid);
    if (!req) throw new HttpFail(404, `Задание с UUID [${uuid}] не найдено`);
    if (req.state !== 'wait') throw new HttpFail(409, `Задание с UUID [${uuid}] нельзя отменить`);
    st.waiting = st.waiting.filter((u) => u !== uuid);
    req.state = 'canceled';
    req.results = req.tasks.map(() => ({ code: CODES.CANCELED, status: 'canceled' }));
  }

  async function operation(name) {
    st.stats.operations += 1;
    if (!st.power) throw new HttpFail(409, 'ККТ не подключена: Нет связи');
    if (name === 'queryDeviceStatus') return { deviceStatus: deviceStatus() };
    if (name === 'queryShiftStatus') return { shiftStatus: shiftStatus() };
    if (name === 'queryFnStatus') return { fnStatus: { fiscalDocumentNumber: st.fd, fnNumber } };
    throw new HttpFail(501, `Операция ${name} не поддерживается`);
  }

  function publicState() {
    let open = 0;
    for (const r of st.requests.values()) if (r.results.some((x) => OPEN_STATUSES.has(x.status))) open += 1;
    return {
      power: st.power,
      offline_mode: st.offlineMode,
      paper: st.paper,
      paper_mode: st.paperMode,
      fn_error: st.fnError,
      delay_ms: st.delayMs,
      fd: st.fd,
      shift: shiftStatus(),
      documents: st.documents.length,
      receipts: st.documents.filter((d) => d.kind === 'sell' || d.kind === 'sellReturn').length,
      requests: st.requests.size,
      open_requests: open,
      queue: { waiting: st.waiting.length, ...blockInfo() },
      stats: { ...st.stats },
    };
  }

  const control = {
    power(on, mode) {
      st.power = Boolean(on);
      if (mode !== undefined) {
        if (!['reject', 'error', 'wait'].includes(mode)) throw new HttpFail(400, 'mode: reject | error | wait');
        st.offlineMode = mode;
      }
      if (st.power) setImmediate(pump);
    },
    paper(present, mode) {
      st.paper = Boolean(present);
      if (mode !== undefined) {
        if (!['error', 'block'].includes(mode)) throw new HttpFail(400, 'mode: error | block');
        st.paperMode = mode;
      }
    },
    fn(error) {
      if (error !== null && !Number.isInteger(error)) throw new HttpFail(400, 'error: код или null');
      st.fnError = error;
    },
    delay(ms) {
      if (!Number.isInteger(ms) || ms < 0 || ms > 120_000) throw new HttpFail(400, 'ms: 0..120000');
      st.delayMs = ms;
    },
    fault(kind, times = 1) {
      if (kind !== 'lose_after_fiscal') throw new HttpFail(400, 'kind: lose_after_fiscal');
      st.faults.push({ kind, remaining: Number.isInteger(times) && times > 0 ? times : 1 });
    },
    expireShift() {
      if (st.shift.state !== 'opened') openShiftDoc('Эмулятор');
      st.shift.openedAt = new Date(clock.now().getTime() - (shiftHours + 1) * 3600_000);
    },
    reset,
    state: publicState,
    documents: () => st.documents.map((d) => ({ ...d })),
  };

  function send(res, status, body) {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, text ? { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) } : {});
    res.end(text);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpFail(413, 'Слишком большой запрос'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new HttpFail(400, 'Неверный JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function basicOk(header) {
    if (!basicAuth) return true;
    const expected = `Basic ${Buffer.from(`${basicAuth.user}:${basicAuth.password}`).toString('base64')}`;
    return header === expected;
  }

  async function route(req, res, url) {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;
    if (path.startsWith('/__emu/')) {
      if (controlToken && req.headers['x-emu-token'] !== controlToken) throw new HttpFail(401, 'unauthorized');
      const body = m === 'POST' ? await readJson(req) : {};
      if (path === '/__emu/state' && m === 'GET') return send(res, 200, publicState());
      if (path === '/__emu/documents' && m === 'GET') return send(res, 200, control.documents());
      if (path === '/__emu/reset' && m === 'POST') {
        reset();
        return send(res, 200, publicState());
      }
      if (path === '/__emu/power' && m === 'POST') control.power(body.on, body.mode);
      else if (path === '/__emu/paper' && m === 'POST') control.paper(body.present, body.mode);
      else if (path === '/__emu/fn' && m === 'POST') control.fn(body.error ?? null);
      else if (path === '/__emu/delay' && m === 'POST') control.delay(body.ms);
      else if (path === '/__emu/fault' && m === 'POST') control.fault(body.kind, body.times);
      else if (path === '/__emu/shift' && m === 'POST' && body.expired === true) control.expireShift();
      else throw new HttpFail(404, `Нет такого метода: ${m} ${path}`);
      return send(res, 200, publicState());
    }

    if (!basicOk(req.headers.authorization)) {
      res.setHeader('www-authenticate', 'Basic realm="atol-emu"');
      throw new HttpFail(401, 'unauthorized');
    }
    const legacy = path === '/requests' || path.startsWith('/requests/');
    const p = legacy ? `/api/v2${path}` : path;
    if (p === '/api/v2/serverInfo' && m === 'GET') {
      return send(res, 200, { serverVersion: 'atol-emu-1.0', driverVersion: '10.10.8.0', os: 'linux', currentDateTime: kktDateTime(clock.now()) });
    }
    if (p === '/api/v2/requests' && m === 'POST') {
      st.stats.posts += 1;
      return send(res, 201, addRequest(await readJson(req)));
    }
    const one = /^\/api\/v2\/requests\/([^/]+)$/.exec(p);
    if (one) {
      const uuid = decodeURIComponent(one[1]);
      if (m === 'GET') {
        st.stats.gets += 1;
        return send(res, 200, resultsOf(uuid, legacy));
      }
      if (m === 'DELETE') {
        st.stats.deletes += 1;
        cancelRequest(uuid);
        return send(res, 200, {});
      }
    }
    if (p === '/api/v2/getRequestsQueueStatus' && m === 'GET') {
      return send(res, 200, { number: st.waiting.length + (st.block ? 1 : 0), ...blockInfo() });
    }
    const op = /^\/api\/v2\/operations\/([A-Za-z]+)$/.exec(p);
    if (op && m === 'POST') {
      await readJson(req);
      return send(res, 200, await operation(op[1]));
    }
    throw new HttpFail(404, `Нет такого метода: ${m} ${url.pathname}`);
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://atol-emu');
    } catch {
      send(res, 400, { error: { code: 505, description: 'bad url' } });
      return;
    }
    route(req, res, url).catch((err) => {
      const status = err instanceof HttpFail ? err.status : 500;
      if (!(err instanceof HttpFail)) log?.warn?.('atol_emu_error', { error: err.message });
      if (!res.headersSent) send(res, status, { error: { code: 505, description: err.message } });
    });
  });

  let address = null;
  return {
    server,
    control,
    async listen(port = DEFAULT_PORT, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      address = server.address();
      return address;
    },
    get url() {
      return address ? `http://127.0.0.1:${address.port}` : null;
    },
    async close() {
      clearTimeout(recoverTimer);
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await closed;
    },
  };
}
