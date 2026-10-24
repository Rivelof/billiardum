#!/usr/bin/env bash
# Применить deploy/prod/caddy/Caddyfile без перезапуска Caddy (RUNBOOK §5): сначала проверка,
# затем caddy reload. Открытые мосты ККТ получают 5 минут на переподключение (stream_close_delay).

. "$(dirname "$(readlink -f "$0")")/lib.sh"
bl_load_env

bl_compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null ||
  bl_die "Caddyfile не прошёл caddy validate — ничего не применено"
bl_compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
bl_log "Caddyfile применён"
