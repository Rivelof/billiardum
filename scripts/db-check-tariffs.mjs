#!/usr/bin/env node
// Проверка при выкладке (M5.8 №220, находка pentester Н-5): остались ли в базе действующие тарифы клубов
// (bl.tariff_rules) и шаблонов сетей (bl.network_tariff_rules), которые после округления дают меньше 1 ₽
// (и меньше шага округления клуба) за наименьшую оплачиваемую единицу — слот целиком или шаг часа.
// Только чтение: ничего не меняет и не отключает; такие правила мастер и шаблон сети больше не принимают,
// а уже записанные продолжают действовать (бронь и котировка на 0 ₽ отклоняются сервером). Каждое найденное
// правило — строка JSON в лог выкладки; код выхода 0, а с --strict — 1, если найдено хоть одно.
//
//   DATABASE_ADMIN_URL=postgres://… node scripts/db-check-tariffs.mjs [--strict]

import { connectAdmin, log, requireEnv, runCli } from '../supabase/lib/db.mjs';
import { roundAmount } from '../server/tariffs/engine.mjs';
import { clubTariffSettings } from '../server/tariffs/index.mjs';

const MIN_PAYABLE = 100;

/** Сумма наименьшей оплачиваемой единицы после округления клуба. */
export function smallestUnitAmount({ slotMinutes = null, pricePerSlot = null, pricePerHour = 0, stepMinutes = 1 }, rounding) {
  return slotMinutes ? roundAmount(Number(pricePerSlot) * slotMinutes, rounding, slotMinutes) : roundAmount(Number(pricePerHour) * stepMinutes, rounding, 60);
}

export const belowThreshold = (row, rounding) => smallestUnitAmount(row, rounding) < Math.max(MIN_PAYABLE, rounding);

export async function findLowTariffs(client) {
  const found = [];
  const { rows: rules } = await client.query(
    `select r.id, r.club_id, c.name as club, r.resource_type, r.slot_minutes, r.price_per_slot, r.price_per_hour, r.step_minutes, c.settings
       from bl.tariff_rules r join bl.clubs c on c.id = r.club_id
      where r.active order by c.name, r.id`,
  );
  for (const r of rules) {
    const { rounding } = clubTariffSettings(r.settings);
    const row = { slotMinutes: r.slot_minutes, pricePerSlot: r.price_per_slot, pricePerHour: r.price_per_hour, stepMinutes: r.step_minutes ?? 1 };
    if (belowThreshold(row, rounding)) {
      found.push({ kind: 'club_rule', rule_id: r.id, club_id: r.club_id, club: r.club, resource_type: r.resource_type, price_per_hour: Number(r.price_per_hour), price_per_slot: r.price_per_slot === null ? null : Number(r.price_per_slot), step_minutes: r.step_minutes, rounding_kopecks: rounding, smallest_unit_kopecks: smallestUnitAmount(row, rounding) });
    }
  }
  // Шаблоны сетей: по самому крупному округлению клубов сети.
  const { rows: tpl } = await client.query(
    `select t.id, t.network_id, n.name as network, t.rule,
            coalesce((select max(case when (c.settings ->> 'price_rounding_kopecks') ~ '^[0-9]+$' then (c.settings ->> 'price_rounding_kopecks')::int else 100 end)
                        from bl.network_clubs nc join bl.clubs c on c.id = nc.club_id where nc.network_id = t.network_id and nc.active), 100) as rounding
       from bl.network_tariff_rules t join bl.networks n on n.id = t.network_id
      where t.active and n.archived_at is null order by n.name, t.ord`,
  );
  for (const t of tpl) {
    const rounding = Math.max(1, Number(t.rounding));
    const rule = t.rule ?? {};
    const row = { slotMinutes: rule.slot_minutes ?? null, pricePerSlot: rule.price_per_slot_kopecks ?? null, pricePerHour: rule.price_per_hour_kopecks ?? 0, stepMinutes: rule.step_minutes ?? 1 };
    if (belowThreshold(row, rounding)) {
      found.push({ kind: 'network_template_rule', rule_id: t.id, network_id: t.network_id, network: t.network, rule, rounding_kopecks: rounding, smallest_unit_kopecks: smallestUnitAmount(row, rounding) });
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCli(async () => {
    const client = await connectAdmin(requireEnv('DATABASE_ADMIN_URL'));
    try {
      const found = await findLowTariffs(client);
      for (const f of found) log('warn', 'tariff_below_minimum', f);
      log('info', 'tariffs_checked', { below_minimum: found.length });
      if (found.length > 0 && process.argv.includes('--strict')) process.exitCode = 1;
    } finally {
      await client.end();
    }
  });
}
