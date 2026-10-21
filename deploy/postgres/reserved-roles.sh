#!/bin/sh
# Роли «Бильярдума» — в supautils.reserved_roles (замечание pentester L1, M0).
# Без этого привилегированная роль Supabase `postgres` через supautils может
# менять наши роли, например `ALTER ROLE app_api BYPASSRLS`, и обходить RLS.
# Роли из образа остаются; повторный запуск ничего не меняет.
#
# Выполняется внутри контейнера supabase/postgres под пользователем postgres,
# вход в базу только под supabase_admin (decisions №39):
#   docker exec -i -u postgres <контейнер> sh -s < deploy/postgres/reserved-roles.sh
# Вызывают scripts/dev.mjs, scripts/ci.mjs и .github/workflows/ci.yml.

set -eu

CONF=/etc/postgresql-custom/supautils.conf
ROLES="app_api bl_owner bl_audit_owner bl_definer"
PSQL="psql -U supabase_admin -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 -Atq"
KEY='^supautils\.reserved_roles *= *'"'"

grep -Eq "$KEY" "$CONF" || { echo "в $CONF нет supautils.reserved_roles" >&2; exit 1; }

added=""
for role in $ROLES; do
  if ! grep -E "$KEY" "$CONF" | grep -Eq "['[:space:],]$role[',]"; then
    sed -i -E "s/^(supautils\.reserved_roles *= *'[^']*)'/\1, $role'/" "$CONF"
    added="$added $role"
  fi
done

# Параметр перечитывается без перезапуска (context = sighup).
$PSQL -c "select pg_reload_conf()" >/dev/null

# Новая сессия должна видеть все роли; перечитывание асинхронное — ждём до 10 с.
i=0
while :; do
  value=$($PSQL -c "show supautils.reserved_roles")
  missing=""
  for role in $ROLES; do
    printf '%s\n' "$value" | grep -Eq "(^|[ ,])$role(,|\$)" || missing="$missing $role"
  done
  [ -z "$missing" ] && break
  i=$((i + 1))
  if [ "$i" -ge 10 ]; then
    echo "supautils.reserved_roles: после перечитывания нет ролей:$missing" >&2
    exit 1
  fi
  sleep 1
done

if [ -n "$added" ]; then
  echo "supautils.reserved_roles: добавлены$added"
else
  echo "supautils.reserved_roles: роли уже на месте"
fi
