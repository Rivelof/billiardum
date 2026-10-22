/** Тревоги владельцу (PRODUCT §8, контракт §6–§7) словами. Неизвестный тип — общий текст, код — мелко. */

export const LEVEL_WORD = { critical: 'Критично', important: 'Важно', info: 'Для сведения' };
const LEVEL_ORDER = { critical: 0, important: 1, info: 2 };

const TEXT = {
  bypass_detected: ['Свет горит без оплаты', 'Ток в лампе при выключенном реле: свет включили в обход системы. Проверьте стол.'],
  lamp_fault: ['Лампа не горит во время игры', 'Реле включено, а ток лампы нулевой. Проверьте лампу, гостю может понадобиться другой стол.'],
  device_offline: ['Стол без связи во время игры', 'Контроллер не отвечает больше 2 минут. Игра доиграется по таймеру стола; проверьте питание и Wi-Fi.'],
  offline: ['Стол без связи во время игры', 'Контроллер не отвечает больше 2 минут. Игра доиграется по таймеру стола; проверьте питание и Wi-Fi.'],
  bad_sig: ['Команда с неверной подписью', 'Стол получил команду, подписанную не сервером. Возможна попытка взлома — сообщите в поддержку.'],
  state_mismatch: ['Стол и сервер расходятся', 'Состояние стола не совпало с базой. Сервер выровнял его; если повторится — проверьте контроллер.'],
  replayed_seq: ['Повтор старой команды', 'Стол отклонил повтор старой команды. Если повторяется — сообщите в поддержку.'],
  refund_auto: ['Автоматический возврат', 'Стол оказался занят к моменту оплаты, деньги гостю возвращены.'],
  outbox_failed: ['Сервер не выполнил задачу', 'Задача не прошла после 5 попыток. Сообщите в поддержку.'],
  manual_action: ['Ручное действие персонала', 'Сотрудник выполнил действие с причиной. Подробности — в журнале.'],
};

/**
 * @param {{ type: string, level?: string, resource_number?: number, data?: object, created_at?: string }} alarm
 * @returns {{ title: string, text: string, level: string, levelWord: string, table: string | null }}
 */
export function alarmView(alarm) {
  const [title, text] = TEXT[alarm.type] ?? ['Тревога', `Тип: ${alarm.type}. Подробности — в журнале.`];
  const level = LEVEL_WORD[alarm.level] ? alarm.level : 'important';
  const number = alarm.resource_number ?? alarm.data?.resource_number;
  return { title, text, level, levelWord: LEVEL_WORD[level], table: number ? `Стол ${number}` : null };
}

/** Сначала критичные, затем новые. */
export function sortAlarms(list) {
  return [...list].sort((a, b) => (LEVEL_ORDER[a.level] ?? 1) - (LEVEL_ORDER[b.level] ?? 1) || String(b.created_at).localeCompare(String(a.created_at)));
}
