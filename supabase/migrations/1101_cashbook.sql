-- 1101 (backend, M5.2 №177): касса управляющего — управленческая денежная книга клуба (не бухгалтерия).
--
-- * bl.cashbook_categories — справочник статей клуба (расходы и прочие доходы); правит владелец,
--   статья не удаляется — выключается (active = false), записи на неё остаются.
-- * bl.cashbook_entries — записи книги: доход (income), расход (expense), инкассация из смены
--   (collection — автоматически: наличные при закрытии смены минус размен, одна запись на смену,
--   уникальный shift_id). Записи только добавляются (инвариант 2): UPDATE, DELETE и TRUNCATE запрещены
--   триггерами всем ролям; исправление — сторно: новая запись с той же статьёй и суммой со знаком
--   минус, ссылкой на исходную (reverses_id, одна на запись) и причиной.
-- Остаток на дату = сумма записей до неё (доходы и инкассации — плюс, расходы — минус).
-- RLS по club_id (ENABLE и FORCE). is_test — по режиму клуба (bl.set_is_test, №153).

create table bl.cashbook_categories (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  kind text not null check (kind in ('expense', 'income')),
  name text not null check (length(btrim(name)) between 1 and 60),
  sort smallint not null default 0 check (sort between 0 and 1000),
  active boolean not null default true,
  created_by uuid references bl.users (id),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (club_id, id)
);
create unique index cashbook_categories_name_uidx on bl.cashbook_categories (club_id, kind, lower(btrim(name)));

create table bl.cashbook_entries (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references bl.clubs (id),
  kind text not null check (kind in ('income', 'expense', 'collection')),
  -- Со знаком: исходная запись > 0, сторно < 0.
  amount_kopecks bigint not null check (amount_kopecks <> 0 and abs(amount_kopecks) <= 100000000000),
  category_id uuid,
  occurred_on date not null,
  comment text check (length(comment) between 1 and 500),
  shift_id uuid,
  reverses_id uuid,
  reason text check (length(btrim(reason)) between 1 and 2000),
  created_by uuid references bl.users (id),
  created_at timestamptz not null,
  is_test boolean not null default false,
  unique (club_id, id),
  foreign key (club_id, category_id) references bl.cashbook_categories (club_id, id),
  foreign key (club_id, shift_id) references bl.shifts (club_id, id),
  foreign key (club_id, reverses_id) references bl.cashbook_entries (club_id, id),
  check ((kind = 'collection') = (category_id is null)),
  check (kind <> 'collection' or shift_id is not null or reverses_id is not null),
  check ((reverses_id is null) = (amount_kopecks > 0)),
  check (reverses_id is null or reason is not null)
);
create unique index cashbook_entries_shift_uidx on bl.cashbook_entries (shift_id) where shift_id is not null and reverses_id is null;
create unique index cashbook_entries_reverses_uidx on bl.cashbook_entries (reverses_id) where reverses_id is not null;
create index cashbook_entries_club_day_idx on bl.cashbook_entries (club_id, occurred_on);

comment on table bl.cashbook_categories is 'Касса управляющего (M5.2 №177): статьи доходов и расходов клуба; правит владелец.';
comment on table bl.cashbook_entries is 'Касса управляющего (M5.2 №177): записи книги только добавляются; исправление — сторно со ссылкой и причиной.';

alter table bl.cashbook_categories owner to bl_owner;
alter table bl.cashbook_entries owner to bl_owner;
alter table bl.cashbook_categories enable row level security;
alter table bl.cashbook_categories force row level security;
alter table bl.cashbook_entries enable row level security;
alter table bl.cashbook_entries force row level security;

create policy cashbook_categories_app on bl.cashbook_categories for all to app_api
  using (club_id = bl.ctx_club_id()) with check (club_id = bl.ctx_club_id());
create policy cashbook_entries_app_select on bl.cashbook_entries for select to app_api using (club_id = bl.ctx_club_id());
create policy cashbook_entries_app_insert on bl.cashbook_entries for insert to app_api with check (club_id = bl.ctx_club_id());

revoke all on bl.cashbook_categories, bl.cashbook_entries from public;
grant select, insert on bl.cashbook_categories to app_api;
grant update (name, sort, active, updated_at) on bl.cashbook_categories to app_api;
grant select, insert on bl.cashbook_entries to app_api;

-- Только добавление: правка и удаление записи книги запрещены всем ролям (как журнал).
create function bl.cashbook_append_only() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'bl.cashbook_entries is append-only' using errcode = 'insufficient_privilege';
end
$$;
alter function bl.cashbook_append_only() owner to bl_owner;
revoke all on function bl.cashbook_append_only() from public;
create trigger cashbook_entries_no_update before update or delete on bl.cashbook_entries for each row execute function bl.cashbook_append_only();
create trigger cashbook_entries_no_truncate before truncate on bl.cashbook_entries for each statement execute function bl.cashbook_append_only();
alter table bl.cashbook_entries enable always trigger cashbook_entries_no_update;
alter table bl.cashbook_entries enable always trigger cashbook_entries_no_truncate;

-- Сторно: только исходной записи того же клуба, та же статья и вид, сумма — ровно минус исходная.
create function bl.cashbook_storno_check() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  o record;
begin
  if new.reverses_id is null then
    return new;
  end if;
  select kind, amount_kopecks, category_id, reverses_id into o from bl.cashbook_entries where club_id = new.club_id and id = new.reverses_id;
  if not found or o.reverses_id is not null or o.kind <> new.kind or o.category_id is distinct from new.category_id
     or new.amount_kopecks <> -o.amount_kopecks then
    raise exception 'bl.cashbook_entries: bad storno' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
alter function bl.cashbook_storno_check() owner to bl_owner;
revoke all on function bl.cashbook_storno_check() from public;
create trigger cashbook_entries_storno before insert on bl.cashbook_entries for each row execute function bl.cashbook_storno_check();

create trigger cashbook_entries_is_test before insert on bl.cashbook_entries for each row execute function bl.set_is_test();
