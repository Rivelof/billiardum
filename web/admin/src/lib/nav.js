import { BASE } from './env.js';
import { can } from './auth.js';

/** Разделы программы клуба по роли (снизу на телефоне, слева на планшете). wideOnly — только в боковой панели и в «Ещё». */
export function navItems(role, club) {
  const c = `${BASE}c/${encodeURIComponent(club)}/`;
  const manage = can.manage(role);
  const items = [];
  const add = (key, icon, label, wideOnly = false) => items.push({ key, href: `${c}${key}`, icon, label, wideOnly });
  // На телефоне у владельца и управляющего снизу пять пунктов: Дашборд, Сейчас, Смены, Тревоги, Ещё (M5.2).
  // Журнал, отчёты, касса, ресепшн, бар, склад, меню, ККТ и контроллеры — в «Ещё» и в боковой панели планшета
  if (can.dashboard(role)) add('dashboard', 'chart', 'Дашборд');
  if (manage) add('now', 'hall', 'Сейчас');
  if (can.pos(role)) add('pos', 'cart', 'Касса', manage);
  if (can.reception(role)) add('reception', 'reception', 'Ресепшн', manage);
  if (can.bar(role)) add('bar', 'cup', 'Бар', manage);
  if (can.shift(role)) add('shift', 'register', manage ? 'Смены' : 'Смена');
  if (can.bookings(role)) add('bookings', 'calendar', 'Брони', true);
  if (manage) {
    add('journal', 'journal', 'Журнал', true);
    add('alarms', 'bell', 'Тревоги');
  }
  if (can.reportsView(role)) add('reports', 'report', 'Отчёты', true);
  if (can.stock(role)) add('stock', 'box', 'Склад', true);
  if (can.menu(role)) add('menu', 'list', 'Меню', true);
  if (can.kkt(role)) add('kkt', 'printer', 'ККТ', true);
  if (can.packages(role)) add('packages', 'ticket', 'Пакеты', true);
  // M4: турниры, споры по партиям Бильярдум+, карточка клуба в агрегаторе
  if (can.tournaments(role)) add('tournaments', 'trophy', 'Турниры', true);
  if (can.disputes(role)) add('disputes', 'report', 'Споры', true);
  if (can.listing(role)) add('listing', 'star', 'Карточка', true);
  if (can.staff(role)) add('staff', 'users', 'Персонал', true);
  if (can.devices(role)) add('devices', 'chip', 'Контроллеры', manage);
  // M5.1: мастер подключения — в боковой панели планшета (на телефоне — в плашке и в «Ещё»);
  // управляющему — его шаги: зал, тарифы, меню, наклейки (№155–156)
  if (can.setup(role)) add('onboarding', 'flask', can.onboarding(role) ? 'Подключение' : 'Зал и тарифы', true);
  add('more', 'more', 'Ещё');
  return items;
}

