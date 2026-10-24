#!/usr/bin/env bash
# docker compose прода с нужным файлом настроек и именем проекта:
#   deploy/prod/bin/compose.sh ps
#   deploy/prod/bin/compose.sh logs --since 10m server
#   deploy/prod/bin/compose.sh run --rm tools node deploy/prod/bin/mqtt-server-client.mjs
#
# Защита от перезапуска брокера и базы в часы работы клубов (CLAUDE.md): up, restart, stop,
# down, kill, rm, pause, create без имён сервисов, с db или mosquitto, а up и create — ещё и
# без --no-deps (Compose пересоздал бы зависимости) — только в окне обслуживания.
# Сигнал брокеру (kill -s HUP mosquitto, перечитать настройки) разрешён всегда.

. "$(dirname "$(readlink -f "$0")")/lib.sh"
bl_load_env

guard() {
  local sub=${1:-} arg named=0 risky=0 nodeps=0 signal=''
  shift || true
  case $sub in up | restart | stop | down | kill | rm | pause | create) ;; *) return 0 ;; esac
  local prev=''
  for arg in "$@"; do
    case $arg in
      --no-deps) nodeps=1 ;;
      -s | --signal) ;;
      --signal=*) signal=${arg#--signal=} ;;
      -*) ;;
      *)
        if [[ $prev == -s || $prev == --signal ]]; then signal=$arg
        elif [[ $prev =~ ^(-t|--timeout|--wait-timeout|--scale|--pull)$ ]]; then :
        else
          named=1
          [[ $arg == db || $arg == mosquitto ]] && risky=1
        fi
        ;;
    esac
    prev=$arg
  done
  if [[ $sub == kill && $signal =~ ^(HUP|SIGHUP)$ ]]; then return 0; fi
  if ((named == 0)); then risky=1; fi
  if [[ ($sub == up || $sub == create) && $nodeps == 0 ]]; then risky=1; fi
  if ((risky)); then bl_require_window "docker compose $sub (затрагивает db или mosquitto)"; fi
}

guard "$@"
bl_compose "$@"
