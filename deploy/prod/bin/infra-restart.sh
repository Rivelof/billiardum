#!/usr/bin/env bash
# Пересоздать сервис инфраструктуры после смены образа (дайджеста) или его настроек в compose.yml
# (RUNBOOK §5.3). db и mosquitto — ТОЛЬКО в окне обслуживания: это обрывает связь контроллеров
# всех клубов и новые игры (CLAUDE.md). Авария вне окна: BL_EMERGENCY=1 и подтверждение.
#
#   sudo deploy/prod/bin/infra-restart.sh mosquitto | db | caddy

. "$(dirname "$(readlink -f "$0")")/lib.sh"
. "$BL_ROOT/deploy/prod/monitor/notify.sh"
bl_load_env

svc=${1:-}
case $svc in
  db | mosquitto) bl_require_window "перезапуск $svc" ;;
  caddy) bl_log "Caddy пересоздаётся: мосты ККТ и потоки SSE переподключатся (правка Caddyfile — caddy-reload.sh, без перезапуска)" ;;
  *) bl_die "infra-restart.sh mosquitto | db | caddy" ;;
esac

if [[ $svc == db ]]; then
  "$BL_ROOT/deploy/prod/backup/pg-backup.sh" --pre-deploy "infra-db"
fi
bl_compose pull "$svc"
bl_compose up -d --no-deps --wait --wait-timeout 300 "$svc"
bl_notify_send "Сервис $svc пересоздан ($(date '+%d.%m %H:%M'))." || true
bl_log "$svc пересоздан"
