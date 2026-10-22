// Чек 54-ФЗ для ЮKassa и задания на ККТ клуба (инвариант 7, decisions №52).
// Позиция: «Игра, стол N, X ч», признак способа расчёта full_payment, предмет расчёта service
// (услуга начинается в момент оплаты), ставка НДС и система налогообложения — настройки клуба.

import { formatDuration } from '../tariffs/engine.mjs';
import { formatValue } from './yookassa.mjs';

/** Текст позиции чека: «Игра, стол 4, 2 ч», «Игра, стол 4, 1 ч 47 мин». */
export function itemDescription({ resourceNumber, minutes }) {
  const what = minutes == null ? 'без лимита' : formatDuration(minutes);
  return `Игра, стол ${resourceNumber}, ${what}`.slice(0, 128);
}

/** Телефон E.164 (+79990000001) → формат ЮKassa без «+» (79990000001); иначе null. */
export function receiptPhone(phone) {
  if (typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone)) return null;
  return phone.slice(1);
}

/** Позиции чека (одна услуга) — общий вид для ЮKassa и задания на ККТ. */
export function receiptItems({ resourceNumber, minutes, amountKopecks, vatCode }) {
  return [
    {
      description: itemDescription({ resourceNumber, minutes }),
      quantity: 1,
      amount: { value: formatValue(amountKopecks), currency: 'RUB' },
      vat_code: vatCode,
      payment_mode: 'full_payment',
      payment_subject: 'service',
    },
  ];
}

/**
 * Чек для запроса ЮKassa (платёж, списание заморозки, возврат).
 * @param {{ phone: string, resourceNumber: number, minutes: number|null, amountKopecks: number, settings: { vat_code: number, tax_system_code: number|null } }} p
 */
export function yookassaReceipt({ phone, resourceNumber, minutes, amountKopecks, settings }) {
  const customerPhone = receiptPhone(phone);
  if (!customerPhone) throw new Error('нет телефона гостя для чека');
  const receipt = {
    customer: { phone: customerPhone },
    items: receiptItems({ resourceNumber, minutes, amountKopecks, vatCode: settings.vat_code }),
  };
  if (settings.tax_system_code != null) receipt.tax_system_code = settings.tax_system_code;
  return receipt;
}
