#!/usr/bin/env bash
# Выпуск на прод — ТОЛЬКО после явного «да» Андрея (CLAUDE.md). RUNBOOK §5.
#
#   sudo deploy/prod/bin/deploy.sh <git-ref>      — тег или коммит, прошедший CI
#
# Порядок (простой — секунды, пока перезапускается server; брокер и база не трогаются):
#   1. preflight.sh; checkout <git-ref> в /opt/billiardum (без локальных правок);
#   2. сборка образа billiardum-app:<sha> (старый образ остаётся — для отката);
#   3. логический дамп базы в predeploy/ (pg-backup.sh --pre-deploy);
#   4. миграции (сервис migrate) и роли в supautils.reserved_roles; миграции — только
#      «расширяющие»: старый код должен работать на новой схеме (RUNBOOK §5.2); клиент
#      bl-server в Dynamic Security, если его ещё нет (mqtt-server-client.mjs --if-missing);
#   5. сборки приложений в том web-static (без перезапуска Caddy);
#   6. BL_RELEASE=<sha> в файле настроек, пересоздание site и server с --no-deps --wait:
#      идущие игры доигрываются на контроллерах (инвариант 3), мост MQTT переподключается сам;
#   7. Caddyfile изменился — caddy reload (без перезапуска); mosquitto.conf или compose.yml
#      сервисов db, mosquitto, caddy изменились — только напоминание: это окно обслуживания;
#   8. проверка https://{домен}/health, запись в releases.log, сообщение Андрею.

. "$(dirname "$(readlink -f "$0")")/lib.sh"
. "$BL_ROOT/deploy/prod/monitor/notify.sh"
bl_load_env

REF=${1:-}
[[ -n $REF ]] || bl_die "deploy.sh <git-ref>"
[[ $REF =~ ^[A-Za-z0-9._/-]+$ ]] || bl_die "git-ref — [A-Za-z0-9._/-]"

"$BL_ROOT/deploy/prod/bin/preflight.sh" >/dev/null || bl_die "preflight.sh: есть ошибки (запустите его отдельно)"

cd "$BL_ROOT"
[[ -z $(git status --porcelain --untracked-files=no) ]] || bl_die "$BL_ROOT: локальные правки в отслеживаемых файлах"
prev=${BL_RELEASE:-}
prev_commit=$(git rev-parse HEAD)
git fetch --quiet --tags origin
git -c advice.detachedHead=false checkout --quiet --detach "$REF"
NEW=$(git rev-parse --short=12 HEAD)
bl_log "выпуск $NEW ($REF), сейчас работает ${prev:-ничего}"
[[ $NEW != "$prev" ]] || bl_log "этот выпуск уже работает — пересоздаю сервисы"

changed() { git diff --quiet "$prev_commit" HEAD -- "$@" && return 1 || return 0; }

# 2. Образ выпуска.
BL_RELEASE=$NEW bl_compose build server
# 3. Дамп перед миграциями (если база уже есть).
if [[ -n $(bl_compose ps -q db 2>/dev/null) ]]; then
  "$BL_ROOT/deploy/prod/backup/pg-backup.sh" --pre-deploy "$NEW"
fi
# 4. Миграции и роли; учётная запись сервера в брокере (идемпотентно, пароль — из .env).
BL_RELEASE=$NEW bl_compose run --rm --no-deps migrate
bl_compose exec -T -u postgres db sh -s <"$BL_ROOT/deploy/postgres/reserved-roles.sh"
BL_RELEASE=$NEW bl_compose run --rm --no-deps tools node deploy/prod/bin/mqtt-server-client.mjs --if-missing
# 5. Статика.
BL_RELEASE=$NEW bl_compose run --rm --no-deps web-publish
# 6. Сервисы приложения.
bl_set_env_var BL_RELEASE "$NEW"
bl_compose up -d --no-deps --wait --wait-timeout 180 server
bl_compose up -d --no-deps --wait --wait-timeout 120 site
# 7. Конфиги инфраструктуры.
if changed deploy/prod/caddy; then
  "$BL_ROOT/deploy/prod/bin/caddy-reload.sh"
fi
if changed deploy/prod/mosquitto; then
  bl_log "ВНИМАНИЕ: изменился deploy/prod/mosquitto — применить deploy/prod/bin/mqtt-reload.sh (SIGHUP, без перезапуска)"
fi
if changed deploy/prod/compose.yml deploy/prod/postgres; then
  bl_log "ВНИМАНИЕ: изменился compose.yml или pg_hba — сервисы db, mosquitto, caddy пересоздаются только в окне обслуживания: infra-restart.sh"
fi
# 8. Проверка.
sleep 3
curl -fsS -o /dev/null --max-time 15 "https://$BL_DOMAIN/health" || bl_die "https://$BL_DOMAIN/health не отвечает после выпуска — откат: rollback.sh"
mkdir -p "$BL_STATE_DIR"
printf '%s %s %s %s\n' "$(date -u +%FT%TZ)" "${prev:-none}" "$NEW" "$REF" >>"$BL_STATE_DIR/releases.log"
bl_notify_send "Выпуск $NEW ($REF) развёрнут. Предыдущий — ${prev:-нет}; откат: deploy/prod/bin/rollback.sh" || true
bl_log "готово: $NEW. Откат: deploy/prod/bin/rollback.sh"
