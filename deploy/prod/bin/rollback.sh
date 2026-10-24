#!/usr/bin/env bash
# Откат выпуска (RUNBOOK §5.4) — как и выпуск, по «да» Андрея; при аварии сразу, с отчётом.
#
#   sudo deploy/prod/bin/rollback.sh            — на предыдущий выпуск из releases.log
#   sudo deploy/prod/bin/rollback.sh <sha>      — на указанный (образ billiardum-app:<sha> должен быть)
#
# Возвращает код (checkout), статику и сервисы server и site прежнего выпуска. Миграции не
# откатываются: схема остаётся новой, поэтому миграции только расширяющие (RUNBOOK §5.2).
# Если новая схема ломает старый код — восстановление базы (RUNBOOK §7.5), отдельное «да» Андрея.

. "$(dirname "$(readlink -f "$0")")/lib.sh"
. "$BL_ROOT/deploy/prod/monitor/notify.sh"
bl_load_env

LOG="$BL_STATE_DIR/releases.log"
cur=${BL_RELEASE:-}
target=${1:-}
if [[ -z $target ]]; then
  [[ -f $LOG ]] || bl_die "нет $LOG — укажите выпуск: rollback.sh <sha>"
  # Последняя строка, где новым был текущий выпуск: её «предыдущий».
  target=$(awk -v cur="$cur" '$3 == cur && $4 != "rollback" {prev = $2} END {print prev}' "$LOG")
fi
[[ $target =~ ^[0-9a-f]{7,40}$ ]] || bl_die "нет предыдущего выпуска (сейчас ${cur:-?}); укажите: rollback.sh <sha>"
[[ $target != "$cur" ]] || bl_die "$target уже работает"
docker image inspect "billiardum-app:$target" >/dev/null 2>&1 || bl_die "нет образа billiardum-app:$target (удалён?) — соберите: deploy.sh $target"

bl_log "откат: $cur → $target"
cd "$BL_ROOT"
prev_commit=$(git rev-parse HEAD)
git -c advice.detachedHead=false checkout --quiet --detach "$target"
BL_RELEASE=$target bl_compose run --rm --no-deps web-publish
bl_set_env_var BL_RELEASE "$target"
bl_compose up -d --no-deps --wait --wait-timeout 180 server
bl_compose up -d --no-deps --wait --wait-timeout 120 site
if ! git diff --quiet "$prev_commit" HEAD -- deploy/prod/caddy; then "$BL_ROOT/deploy/prod/bin/caddy-reload.sh"; fi
curl -fsS -o /dev/null --max-time 15 "https://$BL_DOMAIN/health" || bl_log "ВНИМАНИЕ: /health не отвечает после отката"
printf '%s %s %s rollback\n' "$(date -u +%FT%TZ)" "$cur" "$target" >>"$LOG"
bl_notify_send "Откат выпуска: $cur → $target. Миграции не откатывались." || true
bl_log "откат готов: работает $target"
