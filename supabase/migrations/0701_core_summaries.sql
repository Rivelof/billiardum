-- 0701 (backend-core, M3): утренняя сводка владельцу (контракт M3 §1 п. 8, decisions №110).
--
-- В 10:00 по времени клуба — сводка за вчерашние рабочие сутки (№43). club_summaries —
-- что отправлено (один раз на клуб, вид и рабочие сутки; переживает перезапуск).
-- Планировщик в контексте платформы клубов не видит: список клубов с поясом и началом
-- рабочих суток даёт узкая функция bl.summary_clubs().

create table bl.club_summaries (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  kind text not null check (kind in ('morning')),
  day date not null,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  sent_at timestamptz not null,
  unique (club_id, kind, day)
);

alter table bl.club_summaries owner to bl_owner;
alter table bl.club_summaries enable row level security;
alter table bl.club_summaries force row level security;
create policy club_summaries_app on bl.club_summaries for all to app_api
  using (club_id = bl.ctx_club_id())
  with check (club_id = bl.ctx_club_id());
revoke all on bl.club_summaries from public;
grant select, insert on bl.club_summaries to app_api;

comment on table bl.club_summaries is 'Отправленные сводки клуба (утренняя): данные и время отправки, одна на рабочие сутки.';

grant select (id, timezone, settings) on bl.clubs to bl_definer;
create policy clubs_definer on bl.clubs for select to bl_definer using (true);

create function bl.summary_clubs()
returns table (club_id uuid, timezone text, day_start_local text, summary_time_local text)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select c.id, c.timezone,
         coalesce(nullif(c.settings->>'day_start_local', ''), '06:00'),
         coalesce(nullif(c.settings->>'summary_time_local', ''), '10:00')
    from bl.clubs c
   order by c.id
$$;
alter function bl.summary_clubs() owner to bl_definer;
revoke all on function bl.summary_clubs() from public;
grant execute on function bl.summary_clubs() to app_api;
comment on function bl.summary_clubs() is 'SECURITY DEFINER: клубы с поясом, началом рабочих суток и временем сводки. Только планировщик сводок.';
