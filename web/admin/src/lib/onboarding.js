import { parseClaimCode, parseDeviceId } from './devices.js';

/**
 * Мастер подключения клуба (M5.1, PRODUCT §16, №152–160): шаги, чек-лист, магазины ЮKassa, QR контроллера,
 * приглашение ссылкой. Чистые функции, без DOM.
 *
 * GET /api/clubs/{club}/onboarding → { mode, steps: [{ id, done }], checklist: { items: [{ id, ok, detail }], ready },
 *   hall, payment_checks: { test, live }, shops, payment_settings, kkt_enabled, webhook_url,
 *   offer: { version, accepted_at, accepted_version }, day_start_local } (server/clubs/README.md).
 * Идентификаторы шагов и пунктов — как у сервера.
 */

export const STEPS = Object.freeze([
  { id: 'club', title: 'Клуб', about: 'Название, город и часовой пояс' },
  { id: 'hall', title: 'План зала', about: 'Столы, номера и расстановка' },
  { id: 'tariffs', title: 'Тарифы', about: 'Цена часа по дням и времени' },
  { id: 'menu', title: 'Меню бара', about: 'Загрузка из Excel или CSV' },
  { id: 'staff', title: 'Персонал', about: 'Приглашение ссылкой' },
  { id: 'payments', title: 'ЮKassa', about: 'Тестовый и боевой магазин' },
  { id: 'devices', title: 'Контроллеры', about: 'Привязка по QR на корпусе' },
  { id: 'stickers', title: 'QR-наклейки', about: 'PDF для печати на столы' },
  { id: 'test', title: 'Тестовый режим', about: 'Проверка как гость' },
  { id: 'go_live', title: 'Запуск', about: 'Чек-лист и боевой режим' },
]);

export const stepIndex = (id) => STEPS.findIndex((s) => s.id === id);
export const stepById = (id) => STEPS.find((s) => s.id === id) ?? null;
export const nextStepOf = (id) => STEPS[stepIndex(id) + 1] ?? null;
export const prevStepOf = (id) => (stepIndex(id) > 0 ? STEPS[stepIndex(id) - 1] : null);

/** Шаги с отметками сервера и прогресс. Шаг, которого сервер не прислал, — не сделан; «Клуб» сделан всегда. */
export function stepsView(onboarding) {
  const done = new Map((onboarding?.steps ?? []).map((s) => [s.id, s.done === true]));
  const steps = STEPS.map((s) => ({ ...s, done: s.id === 'club' ? true : (done.get(s.id) ?? false) }));
  if (onboarding?.mode === 'live') for (const s of steps) if (s.id === 'go_live') s.done = true;
  const count = steps.filter((s) => s.done).length;
  return { steps, done: count, total: steps.length, firstOpen: steps.find((s) => !s.done)?.id ?? 'go_live' };
}

/** Пункты чек-листа (№160): текст и куда идти чинить. */
export const CHECK_ITEMS = Object.freeze({
  tables: { title: 'Хотя бы один стол в работе', step: 'hall' },
  devices: { title: 'У каждого стола в работе — контроллер, и он был на связи за последние 10 минут', step: 'devices' },
  tariffs: { title: 'Тарифы покрывают всю неделю', step: 'tariffs' },
  shop_live: { title: 'Боевой магазин ЮKassa проверен: не тестовый, чеки по 54-ФЗ включены', step: 'payments' },
  kkt: { title: 'Касса ресепшена: мост ККТ был на связи за 10 минут, ККТ фискальная (касса выключена — пункт выполнен)', step: 'payments', stepLabel: 'Касса ресепшена', screen: 'kkt' },
  stickers: { title: 'QR-наклейки напечатаны хотя бы раз', step: 'stickers' },
  offer: { title: 'Принята оферта Бильярдума для клубов', step: 'go_live' },
});
const CHECK_ORDER = ['tables', 'devices', 'tariffs', 'shop_live', 'kkt', 'stickers', 'offer'];

/**
 * Чек-лист для экрана: известные пункты по порядку, неизвестные — в конце.
 * failed — коды из 409 checklist_incomplete: они не выполнены, даже если старый ответ говорил иначе.
 * detail сервера показываем, только если это короткий текст.
 */
export function checklistView(checklist, failed = []) {
  const items = Array.isArray(checklist?.items) ? checklist.items : [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const ids = [...CHECK_ORDER.filter((id) => byId.has(id) || failed.includes(id)), ...items.map((i) => i.id).filter((id) => !CHECK_ORDER.includes(id))];
  for (const id of failed) if (!ids.includes(id)) ids.push(id);
  return ids.map((id) => {
    const it = byId.get(id) ?? { id, ok: false };
    const known = CHECK_ITEMS[id];
    return {
      id,
      ok: it.ok === true && !failed.includes(id),
      title: known?.title ?? `Пункт «${id}»`,
      step: known?.step ?? null,
      stepLabel: known?.stepLabel ?? null,
      screen: known?.screen ?? null,
      detail: typeof it.detail === 'string' && it.detail.length <= 200 ? it.detail : null,
    };
  });
}

/** QR на корпусе контроллера: BLD1:{device_id}:{claim_code} (№159). Иначе null. */
export function parseBld1(text) {
  const s = String(text ?? '').trim();
  const m = /^BLD1:([^:]+):([^:]+)$/i.exec(s);
  if (!m) return null;
  const deviceId = parseDeviceId(m[1]);
  const claim = parseClaimCode(m[2]);
  if (!deviceId || !claim) return null;
  return { qr: `BLD1:${deviceId}:${claim}`, device_id: deviceId, claim_code: claim };
}

/** Адрес вебхука ЮKassa клуба (№154): из ответа сервера, иначе по адресу программы. */
export function webhookUrl(origin, clubId, fromServer) {
  if (typeof fromServer === 'string' && /^https:\/\//.test(fromServer)) return fromServer;
  return `${String(origin ?? '').replace(/\/$/, '')}/api/webhooks/yookassa/${encodeURIComponent(clubId)}`;
}

/**
 * Маска секрета магазина: «последние 4 символа и длина» (№154). Сервер может прислать строку
 * («•••• 9f2c») или объект { last4, length }.
 */
export function secretMaskText(mask) {
  if (!mask) return null;
  if (typeof mask === 'string') return mask;
  if (typeof mask === 'object' && typeof mask.last4 === 'string') {
    const len = Number.isInteger(mask.length) ? `, ${mask.length} знаков` : '';
    return `•••• ${mask.last4}${len}`;
  }
  return null;
}

/**
 * Магазин ЮKassa словами: отметки «проверен», «тестовый», «чеки» — словом и значком, не цветом.
 * settings — ответ GET/PUT …/payment-settings/{mode}: { shop_id, secret_mask, verified_at, test, fiscalization }.
 */
export function shopView(settings, mode) {
  const configured = Boolean(settings?.shop_id);
  const verified = configured && Boolean(settings.verified_at);
  const isTest = settings?.test === true;
  const fiscal = settings?.fiscalization === true;
  const flags = [];
  if (configured) {
    flags.push({ id: 'verified', ok: verified, text: verified ? 'Проверен в ЮKassa' : 'Не проверен' });
    flags.push({ id: 'test', ok: mode === 'test' ? isTest : !isTest, text: isTest ? 'Тестовый магазин' : 'Боевой магазин' });
    flags.push({ id: 'fiscal', ok: mode === 'test' ? true : fiscal, text: fiscal ? 'Чеки по 54-ФЗ включены' : 'Чеки по 54-ФЗ выключены' });
  }
  return { configured, verified, ready: verified && (mode === 'test' ? isTest : !isTest && fiscal), flags, mask: secretMaskText(settings?.secret_mask) };
}

/** Магазин в форме: shop_id — цифры; секрет — test_… или live_… (как в кабинете ЮKassa), без пробелов. */
export function shopErrors(form, { hasSecret = false, live = false } = {}) {
  const errors = {};
  if (!/^\d{3,12}$/.test(String(form.shop_id ?? '').trim())) errors.shop_id = 'Идентификатор магазина — только цифры, как в кабинете ЮKassa.';
  const key = String(form.secret_key ?? '').trim();
  if (!key && !hasSecret) errors.secret_key = 'Вставьте секретный ключ из кабинета ЮKassa.';
  if (key && !/^[A-Za-z0-9_-]{10,200}$/.test(key)) errors.secret_key = 'Ключ — латинские буквы, цифры, «_» и «-», без пробелов.';
  if (live && !String(form.reason ?? '').trim()) errors.reason = 'Клуб в боевом режиме: напишите, почему меняете магазин.';
  return errors;
}

/** Тело PUT …/payment-settings/{mode}: пустой ключ не отправляем (оставить сохранённый). */
export function shopBody(form, { live = false } = {}) {
  const body = { shop_id: String(form.shop_id).trim() };
  const key = String(form.secret_key ?? '').trim();
  if (key) body.secret_key = key;
  if (live) body.reason = String(form.reason ?? '').trim();
  return body;
}

/**
 * Проверочный платёж 1 ₽ (№154): статус из GET …/onboarding → payment_checks[mode] =
 * { payment_id, status: pending | succeeded | canceled, refunded, webhook_at, created_at } (допущение).
 * @returns {{ tone: 'wait' | 'ok' | 'warn' | 'bad', title: string, text: string, polling: boolean } | null}
 */
export function paymentCheckView(check, now = Date.now()) {
  if (!check?.payment_id) return null;
  const age = check.created_at ? now - Date.parse(check.created_at) : 0;
  if (check.status === 'canceled') {
    return { tone: 'bad', title: 'Проверочный платёж не прошёл.', text: 'Проверьте идентификатор магазина и ключ, затем отправьте платёж снова.', polling: false };
  }
  if (check.status !== 'succeeded') {
    return { tone: 'wait', title: 'Ждём ответ ЮKassa…', text: 'Обычно это занимает до минуты. Экран обновится сам.', polling: true };
  }
  if (!check.webhook_at) {
    const late = age > 10 * 60_000;
    return {
      tone: late ? 'bad' : 'warn',
      title: late ? 'Платёж прошёл, но уведомление от ЮKassa не пришло.' : 'Платёж прошёл. Ждём уведомление от ЮKassa…',
      text: late
        ? 'Без уведомления свет не включится после оплаты. Проверьте адрес для уведомлений в кабинете ЮKassa — он выше.'
        : 'Если уведомление не придёт за 10 минут, проверьте адрес для уведомлений в кабинете ЮKassa.',
      polling: !late,
    };
  }
  return {
    tone: 'ok',
    title: check.refunded ? 'Платёж прошёл, уведомление получено, 1 ₽ вернулся.' : 'Платёж прошёл, уведомление получено.',
    text: check.refunded ? 'Магазин подключён правильно.' : 'Возврат 1 ₽ оформляется автоматически.',
    polling: !check.refunded,
  };
}

/** Текст и ссылка приглашения из ответа POST …/staff/invites (№158): { invite_text, invite_url }. */
export function inviteShare(res) {
  const url = typeof res?.invite_url === 'string' && /^https?:\/\//.test(res.invite_url) ? res.invite_url : null;
  const text = typeof res?.invite_text === 'string' && res.invite_text.trim() ? res.invite_text.trim() : null;
  if (!text && !url) return null;
  return { text: text ?? url, url };
}

/** Можно ли поделиться через Web Share (телефон): navigator.share и canShare для текста. */
export function canWebShare(nav = globalThis.navigator, data = { text: 'x' }) {
  if (typeof nav?.share !== 'function') return false;
  try {
    return typeof nav.canShare === 'function' ? nav.canShare(data) : true;
  } catch {
    return false;
  }
}

/** Ссылка «Проверить как гость» — адрес из QR на столе. */
export function guestTableUrl(origin, code) {
  return code ? `${String(origin ?? '').replace(/\/$/, '')}/app/t/${encodeURIComponent(code)}` : null;
}

/** Инструкция электрику (PRODUCT §18, firmware/README): текст, который владелец отправит своему электрику. */
export const ELECTRICIAN_TEXT = [
  'Монтаж контроллера Бильярдума над бильярдным столом',
  '',
  '1. Монтаж в линию 220 В делает только электрик, при отключённом автомате линии света.',
  '2. Контроллер ставится в разрыв линии питания лампы над столом — по одному контроллеру на стол. Автомат и корпус — из комплекта.',
  '3. Свет над столом должен включаться только через контроллер: без перемычек и отдельных выключателей в обход.',
  '4. После монтажа включите питание. Контроллер раздаёт Wi-Fi «Billiardum-…»: подключитесь к нему с телефона, пароль — код привязки с наклейки на корпусе.',
  '5. На открывшейся странице выберите Wi-Fi клуба и введите пароль. Контроллер подключится к серверу сам, свет при этом не включится.',
  '6. Наклейку с QR на корпусе не срывайте: по ней владелец привязывает контроллер к столу в программе.',
].join('\n');

/** Тело заявки «Заказать комплект» (№159): POST /api/leads { kind: 'kit', … } — в форме лида M4. */
export function kitLeadBody(form, { clubId, clubName, city, elapsedMs }) {
  const n = Number(form.count);
  return {
    kind: 'kit',
    club_id: clubId,
    club_name: clubName,
    city: city || 'не указан',
    name: String(form.name ?? '').trim(),
    phone: form.phone,
    tables_count: Number.isInteger(n) ? n : null,
    comment: String(form.comment ?? '').trim() || undefined,
    consent: form.consent === true,
    website: '',
    elapsed_ms: elapsedMs,
  };
}

/** Редакция оферты: '2026-10-23' → «от 23.10.2026»; иначе как есть. */
export function offerVersionText(version) {
  if (typeof version !== 'string' || !version) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version);
  return m ? `от ${m[3]}.${m[2]}.${m[1]}` : version;
}
