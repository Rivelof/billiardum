/** Тревоги владельцу (PRODUCT §8, контракт §6–§7) словами. Неизвестный тип — общий текст, код — мелко. */

import { formatMoney, formatTime, plural } from '@billiardum/shared/format';
import { lateRefundLabel } from '@billiardum/shared/reasons';
import { BASE } from './env.js';

export const LEVEL_WORD = { critical: 'Критично', important: 'Важно', info: 'Для сведения' };
const LEVEL_ORDER = { critical: 0, important: 1, info: 2 };

const TEXT = {
  bypass_detected: ['Свет горит без оплаты', 'Ток в лампе при выключенном реле: свет включили в обход системы. Проверьте стол.'],
  service_light: ['Включён сервисный свет', 'Ручное действие: сотрудник включил свет без игры с причиной. Подробности — в журнале.'],
  cmd_no_ack: ['Стол не отвечает на команды', 'Контроллер на связи, но не подтверждает команды. Проверьте контроллер; если повторится — сообщите в поддержку.'],
  payment_conflict: ['Оплата пришла на занятый стол', 'Деньги гостю возвращаются автоматически. Проверьте журнал.'],
  refund_mismatch: ['Возврат не сходится', 'Возврат в ЮKassa не совпал с запросом. Проверьте журнал.'],
  events_dropped: ['Контроллер потерял часть событий', 'Пока стол был без связи, часть событий не сохранилась. Проверьте журнал за это время.'],
  ota_failed: ['Прошивка не обновилась', 'Контроллер остался на прежней версии и работает. Повторите обновление позже.'],
  device_topic_mismatch: ['Контроллер прислал чужие данные', 'Данные пришли не из своего клуба. Сообщите в поддержку платформы.'],
  device_seq_gap: ['Счётчик команд разошёлся', 'Сервер выровнял счётчик команд стола. Если повторится — проверьте контроллер.'],
  light_without_session: ['Свет горит без игры', 'Контроллер сообщил, что свет включён, а оплаченной игры на столе нет. Проверьте стол.'],
  relay_fault: ['Реле не отвечает', 'Контроллер не может переключить свет. Проверьте контроллер и проводку.'],
  payment_unapplied: ['Оплата не применилась', 'Деньги пришли, а игра не продлилась или не началась. Сервер вернёт деньги — проверьте журнал.'],
  payment_mismatch: ['Оплата не сходится', 'Сумма или статус платежа в ЮKassa не совпали с нашими. Проверьте журнал.'],
  unlimited_overrun: ['Игра без лимита вышла за заморозку', 'Сыграно больше, чем заморожено на карте гостя. Проверьте журнал.'],
  offline_resume_denied: ['Стол не продолжил игру после сбоя', 'Контроллер перезагрузился без связи второй раз и выключил свет.'],
  lamp_fault: ['Лампа не горит во время игры', 'Реле включено, а ток лампы нулевой. Проверьте лампу, гостю может понадобиться другой стол.'],
  device_offline: ['Стол без связи во время игры', 'Контроллер не отвечает больше 2 минут. Игра доиграется по таймеру стола; проверьте питание и Wi-Fi.'],
  offline: ['Стол без связи во время игры', 'Контроллер не отвечает больше 2 минут. Игра доиграется по таймеру стола; проверьте питание и Wi-Fi.'],
  bad_sig: ['Команда с неверной подписью', 'Стол получил команду, подписанную не сервером. Возможна попытка взлома — сообщите в поддержку.'],
  state_mismatch: ['Стол и сервер расходятся', 'Состояние стола не совпало с базой. Сервер выровнял его; если повторится — проверьте контроллер.'],
  replayed_seq: ['Повтор старой команды', 'Стол отклонил повтор старой команды. Если повторяется — сообщите в поддержку.'],
  refund_auto: ['Автоматический возврат', 'Стол оказался занят к моменту оплаты, деньги гостю возвращены.'],
  outbox_failed: ['Сервер не выполнил задачу', 'Задача не прошла после 5 попыток. Сообщите в поддержку.'],
  manual_action: ['Ручное действие персонала', 'Сотрудник выполнил действие с причиной. Подробности — в журнале.'],
  // M2 (контракт m2.md §1, решения №71, №81, №82, №84); коды сверяются с backend-kkt и backend-pos
  shift_discrepancy: ['Расхождение в кассе при закрытии смены', 'Наличных в кассе не столько, сколько должно быть. Отчёт смены — в разделе «Смены».'],
  receipt_stuck: ['Чек не пробит больше 10 минут', 'Касса ККТ не на связи или вернула ошибку. Проверьте ПК ресепшена и кассу: чек пробьётся из очереди.'],
  kkt_offline: ['Касса ККТ не на связи', 'Мост на ПК ресепшена не отвечает. Продажи сохраняются, чеки пробьются позже.'],
  discount_over_limit: ['Скидка больше лимита', 'Управляющий подтвердил скидку выше лимита клуба с причиной. Подробности — в журнале.'],
  service_light_limit: ['Много сервисного света за смену', 'Минут сервисного света больше порога клуба. Разбивка по сотрудникам — в отчёте смены.'],
  // M3 волна B (server/payments/pay.mjs onProviderNotFound): data.action — canceled (ждал оплаты, отменён) или kept (у нас проведён)
  settlement_receipt_failed: ['Чек зачёта предоплаты не принят', 'ЮKassa отклонила чек зачёта. Проверьте данные клуба в ЮKassa и нажмите «Повторить» — причина уйдёт в журнал.'],
  payment_not_found_at_provider: ['Платёж не найден в ЮKassa — отменён', 'ЮKassa не знает этот платёж: деньги с гостя не списаны, у нас он отменён. Подробности — в журнале.'],
  // По ревью денег, света и входа (193d962, b97e2c4, c7e8d87): суммы и детали — в BY_DATA
  refund_canceled: ['ЮKassa отменила возврат', 'Деньги гостю не вернулись — верните их вручную (наличными на кассе или переводом). Подробности — в журнале.'],
  pos_refund_canceled: ['Возврат на кассе отменён ЮKassa', 'Деньги гостю не вернулись — верните их вручную. Чек продажи снова действует. Подробности — в журнале.'],
  cash_refund_awaiting_shift: ['Возврат наличными ждёт смены', 'Смена закрыта — гостю вернут наличные, когда ресепшн откроет смену. Ресепшн получил напоминание.'],
  terminal_locked: ['Терминал заблокирован', 'На терминале много раз ввели неверный PIN. Вход по PIN на нём закрыт — разблокируйте его в разделе «Персонал → Терминалы», если это были свои.'],
  booking_table_unavailable: ['Стол был недоступен гостю по брони', 'Гость пришёл, а стол был занят или без связи. Бронь закрыта, предоплата возвращена полностью.'],
  booking_step_failed: ['Бронь не обрабатывается', 'Сервер несколько раз не смог обработать бронь по расписанию. Проверьте её в разделе «Брони»; если повторится — сообщите в поддержку.'],
  // M4 (№147): свет матча турнира упёрся в предел окна турнира; data { tournament_id, match_id, light_until }
  tournament_match_overdue: ['Матч турнира затянулся', 'Свет на столе дошёл до предела турнира без оплаты и погаснет. Решите с игроками: внесите счёт или договоритесь, как доиграть.'],
  club_timezone_invalid: ['Неверный часовой пояс клуба', 'Тарифы и брони считаются по местному времени, а пояс клуба не распознан. Укажите пояс в настройках клуба или сообщите в поддержку.'],
};

const money = (k) => (Number.isSafeInteger(k) && k > 0 ? formatMoney(k) : null);
/** Строка из data: только короткая строка, иначе null (данные сервера показываем текстом, без разметки). */
const str = (v, max) => (typeof v === 'string' && v.trim() ? (v.trim().length > max ? `${v.trim().slice(0, max - 1)}…` : v.trim()) : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const why = (data) => {
  const r = str(data?.reason, 200);
  return r ? ` Причина: «${r}».` : '';
};

/** Кто сделал: имя сотрудника из data.staff_name (сервер присылает с M4), иначе — «в журнале». */
const who = (data, verb) => {
  const n = str(data?.staff_name, 60);
  return n ? ` ${verb}: ${n}${n.endsWith('.') ? '' : '.'}` : ` Кто ${verb.toLowerCase()} — в журнале.`;
};
const PLAYERS = ['игроку', 'игрокам', 'игрокам'];

/** Ручные действия (manual_action) по data.action: инвариант 8 — что сделано, причина, кто. */
const MANUAL_BY_ACTION = {
  // server/tournaments: before — '2:1', 'спор' или 'без счёта'; after — '3:2'
  'manual.tournament_score': (data) => {
    const before = str(data?.before, 20);
    const after = str(data?.after, 20);
    const change = before && after ? ` Было: ${before}, стало: ${after}.` : after ? ` Новый счёт: ${after}.` : '';
    return ['Счёт матча турнира исправлен', `Сотрудник исправил счёт матча.${change}${why(data)}${who(data, 'Исправил')}`];
  },
  // server/plus: result — 'a' | 'b' (победитель по решению) или 'annul' (не засчитана)
  'plus.match_resolve': (data) => {
    const what = data?.result === 'annul' ? 'Результат партии отменён — в рейтинг она не засчитана.' : 'Победитель партии назначен решением сотрудника.';
    return ['Спор по партии решён', `${what}${why(data)}${who(data, 'Решил')}`];
  },
  // №147: before/after — уже словами по времени клуба: 'до 22:00, матч 60 мин'
  'manual.tournament_extend': (data) => {
    const before = str(data?.before, 60);
    const after = str(data?.after, 60);
    const change = before && after ? ` Было: ${before}; стало: ${after}.` : after ? ` Теперь: ${after}.` : '';
    return ['Турнир продлён', `Время турнира продлено без оплаты.${change}${why(data)}${who(data, 'Продлил')}`];
  },
  // №149: возврат взноса одному игроку после старта; nick — если сервер его пришлёт
  'manual.tournament_refund': (data) => {
    const sum = money(data?.amount_kopecks);
    const nick = str(data?.nick, 40);
    const code = data?.reason_code ? ` Основание: ${lateRefundLabel(data.reason_code).toLowerCase()}.` : '';
    const to = nick ? `игроку ${nick}` : 'игроку';
    const comment = str(data?.reason, 200);
    return [sum ? `Возврат взноса ${sum}` : 'Возврат взноса', `После старта турнира взнос${sum ? ` ${sum}` : ''} возвращается ${to}.${code}${comment ? ` Комментарий: «${comment}».` : ''}${who(data, 'Вернул')}`];
  },
  // №149: одна тревога об отмене, refund — 'all' (до старта или авария после) или 'none' (после старта)
  tournament_cancel: (data) => {
    if (data?.refund === 'none') return ['Турнир отменён после старта', `Взносы не возвращаются: время столов уже было занято.${why(data)}${who(data, 'Отменил')}`];
    const n = Number.isInteger(data?.refunds) ? data.refunds : null;
    const sum = money(data?.amount_kopecks);
    const back = n ? `Взносы возвращаются ${n} ${plural(n, PLAYERS)}${sum ? `, всего ${sum}` : ''}.` : 'Взносы возвращаются участникам.';
    const code = data?.reason_code ? ` Основание: ${lateRefundLabel(data.reason_code).toLowerCase()}.` : '';
    return [data?.reason_code ? 'Турнир отменён после старта с возвратом' : 'Турнир отменён', `${back}${code}${why(data)}${data?.staff_name ? who(data, 'Отменил') : ' Кто отменил и причина — в журнале.'}`];
  },
};

/** Варианты текста по data тревоги. */
const BY_DATA = {
  refund_canceled: (data) => {
    const sum = money(data?.amount_kopecks);
    if (!sum) return null;
    const lots = Number.isSafeInteger(data?.lots_restored) && data.lots_restored > 0 ? ' Пакет часов снова действует.' : '';
    return [`ЮKassa отменила возврат ${sum}`, `Деньги гостю не вернулись — верните их вручную.${lots} Подробности — в журнале.`];
  },
  pos_refund_canceled: (data) => {
    const sum = money(data?.amount_kopecks);
    if (!sum) return null;
    let tail = '';
    if (data?.packages_lost > 0) tail = ' Минуты пакета часов отозваны — начислите гостю заново.';
    else if (data?.packages_restored > 0) tail = ' Пакет часов снова действует.';
    return [`Возврат ${sum} на кассе отменён ЮKassa`, `Деньги гостю не вернулись — верните их вручную.${tail}`];
  },
  cash_refund_awaiting_shift: (data) => {
    const sum = money(data?.amount_kopecks);
    return sum ? [`Вернуть ${sum} наличными при открытии смены`, 'Смена закрыта — гостю вернут наличные, когда ресепшн откроет смену. Ресепшн получил напоминание.'] : null;
  },
  payment_not_found_at_provider: (data) =>
    data?.action === 'kept' ? ['Платёж не найден в ЮKassa', 'У нас платёж проведён, а в ЮKassa его нет. Сверьте выписку ЮKassa и журнал — при расхождении напишите в поддержку.'] : null,
  manual_action: (data) => MANUAL_BY_ACTION[data?.action]?.(data) ?? null,
  tournament_match_overdue: (data, { timeZone, now }) => {
    const until = Date.parse(data?.light_until);
    if (!Number.isFinite(until) || !timeZone) return null;
    let at;
    try {
      at = formatTime(until, timeZone);
    } catch {
      return null;
    }
    const lamp = until > now ? `Свет на столе погаснет в ${at}` : `Свет на столе погас в ${at}`;
    // limit_by (№147): 'match' — вдвое больше времени матча от его начала, 'tournament' — окно турнира
    const limit = data?.limit_by === 'match' ? 'предел матча (два времени матча от его начала)' : 'предел окна турнира';
    return ['Матч турнира затянулся', `${lamp} — ${limit}, дальше без оплаты не продлится. Решите с игроками: внесите счёт или договоритесь, как доиграть.`];
  },
};

/** Момент тревоги: последний раз поднята (last_raised_at), иначе raised_at / created_at. */
export function alarmTime(alarm) {
  return alarm.last_raised_at ?? alarm.raised_at ?? alarm.created_at ?? null;
}

/**
 * @param {{ type: string, level?: string, resource_number?: number, data?: object, text?: string, count?: number }} alarm
 * @param {{ timeZone?: string, now?: number }} [opts] пояс клуба — для времени в тексте («свет погаснет в 21:30»)
 * @returns {{ title: string, text: string, level: string, levelWord: string, table: string | null, repeats: number }}
 */
export function alarmView(alarm, { timeZone, now = Date.now() } = {}) {
  // Неизвестный нам тип — текст сервера (alarms.text), иначе код мелко
  const [title, text] = BY_DATA[alarm.type]?.(alarm.data, { timeZone, now }) ?? TEXT[alarm.type] ?? [alarm.text || 'Тревога', alarm.text ? 'Подробности — в журнале.' : `Тип: ${alarm.type}. Подробности — в журнале.`];
  const level = LEVEL_WORD[alarm.level] ? alarm.level : 'important';
  const number = alarm.resource_number ?? alarm.data?.resource_number;
  const repeats = Number.isInteger(alarm.count) && alarm.count > 1 ? alarm.count : 0;
  return { title, text, level, levelWord: LEVEL_WORD[level], table: number ? `Стол ${number}` : null, repeats };
}

/** Сначала критичные, затем новые. */
export function sortAlarms(list) {
  return [...list].sort((a, b) => (LEVEL_ORDER[a.level] ?? 1) - (LEVEL_ORDER[b.level] ?? 1) || String(alarmTime(b)).localeCompare(String(alarmTime(a))));
}

/** Ручные действия турнира, у которых есть переход к турниру. */
const TOURNAMENT_ACTIONS = ['manual.tournament_score', 'manual.tournament_extend', 'manual.tournament_refund', 'tournament_cancel'];

const RETRY_URL = /^\/api\/receipts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/retry$/;

/**
 * Действие тревоги (Д2): settlement_receipt_failed несёт data { action_id: 'retry', action_title, action_url:
 * '/api/receipts/{id}/retry' }. Кнопку показываем только для известного действия и адреса этого вида —
 * сервер не может прислать нам произвольный адрес для POST.
 * @returns {{ id: 'retry', title: string, receiptId: string } | null}
 */
export function alarmAction(alarm) {
  const d = alarm?.data;
  // Тревоги, поднятые до Д2, без action_*: тот же повтор по receipt_id
  if (alarm?.type === 'settlement_receipt_failed' && d?.action_id === undefined && typeof d?.receipt_id === 'string' && RETRY_URL.test(`/api/receipts/${d.receipt_id}/retry`)) {
    return { id: 'retry', title: 'Повторить', receiptId: d.receipt_id };
  }
  if (d?.action_id !== 'retry' || typeof d.action_url !== 'string') return null;
  const m = RETRY_URL.exec(d.action_url);
  if (!m) return null;
  return { id: 'retry', title: typeof d.action_title === 'string' && d.action_title.length <= 40 ? d.action_title : 'Повторить', receiptId: m[1] };
}

/**
 * Переход из тревоги в программу клуба: турнир (матч затянулся, исправлен счёт, отменён) или споры по партиям.
 * Идентификатор турнира — только UUID; адрес собирает клиент, не сервер.
 * @returns {{ screen: 'tournaments' | 'disputes', id: string | null, title: string } | null}
 */
export function alarmLink(alarm) {
  const d = alarm?.data;
  const tid = typeof d?.tournament_id === 'string' && UUID.test(d.tournament_id) ? d.tournament_id : null;
  if (alarm?.type === 'tournament_match_overdue') return tid ? { screen: 'tournaments', id: tid, title: 'Открыть турнир' } : null;
  if (alarm?.type !== 'manual_action') return null;
  if (tid && TOURNAMENT_ACTIONS.includes(d.action)) return { screen: 'tournaments', id: tid, title: 'Открыть турнир' };
  if (d?.action === 'plus.match_resolve') return { screen: 'disputes', id: null, title: 'Открыть споры по партиям' };
  return null;
}

/** Адрес перехода: в клубе тревоги — /club/c/{club}/…; без клуба — короткие /club/tournaments/{id}, /club/plus/disputes. */
export function alarmHref(link, clubId) {
  if (clubId) return `${BASE}c/${encodeURIComponent(clubId)}/${link.screen}${link.id ? `/${encodeURIComponent(link.id)}` : ''}`;
  return link.screen === 'disputes' ? `${BASE}plus/disputes` : `${BASE}tournaments/${encodeURIComponent(link.id)}`;
}
