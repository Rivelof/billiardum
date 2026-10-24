# shellcheck shell=bash
# Общее для скриптов прода (deploy/prod/bin, deploy/prod/backup, deploy/prod/monitor).
# Подключается через `. "$(dirname "$0")/../bin/lib.sh"`; сам ничего не запускает.
#
# Пути по умолчанию (RUNBOOK §4): код — /opt/billiardum (git checkout), настройки —
# /etc/billiardum/prod.env (root, 0600), состояние — /var/lib/billiardum.
# Значения секретов не печатаются никогда: только длина.

set -euo pipefail

BL_ROOT=${BL_ROOT:-/opt/billiardum}
BL_ENV_FILE=${BL_ENV_FILE:-/etc/billiardum/prod.env}
BL_PROJECT=billiardum-prod
BL_COMPOSE_FILE="$BL_ROOT/deploy/prod/compose.yml"
# Образ базы — тот же дайджест, что у сервиса db (проверяет scripts/ci-prod-config.test.mjs).
BL_PG_IMAGE='supabase/postgres:15.8.1.085@sha256:af083ef64d0408c8f098ee6f5c364a59b26f36fbc0f3a334a62c5c1d57362e9b'

bl_log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
bl_die() { bl_log "ОШИБКА: $*"; exit 1; }

# Читает KEY=VALUE из файла настроек без eval: значение — остаток строки, кавычки по краям
# снимаются. Комментарии — только целой строкой. Переменная окружения главнее файла.
bl_load_env() {
  local file=${1:-$BL_ENV_FILE} line key value
  [[ -f $file ]] || bl_die "нет файла настроек $file (RUNBOOK §4.3)"
  if [[ $(id -u) -eq 0 && $file == "$BL_ENV_FILE" ]]; then
    local mode owner
    mode=$(stat -c '%a' "$file")
    owner=$(stat -c '%u' "$file")
    [[ $owner == 0 && $mode == 600 ]] || bl_die "$file: владелец root и права 0600 (сейчас uid $owner, $mode)"
  fi
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    if [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]]; then value=${BASH_REMATCH[1]}; fi
    if [[ -z ${!key:-} ]]; then export "$key=$value"; fi
  done <"$file"
  export BL_STATE_DIR=${BL_STATE_DIR:-/var/lib/billiardum}
  export BL_MQTT_CERTS_DIR=${BL_MQTT_CERTS_DIR:-/etc/billiardum/mqtt}
}

bl_compose() {
  docker compose -p "$BL_PROJECT" -f "$BL_COMPOSE_FILE" --env-file "$BL_ENV_FILE" "$@"
}

# psql под supabase_admin внутри контейнера базы (вход с 127.0.0.1 без пароля, наружу база
# не открыта). Только чтение — забота вызывающего (begin read only).
bl_psql() {
  bl_compose exec -T db psql -X -A -t -q -v ON_ERROR_STOP=1 -U supabase_admin -h 127.0.0.1 -d postgres "$@"
}

# Меняет KEY=… в файле настроек (не секреты: BL_RELEASE). Атомарно, права сохраняются.
bl_set_env_var() {
  local key=$1 value=$2 file=${3:-$BL_ENV_FILE} tmp
  [[ $key =~ ^[A-Z_][A-Z0-9_]*$ ]] || bl_die "bl_set_env_var: имя $key"
  [[ $value =~ ^[A-Za-z0-9._:/-]*$ ]] || bl_die "bl_set_env_var: значение $key — только [A-Za-z0-9._:/-]"
  tmp=$(mktemp "$file.XXXXXX")
  chmod 600 "$tmp"
  if grep -q "^$key=" "$file"; then
    sed "s|^$key=.*|$key=$value|" "$file" >"$tmp"
  else
    cat "$file" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  mv -f "$tmp" "$file"
  export "$key=$value"
}

# Окно обслуживания: MAINTENANCE_WINDOW=ЧЧ:ММ-ЧЧ:ММ по MAINTENANCE_TZ (пояс клуба), может
# переходить через полночь. Клубы в это время закрыты: можно трогать брокер и базу.
bl_in_window() {
  local win=${MAINTENANCE_WINDOW:-} tz=${MAINTENANCE_TZ:-Europe/Moscow} now from to
  [[ $win =~ ^([0-2][0-9]):([0-5][0-9])-([0-2][0-9]):([0-5][0-9])$ ]] || bl_die "MAINTENANCE_WINDOW — ЧЧ:ММ-ЧЧ:ММ (сейчас «$win»)"
  from=$((10#${BASH_REMATCH[1]} * 60 + 10#${BASH_REMATCH[2]}))
  to=$((10#${BASH_REMATCH[3]} * 60 + 10#${BASH_REMATCH[4]}))
  now=$(TZ=$tz date +%H:%M)
  now=$((10#${now%:*} * 60 + 10#${now#*:}))
  if ((from <= to)); then ((now >= from && now < to)); else ((now >= from || now < to)); fi
}

# Действие, которое перезапускает брокер или базу: только в окне обслуживания. Вне окна —
# только авария с BL_EMERGENCY=1 и подтверждением словом АВАРИЯ (RUNBOOK §5).
bl_require_window() {
  local what=$1 answer
  if bl_in_window; then return 0; fi
  if [[ ${BL_EMERGENCY:-} == 1 ]]; then
    bl_log "ВНИМАНИЕ: $what вне окна обслуживания (${MAINTENANCE_WINDOW} ${MAINTENANCE_TZ:-Europe/Moscow}): клубы могут работать."
    read -r -p "Оборвёт связь контроллеров со всеми клубами. Введите АВАРИЯ, чтобы продолжить: " answer
    [[ $answer == АВАРИЯ ]] || bl_die "отменено"
    return 0
  fi
  bl_die "$what — только в окне обслуживания ${MAINTENANCE_WINDOW} (${MAINTENANCE_TZ:-Europe/Moscow}). Авария: BL_EMERGENCY=1 (RUNBOOK §5)"
}

# Длина значения переменной — вместо значения (секреты не печатаются).
bl_len() { local v=${!1:-}; printf '%s' "${#v}"; }
