#!/usr/bin/env bash
# Ежедневный бэкап прода (PRODUCT §20, RUNBOOK §7): billiardum-backup.timer, 05:23 по Москве.
#
# В хранилище S3 в РФ (BACKUP_RCLONE_REMOTE), папка base/<время UTC>/, всё зашифровано age для
# BACKUP_AGE_RECIPIENTS (ключ Андрея и ключ проверки восстановления); открытого текста на диске нет:
#   base.tar.gz.age            — физический бэкап кластера (pg_basebackup, с WAL на время бэкапа);
#                                вместе с архивом WAL (wal-push.sh) — восстановление на любой момент
#   postgres.dump.age          — логический дамп базы postgres (pg_dump -Fc): частичное
#                                восстановление и переезд на новую версию Postgres
#   globals.sql.age            — роли кластера (pg_dumpall --globals-only)
#   postgresql-custom.tar.gz.age — /etc/postgresql-custom (supautils.conf и ключи образа)
#   dynamic-security.json.age  — клиенты и роли брокера (без него контроллеры не войдут)
#   DONE                       — опись: размеры и время, без секретов; без DONE бэкап неполный
# Отдельно, в secrets/, только для ключа Андрея (BACKUP_ENV_AGE_RECIPIENT), при изменении:
#   prod.env.<время>.age, mqtt-certs.<время>.tar.age — файл настроек (SECRETS_ENC_KEY, №23) и
#   сертификаты брокера. Ключ проверки восстановления их не открывает.
#
#   pg-backup.sh                       — всё, как по таймеру
#   pg-backup.sh --pre-deploy <выпуск> — только логический дамп в predeploy/ (deploy.sh, перед миграциями)
#
# Удаление старого — правилом жизненного цикла бакета (35 дней): у ключа сервера нет права удалять.

. "$(dirname "$(readlink -f "$0")")/../bin/lib.sh"
. "$(dirname "$(readlink -f "$0")")/../monitor/notify.sh"
bl_load_env

MODE=full
LABEL=''
case ${1:-} in
  '') ;;
  --pre-deploy) MODE=predeploy LABEL=${2:-} ;;
  *) bl_die "pg-backup.sh [--pre-deploy <выпуск>]" ;;
esac
[[ $LABEL =~ ^[A-Za-z0-9._-]*$ ]] || bl_die "выпуск — [A-Za-z0-9._-]"

mkdir -p "$BL_STATE_DIR/backup"
exec 8>"$BL_STATE_DIR/backup/lock"
flock -w 600 8 || bl_die "другой бэкап ещё идёт"

REMOTE=${BACKUP_RCLONE_REMOTE:?BACKUP_RCLONE_REMOTE не задана}
RECIPIENTS=()
for r in ${BACKUP_AGE_RECIPIENTS:?BACKUP_AGE_RECIPIENTS не задана}; do RECIPIENTS+=(-r "$r"); done
TS=$(date -u +%Y%m%dT%H%M%SZ)
MANIFEST=$(mktemp)
trap 'rm -f "$MANIFEST"' EXIT

enc() { age "${RECIPIENTS[@]}"; }
put() { rclone rcat --s3-no-check-bucket "$REMOTE/$1"; }
size() { { rclone size --json "$REMOTE/$1" 2>/dev/null || true; } | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p'; }

# поток → шифрование → хранилище; в опись — имя и размер. Вызывается с «|| fail», поэтому
# set -e внутри не действует: ошибку любого звена конвейера возвращаем явно (pipefail).
stream() {
  local name=$1 path=$2
  shift 2
  bl_log "бэкап: $name"
  "$@" | enc | put "$path" || return 1
  printf '%s %s\n' "$name" "$(size "$path")" >>"$MANIFEST"
}

fail() {
  bl_alert backup_failed critical "бэкап $TS не удался ($1). Последний удачный — $(cat "$BL_STATE_DIR/backup/last-base-name" 2>/dev/null || echo 'нет')."
  bl_die "$1"
}

pg_dump_db() { bl_compose exec -T db pg_dump -h 127.0.0.1 -U supabase_admin -d postgres -Fc -Z 6; }

if [[ $MODE == predeploy ]]; then
  stream postgres.dump "predeploy/$TS-${LABEL:-manual}/postgres.dump.age" pg_dump_db || fail "pg_dump перед выпуском"
  printf 'created %s\nlabel %s\n' "$TS" "$LABEL" >>"$MANIFEST"
  put "predeploy/$TS-${LABEL:-manual}/DONE" <"$MANIFEST" || fail "опись"
  bl_log "бэкап перед выпуском: predeploy/$TS-${LABEL:-manual}"
  exit 0
fi

started=$(date +%s)
base="base/$TS"
stream base.tar.gz "$base/base.tar.gz.age" \
  bl_compose exec -T db pg_basebackup -h 127.0.0.1 -U supabase_admin -D - -Ft -X fetch -z -c fast -l "bl-$TS" -w ||
  fail "pg_basebackup"
stream postgres.dump "$base/postgres.dump.age" pg_dump_db || fail "pg_dump"
stream globals.sql "$base/globals.sql.age" \
  bl_compose exec -T db pg_dumpall -h 127.0.0.1 -U supabase_admin --globals-only || fail "pg_dumpall --globals-only"
stream postgresql-custom.tar.gz "$base/postgresql-custom.tar.gz.age" \
  bl_compose exec -T db tar -C /etc/postgresql-custom -czf - . || fail "/etc/postgresql-custom"
stream dynamic-security.json "$base/dynamic-security.json.age" \
  bl_compose exec -T mosquitto cat /mosquitto/data/dynamic-security.json || fail "dynamic-security.json"

# Файл настроек и сертификаты брокера — только для ключа Андрея и только при изменении.
secrets_sum=$({ cat "$BL_ENV_FILE" "$BL_MQTT_CERTS_DIR"/ca.crt "$BL_MQTT_CERTS_DIR"/mqtt.crt "$BL_MQTT_CERTS_DIR"/mqtt.key 2>/dev/null || true; } | sha256sum | cut -d' ' -f1)
if [[ $secrets_sum != "$(cat "$BL_STATE_DIR/backup/secrets.sha256" 2>/dev/null)" ]]; then
  [[ -n ${BACKUP_ENV_AGE_RECIPIENT:-} ]] || fail "BACKUP_ENV_AGE_RECIPIENT не задана"
  age -r "$BACKUP_ENV_AGE_RECIPIENT" <"$BL_ENV_FILE" | put "secrets/prod.env.$TS.age" || fail "копия файла настроек"
  tar -C "$BL_MQTT_CERTS_DIR" -cf - ca.crt mqtt.crt mqtt.key | age -r "$BACKUP_ENV_AGE_RECIPIENT" |
    put "secrets/mqtt-certs.$TS.tar.age" || fail "копия сертификатов брокера"
  printf '%s\n' "$secrets_sum" >"$BL_STATE_DIR/backup/secrets.sha256"
  bl_log "копия файла настроек и сертификатов брокера: secrets/*.$TS.age (ключ Андрея)"
fi

elapsed=$(($(date +%s) - started))
printf 'created %s\nelapsed_s %s\nrelease %s\n' "$TS" "$elapsed" "${BL_RELEASE:-}" >>"$MANIFEST"
put "$base/DONE" <"$MANIFEST" || fail "опись DONE"

date +%s >"$BL_STATE_DIR/backup/last-base-ok"
printf '%s\n' "$TS" >"$BL_STATE_DIR/backup/last-base-name"
bl_resolve backup_failed "ежедневный бэкап $TS сохранён"
bl_log "бэкап $TS готов за $elapsed с: $(tr '\n' ' ' <"$MANIFEST")"
