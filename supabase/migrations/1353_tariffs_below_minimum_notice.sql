-- 1353 (backend, M5.8, находка pentester Н-5): тарифы ниже порога — в лог выкладки, без правки данных.
--
-- С №220 мастер тарифов и шаблон сети не принимают цену, которая после округления даёт меньше 1 ₽ за наименьшую
-- оплачиваемую единицу (слот целиком; час — на шаг продления). Уже записанные правила остаются как есть: сервер
-- отклоняет по ним бронь, котировку и оплату на 0 ₽, а владелец должен исправить тариф. Эта миграция только
-- сообщает о них (NOTICE попадает в лог `npm run db:migrate`); данные не меняет. Полная проверка с учётом
-- округления клуба — `node scripts/db-check-tariffs.mjs [--strict]`.

do $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select 'club' as scope, t.club_id::text as owner_id, t.id::text as rule_id,
           case when t.slot_minutes is not null then 'слот ' || t.slot_minutes || ' мин, ' || t.price_per_slot || ' коп.'
                else 'час ' || t.price_per_hour || ' коп., шаг ' || t.step_minutes || ' мин' end as what
      from bl.tariff_rules t
     where t.active
       and case when t.slot_minutes is not null then t.price_per_slot < 50
                else t.price_per_hour * t.step_minutes < 3000 end
    union all
    select 'network', t.network_id::text, t.id::text,
           case when t.rule ? 'slot_minutes' then 'слот ' || (t.rule ->> 'slot_minutes') || ' мин, ' || (t.rule ->> 'price_per_slot_kopecks') || ' коп.'
                else 'час ' || (t.rule ->> 'price_per_hour_kopecks') || ' коп., шаг ' || coalesce(t.rule ->> 'step_minutes', '1') || ' мин' end
      from bl.network_tariff_rules t
     where t.active
       and case when t.rule ? 'slot_minutes' then (t.rule ->> 'price_per_slot_kopecks')::bigint < 50
                else (t.rule ->> 'price_per_hour_kopecks')::bigint * coalesce((t.rule ->> 'step_minutes')::int, 1) < 3000 end
  loop
    v_n := v_n + 1;
    raise notice 'tariff below 1 RUB after rounding: scope=% owner=% rule=% (%)', r.scope, r.owner_id, r.rule_id, r.what;
  end loop;
  raise notice 'tariffs below minimum (round to 1 RUB): % rule(s); data not changed', v_n;
end
$$;
