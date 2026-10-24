#!/usr/bin/env bash
# Проверка восстановления раз в месяц (PRODUCT §20): billiardum-restore-check.timer, первый
# вторник месяца в окне обслуживания. Рабочую базу и брокер не трогает.
#
# 1. Берёт последний полный бэкап (base/<время>/ с DONE) и WAL после него из хранилища.
# 2. Расшифровывает ключом проверки (BACKUP_RESTORE_AGE_KEY) во временную папку на диске сервера.
# 3. Поднимает отдельный контейнер Postgres тем же образом, без сети (--network none), с
#    restore_command из скачанного WAL, и ждёт конца восстановления.
# 4. Проверяет: схема и число миграций как в рабочей базе, цепочка журнала каждого клуба цела
#    (bl.audit_verify), свежесть данных — RPO, общее время — RTO (RUNBOOK §7.3).
# 5. Отчёт Андрею (без персональных данных), затем удаляет контейнер и папку.
#
#   restore-check.sh [--keep] — --keep: оставить контейнер и папку для ручного разбора

. "$(dirname "$(readlink -f "$0")")/../bin/lib.sh"
. "$(dirname "$(readlink -f "$0")")/../monitor/notify.sh"
bl_load_env

KEEP=0
[[ ${1:-} == --keep ]] && KEEP=1
REMOTE=${BACKUP_RCLONE_REMOTE:?BACKUP_RCLONE_REMOTE не задана}
[[ ${BACKUP_RESTORE_AGE_KEY:-} == AGE-SECRET-KEY-1* ]] || bl_die "BACKUP_RESTORE_AGE_KEY не задана"

mkdir -p "$BL_STATE_DIR/backup"
exec 8>"$BL_STATE_DIR/backup/restore-lock"
flock -n 8 || bl_die "проверка восстановления уже идёт"

TS=$(date -u +%Y%m%dT%H%M%SZ)
WORK="$BL_STATE_DIR/restore-check/$TS"
NAME="bl-restore-check-$TS"
t0=$(date +%s)
mkdir -p "$WORK"/{dl,data,wal}
chmod 700 "$BL_STATE_DIR/restore-check" "$WORK"
IDENT="$WORK/identity"
(umask 077 && printf '%s\n' "$BACKUP_RESTORE_AGE_KEY" >"$IDENT")

cleanup() {
  rm -f "$IDENT"
  if ((KEEP)); then bl_log "оставлено: контейнер $NAME, папка $WORK"; return; fi
  docker rm -f -v "$NAME" >/dev/null 2>&1 || true
  # Файлы базы созданы пользователем postgres контейнера — удаляем тем же образом.
  docker run --rm --network none -v "$WORK:/r" "$BL_PG_IMAGE" sh -c 'rm -rf /r/data /r/wal /r/dl' >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  bl_alert restore_check critical "проверка восстановления $TS не прошла: $1"
  bl_die "$1"
}

# 1. Последний полный бэкап.
latest=$(rclone lsf --dirs-only "$REMOTE/base/" | tr -d '/' | sort | tail -n1) || fail "нет доступа к хранилищу"
[[ -n $latest ]] || fail "в хранилище нет ни одного бэкапа"
rclone cat "$REMOTE/base/$latest/DONE" >/dev/null 2>&1 || fail "бэкап $latest неполный (нет DONE)"
bl_log "проверка восстановления: бэкап $latest"
rclone copy "$REMOTE/base/$latest" "$WORK/dl" --include 'base.tar.gz.age' --include 'dynamic-security.json.age' ||
  fail "скачать бэкап $latest"
base_epoch=$(date -u -d "$(sed -E 's/^(....)(..)(..)T(..)(..)(..)Z$/\1-\2-\3 \4:\5:\6/' <<<"$latest")" +%s)
hours=$((($(date +%s) - base_epoch) / 3600 + 2))
rclone copy "$REMOTE/wal" "$WORK/dl/wal" --include '*.age' --max-age "${hours}h" || fail "скачать WAL"

# 2. Расшифровка (открытый текст — только в $WORK, 0700).
age -d -i "$IDENT" "$WORK/dl/base.tar.gz.age" | tar -xz --no-same-owner -C "$WORK/data" || fail "расшифровать или распаковать base"
age -d -i "$IDENT" -o "$WORK/dl/dynamic-security.json" "$WORK/dl/dynamic-security.json.age" || fail "расшифровать dynamic-security.json"
[[ $(head -c 1 "$WORK/dl/dynamic-security.json") == '{' ]] || fail "dynamic-security.json в бэкапе пустой или битый"
wal_n=0
for f in "$WORK"/dl/wal/*.age; do
  [[ -e $f ]] || continue
  n=$(basename "$f" .age)
  age -d -i "$IDENT" -o "$WORK/wal/$n" "$f" || fail "расшифровать WAL $n"
  wal_n=$((wal_n + 1))
done
rm -rf "$WORK/dl"
touch "$WORK/data/recovery.signal"
docker run --rm --network none -v "$WORK:/r" "$BL_PG_IMAGE" \
  sh -c 'chown -R postgres:postgres /r/data /r/wal && chmod 700 /r/data' || fail "права на папку восстановления"

# 3. Отдельный Postgres без сети.
docker run -d --name "$NAME" --network none --label com.billiardum.restore-check=1 \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
  -v "$WORK/data:/var/lib/postgresql/data" -v "$WORK/wal:/wal:ro" \
  "$BL_PG_IMAGE" postgres -D /etc/postgresql \
  -c archive_mode=off -c listen_addresses=127.0.0.1 \
  -c 'restore_command=cp /wal/%f %p' -c recovery_target_timeline=latest -c recovery_target_action=promote \
  >/dev/null || fail "запустить контейнер восстановления"

q() { docker exec "$NAME" psql -X -A -t -q -v ON_ERROR_STOP=1 -U supabase_admin -h 127.0.0.1 -d postgres -c "$1"; }
deadline=$(($(date +%s) + 3600))
until [[ $(q 'select pg_is_in_recovery()' 2>/dev/null) == f ]]; do
  (($(date +%s) < deadline)) || fail "восстановление не закончилось за час"
  docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -qx true || fail "Postgres восстановления остановился: $(docker logs --tail 5 "$NAME" 2>&1 | tr '\n' ' ')"
  sleep 5
done
rto=$(($(date +%s) - t0))

# 4. Проверки.
migr=$(q 'select count(*) from bl.schema_migrations') || fail "нет схемы bl"
live_migr=$(bl_psql -c 'select count(*) from bl.schema_migrations' 2>/dev/null || echo '?')
clubs=$(q 'select count(*) from bl.clubs')
broken=$(q 'select count(*) from (select v.ok from bl.clubs c cross join lateral bl.audit_verify(c.id) v union all select v.ok from bl.audit_verify(null) v) t where not ok')
# RPO — насколько восстановленные данные отстают от рабочей базы: последняя запись журнала,
# outbox и связи контроллеров там и там (ночью клуб закрыт, поэтому не «от текущего времени»).
LATEST="select coalesce(extract(epoch from greatest(
  (select max(created_at) from bl.audit_log), (select max(last_seen_at) from bl.devices),
  (select max(created_at) from bl.outbox)))::bigint, 0)"
restored_latest=$(q "$LATEST")
live_latest=$(bl_psql -c "$LATEST" 2>/dev/null || echo 0)
if ((live_latest > 0 && restored_latest > 0)); then
  rpo_min=$(((live_latest > restored_latest ? live_latest - restored_latest : 0) / 60))
else
  rpo_min=-1
fi

report="Проверка восстановления $TS: бэкап $latest + $wal_n сегментов WAL. Время восстановления (RTO) $((rto / 60)) мин. Свежесть данных (RPO) $rpo_min мин. Клубов $clubs, миграций $migr (в рабочей базе $live_migr). Цепочки журнала: $([[ $broken == 0 ]] && echo 'целы' || echo "РАЗОРВАНЫ у $broken")."
printf '%s %s\n' "$(date -u +%FT%TZ)" "$report" >>"$BL_STATE_DIR/backup/restore-check.log"
[[ $broken == 0 ]] || fail "$report"
[[ $live_migr == '?' || $migr == "$live_migr" ]] || fail "$report"
((rpo_min >= 0 && rpo_min <= 60)) || fail "$report (данные старше часа: WAL не доходит до хранилища)"
bl_resolve restore_check "проверка восстановления снова проходит"
bl_notify_send "$report" || true
bl_log "$report"
