# PoC безопасности M5.6 (заход 2)

Отчёт — `REPORT.md` (раздел «Заход 2»). Два PoC: база (обход Н-1) и стенд (права, кэш, корт).

## `bypass.test.mjs` — обход исправления Н-1 на своём временном Postgres

Проверяет, что тестовый минус не переносится в боевую кассу после `go-live`:
сторно (API и прямой insert), сторно сторно (запрещено), инкассация смены, продажа/заказ
с платежом, запрет смены `is_test` у записей кассы (нет UPDATE у `app_api`; триггер `enable
always` у суперпользователя; под FORCE RLS строка не видна владельцу таблицы).

Нужен свой временный Postgres (НЕ база стенда). Пример поднятия (PG 16, роль `postgres`):

```bash
PGBIN=/usr/lib/postgresql/16/bin; BASE=/var/lib/postgresql/bltmp
runuser -u postgres -- bash -c "rm -rf $BASE; mkdir -p $BASE/data $BASE/sock"
runuser -u postgres -- $PGBIN/initdb -D $BASE/data -U postgres -A trust --locale=C
printf "port=54329\nlisten_addresses='127.0.0.1'\nunix_socket_directories='$BASE/sock'\nfsync=off\n" >> $BASE/data/postgresql.conf
runuser -u postgres -- $PGBIN/pg_ctl -D $BASE/data -l $BASE/log -w start
```

Прогон (каждый тест сам создаёт временную базу `bl_test_*` из template1 + миграции + сид и удаляет её):

```bash
DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:54329/postgres \
  node --test --test-concurrency=1 tests/security/m5-6/bypass.test.mjs
```

После работы кластер удалить: `runuser -u postgres -- $PGBIN/pg_ctl -D $BASE/data stop && rm -rf $BASE`.

Рядом (те же исправления, авторские тесты backend):
`server/maintenance/test/db/is-test.test.mjs` (Н-1), `.../m56.test.mjs` (T44: Н-2, Н-3),
`supabase/tests/isolation.test.mjs` — с тем же `DATABASE_ADMIN_URL` все проходят.

## `stand.sh` — права, кэш прогноза, корт на стенде

Матрица 401/403/404 обслуживания и прогноза (без входа, ресепшн, чужой клуб, владелец),
кэш прогноза (ключ по `club_id`, `Cache-Control: no-store`, `x-cache` miss→hit, тело несёт
свой `club_id`), событие обслуживания на корте → 400, на столе → 201.

Работает только со своими клубами под номерами `+7999672xxxx`; клуб сида и столы 1–8 не трогает.

```bash
STAND=https://localhost:8443 bash tests/security/m5-6/stand.sh
```

Скрипт сам провизионит свой клуб X (с кортом и столом), ресепшн и чужой клуб Y.
Повторный прогон создаёт новые тестовые клубы (лимит тестовых клубов на владельца);
чтобы переиспользовать уже созданные, передайте `CLUBX`, `COURT`, `TABLE`, `CLUBY` через окружение.
