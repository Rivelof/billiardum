// Клиент ЮKassa API v3 (контракт M1 §5; decisions №23).
//
// * Basic shopId:secretKey — ключи магазина клуба (секрет расшифровывается из базы
//   server/lib/secrets.mjs только на время запроса и в лог не попадает).
// * Idempotence-Key на каждый POST: повтор с тем же ключом даёт тот же результат,
//   поэтому сетевой сбой безопасно повторять тем же ключом.
// * Таймаут на запрос; 5xx, 429, 202 и сетевые ошибки — retryable (повторить позже тем же ключом).
// Поля объектов — docs ЮKassa (сверка с настоящим магазином — когда откроется доступ к
// api.yookassa.ru; до этого проверено на эмуляторе tools/yookassa-emu/).

export class YooKassaError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, parameter?: string, retryable?: boolean }} info
   */
  constructor(message, { status = 0, code = 'network', parameter, retryable = false } = {}) {
    super(message);
    this.name = 'YooKassaError';
    this.status = status;
    this.code = code;
    this.parameter = parameter;
    this.retryable = retryable;
  }
}

const ID = /^[0-9A-Za-z_-]{1,64}$/;

/**
 * @param {{ apiUrl: string, shopId: string, secretKey: string, timeoutMs?: number, fetch?: typeof fetch }} opts
 */
export function createYooKassaClient({ apiUrl, shopId, secretKey, timeoutMs = 10_000, fetch: doFetch = globalThis.fetch }) {
  if (!apiUrl || !shopId || !secretKey) throw new YooKassaError('нет настроек магазина ЮKassa', { code: 'not_configured' });
  const base = apiUrl.replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(`${shopId}:${secretKey}`, 'utf8').toString('base64')}`;

  async function request(method, path, { body, idempotenceKey } = {}) {
    const headers = { authorization, accept: 'application/json' };
    if (method === 'POST') {
      if (typeof idempotenceKey !== 'string' || idempotenceKey.length < 1 || idempotenceKey.length > 64) {
        throw new YooKassaError('нужен Idempotence-Key до 64 символов', { code: 'bad_idempotence_key' });
      }
      headers['idempotence-key'] = idempotenceKey;
      headers['content-type'] = 'application/json';
    }
    let res;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new YooKassaError(timeout ? 'таймаут ЮKassa' : 'ЮKassa недоступна', { code: timeout ? 'timeout' : 'network', retryable: true });
    }
    let json;
    const text = await res.text().catch(() => '');
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status === 200 && json && typeof json === 'object') return json;
    // 202 — запрос ещё обрабатывается: повторить тем же ключом позже.
    const retryable = res.status === 202 || res.status === 429 || res.status >= 500;
    const code = typeof json?.code === 'string' ? json.code : `http_${res.status}`;
    throw new YooKassaError(`ЮKassa ответила ${res.status} ${code}`, {
      status: res.status,
      code,
      parameter: typeof json?.parameter === 'string' ? json.parameter : undefined,
      retryable,
    });
  }

  const checkId = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new YooKassaError('неверный id объекта ЮKassa', { code: 'bad_id' });
    return id;
  };

  return {
    createPayment: async (body, idempotenceKey) => request('POST', '/payments', { body, idempotenceKey }),
    getPayment: async (id) => request('GET', `/payments/${checkId(id)}`),
    capturePayment: async (id, body, idempotenceKey) => request('POST', `/payments/${checkId(id)}/capture`, { body, idempotenceKey }),
    cancelPayment: async (id, idempotenceKey) => request('POST', `/payments/${checkId(id)}/cancel`, { body: {}, idempotenceKey }),
    createRefund: async (body, idempotenceKey) => request('POST', '/refunds', { body, idempotenceKey }),
    getRefund: async (id) => request('GET', `/refunds/${checkId(id)}`),
  };
}

// Деньги в формате ЮKassa ---------------------------------------------------------------

/** 160000 копеек → '1600.00'. */
export function formatValue(kopecks) {
  if (!Number.isSafeInteger(kopecks) || kopecks < 0) throw new RangeError('сумма — целые копейки ≥ 0');
  return `${Math.floor(kopecks / 100)}.${String(kopecks % 100).padStart(2, '0')}`;
}

/** '1600.00' (или '1600', '1600.5') → 160000; неверная строка — null. */
export function parseValue(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(value)) return null;
  const [rub, kop = ''] = value.split('.');
  return Number(rub) * 100 + Number(kop.padEnd(2, '0'));
}

/** { value, currency } → копейки, только RUB; иначе null. */
export function amountKopecks(amount) {
  if (!amount || amount.currency !== 'RUB') return null;
  return parseValue(amount.value);
}
