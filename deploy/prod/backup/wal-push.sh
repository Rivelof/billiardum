#!/usr/bin/env bash
# Архив WAL → хранилище в РФ (PRODUCT §20 «база ежедневно плюс WAL»): billiardum-wal-push.timer,
# каждые 5 минут. Postgres кладёт закрытые сегменты в $BL_STATE_DIR/wal-archive (archive_command,
# deploy/prod/compose.yml, archive_timeout 5 мин). Здесь каждый сегмент шифруется age для
# BACKUP_AGE_RECIPIENTS в wal-outgoing/ (открытый файл после этого удаляется) и уходит в
# $BACKUP_RCLONE_REMOTE/wal/; отправленное rclone удаляет из wal-outgoing/.
# Хранилище недоступно — файлы ждут на диске, монитор предупреждает (RUNBOOK §6).

. "$(dirname "$(readlink -f "$0")")/../bin/lib.sh"
bl_load_env

SRC="$BL_STATE_DIR/wal-archive"
OUT="$BL_STATE_DIR/wal-outgoing"
mkdir -p "$OUT" "$BL_STATE_DIR/backup"
chmod 700 "$OUT"
exec 8>"$BL_STATE_DIR/backup/wal-lock"
flock -n 8 || exit 0

RECIPIENTS=()
for r in ${BACKUP_AGE_RECIPIENTS:?BACKUP_AGE_RECIPIENTS не задана}; do RECIPIENTS+=(-r "$r"); done

n=0
while IFS= read -r -d '' f; do
  name=$(basename "$f")
  age "${RECIPIENTS[@]}" -o "$OUT/.$name.age.tmp" "$f"
  mv -f "$OUT/.$name.age.tmp" "$OUT/$name.age"
  rm -f "$f"
  n=$((n + 1))
done < <(find "$SRC" -maxdepth 1 -type f ! -name '*.part' -print0 | sort -z)

if [[ -n $(find "$OUT" -maxdepth 1 -type f -name '*.age' -print -quit) ]]; then
  rclone move "$OUT" "${BACKUP_RCLONE_REMOTE:?}/wal" --include '*.age' --no-check-dest \
    --s3-no-check-bucket --transfers 4 --retries 3 --low-level-retries 5 --stats 0
fi
date +%s >"$BL_STATE_DIR/backup/last-wal-ok"
((n == 0)) || bl_log "WAL: отправлено сегментов $n"
