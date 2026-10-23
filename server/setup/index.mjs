// Подключение клуба без выезда, часть backend-B (M5.1 №155–159): зал, тарифы, наклейки.
//
// Функции для чек-листа запуска backend-A (m5-1.md §3, №160). Все принимают db — транзакцию
// в контексте клуба (withContext с clubId или ctx.db запроса этого клуба): RLS отдаёт только его строки.
//
//   resources.activeCount(db, clubId) → number            — столов в работе (п. 1)
//   tariffs.coversWeek(db, clubId)    → boolean           — тарифы покрывают неделю каждого стола в работе (п. 3)
//   tariffs.weekCoverage(db, clubId)  → { ok, problem }   — то же с первой дырой {type:'gap', kind, weekday, from, to, resource_id?}
//   qr.printedAt(db, clubId)          → Date | null       — последняя выгрузка QR-наклеек столов (п. 6)
//   qr.printStatus(db, clubId)        → { active, printed, printed_at } — сколько столов в работе с наклейкой

import { activeCount, createResource, listResources, setHallSize, updateResource } from './hall.mjs';
import { printedAt, printStatus, printStickers } from './stickers.mjs';
import { coversWeek, getTariffs, saveTariffs, templatesJson, weekCoverage } from './tariffs.mjs';

export const resources = Object.freeze({ activeCount, list: listResources, create: createResource, update: updateResource, setHallSize });
export const tariffs = Object.freeze({ coversWeek, weekCoverage, get: getTariffs, save: saveTariffs, templates: templatesJson });
export const qr = Object.freeze({ printedAt, printStatus, print: printStickers });

export { activeCount, coversWeek, printedAt, printStatus, weekCoverage };
