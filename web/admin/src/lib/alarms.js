/** Тревоги владельцу (PRODUCT §8, контракт §6–§7) словами. Неизвестный тип — общий текст, код — мелко. */

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
};

/** Варианты текста по data тревоги. */
const BY_DATA = {
  payment_not_found_at_provider: (data) =>
    data?.action === 'kept' ? ['Платёж не найден в ЮKassa', 'У нас платёж проведён, а в ЮKassa его нет. Сверьте выписку ЮKassa и журнал — при расхождении напишите в поддержку.'] : null,
};

/** Момент тревоги: последний раз поднята (last_raised_at), иначе raised_at / created_at. */
export function alarmTime(alarm) {
  return alarm.last_raised_at ?? alarm.raised_at ?? alarm.created_at ?? null;
}

/**
 * @param {{ type: string, level?: string, resource_number?: number, data?: object, text?: string, count?: number }} alarm
 * @returns {{ title: string, text: string, level: string, levelWord: string, table: string | null, repeats: number }}
 */
export function alarmView(alarm) {
  // Неизвестный нам тип — текст сервера (alarms.text), иначе код мелко
  const [title, text] = BY_DATA[alarm.type]?.(alarm.data) ?? TEXT[alarm.type] ?? [alarm.text || 'Тревога', alarm.text ? 'Подробности — в журнале.' : `Тип: ${alarm.type}. Подробности — в журнале.`];
  const level = LEVEL_WORD[alarm.level] ? alarm.level : 'important';
  const number = alarm.resource_number ?? alarm.data?.resource_number;
  const repeats = Number.isInteger(alarm.count) && alarm.count > 1 ? alarm.count : 0;
  return { title, text, level, levelWord: LEVEL_WORD[level], table: number ? `Стол ${number}` : null, repeats };
}

/** Сначала критичные, затем новые. */
export function sortAlarms(list) {
  return [...list].sort((a, b) => (LEVEL_ORDER[a.level] ?? 1) - (LEVEL_ORDER[b.level] ?? 1) || String(alarmTime(b)).localeCompare(String(alarmTime(a))));
}

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
