#!/usr/bin/env bash
# Монитор прода (PRODUCT §20): раз в минуту (billiardum-monitor.timer). Тревоги — Андрею через
# бота (monitor/notify.sh), без внешних сервисов за рубежом. Повтор — раз в час, пока не
# починится; «восстановлено» — когда прошло.
#
#   monitor.sh                 — всё: снаружи, контейнеры, база, логи, диск, бэкапы
#   monitor.sh --external-only — только снаружи (домен, TLS, MQTT): для второго сервера в РФ,
#                                который следит за этим (RUNBOOK §6, вопрос Андрею)
#   monitor.sh --dry-run       — напечатать показатели, ничего не отправлять
#
# Что проверяется и пороги — RUNBOOK §6. Персональных данных в тревогах нет.

. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../bin/lib.sh"
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/notify.sh"
bl_load_env

MODE=all
DRY=0
for a in "$@"; do
  case $a in
    --external-only) MODE=external ;;
    --dry-run) DRY=1 ;;
    *) bl_die "неизвестный параметр $a" ;;
  esac
done

DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
WARN_PCT=${MONITOR_DISK_WARN_PCT:-80}
CRIT_PCT=${MONITOR_DISK_CRIT_PCT:-90}
MIN_ONLINE_PCT=${MONITOR_DEVICES_MIN_ONLINE_PCT:-90}

problem() { # key level text
  if ((DRY)); then printf 'ПРОБЛЕМА [%s] %s: %s\n' "$2" "$1" "$3"; else bl_alert "$1" "$2" "$3"; fi
}
fine() { # key text
  if ((DRY)); then printf 'норма %s\n' "$1"; else bl_resolve "$1" "$2"; fi
}

# Часы, когда контроллеры должны быть на связи: MONITOR_DEVICE_HOURS=ЧЧ-ЧЧ по MONITOR_TZ
# (ночью клуб может обесточивать зал). Пусто — круглосуточно.
device_hours() {
  local h=${MONITOR_DEVICE_HOURS:-} now from to
  [[ -z $h ]] && return 0
  [[ $h =~ ^([0-9]{1,2})-([0-9]{1,2})$ ]] || return 0
  from=$((10#${BASH_REMATCH[1]})) to=$((10#${BASH_REMATCH[2]}))
  now=$((10#$(TZ=${MONITOR_TZ:-Europe/Moscow} date +%H)))
  if ((from <= to)); then ((now >= from && now < to)); else ((now >= from || now < to)); fi
}

cert_days_left() { # pem на stdin → дней до конца
  local end
  end=$(openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2) || return 1
  [[ -n $end ]] || return 1
  echo $((($(date -d "$end" +%s) - $(date +%s)) / 86400))
}

check_external() {
  local days mqtt_host
  if curl -fsS -o /dev/null --max-time 10 "https://$BL_DOMAIN/health"; then
    fine http_health "сайт и API https://$BL_DOMAIN/health отвечают"
  else
    problem http_health critical "https://$BL_DOMAIN/health не отвечает: сервер, Caddy или база недоступны. Новые игры не стартуют, идущие доигрываются на контроллерах."
  fi
  days=$(openssl s_client -connect "$BL_DOMAIN:443" -servername "$BL_DOMAIN" </dev/null 2>/dev/null | cert_days_left || echo -1)
  if ((days < 14)); then
    problem tls_web warning "сертификат https://$BL_DOMAIN: осталось $days дн. (Caddy обновляет за 30 дней — продление не проходит)"
  else
    fine tls_web "сертификат сайта продлён"
  fi
  mqtt_host=${MQTT_PUBLIC_URL#mqtts://}
  mqtt_host=${mqtt_host%:*}
  if [[ -f $BL_MQTT_CERTS_DIR/ca.crt ]]; then
    if days=$(openssl s_client -connect "$mqtt_host:8883" -servername "$mqtt_host" -CAfile "$BL_MQTT_CERTS_DIR/ca.crt" \
      -verify_return_error </dev/null 2>/dev/null | cert_days_left); then
      fine mqtt_tls "брокер $mqtt_host:8883 принимает TLS"
      if ((days < 90)); then
        problem mqtt_cert warning "сертификат брокера: осталось $days дн. Выпустить новый тем же CA и mqtt-reload.sh (RUNBOOK §8)"
      else
        fine mqtt_cert "сертификат брокера заменён"
      fi
    else
      problem mqtt_tls critical "брокер $mqtt_host:8883 не принимает TLS: контроллеры без связи с сервером"
    fi
  fi
}

check_containers() {
  local svc id state bad=()
  for svc in db mosquitto server site caddy; do
    id=$(bl_compose ps -q "$svc" 2>/dev/null || true)
    if [[ -z $id ]]; then bad+=("$svc: не запущен"); continue; fi
    state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || echo unknown)
    [[ $state == 'running healthy' ]] || bad+=("$svc: $state")
  done
  if ((${#bad[@]})); then
    problem containers critical "сервисы: ${bad[*]}"
    return 1
  fi
  fine containers "все сервисы healthy"
}

declare -A M=()
check_db() {
  local out line
  if ! out=$(bl_psql <"$DIR/checks.sql" 2>&1); then
    problem db_query critical "запрос показателей к базе не прошёл"
    return 1
  fi
  fine db_query "база отвечает на запросы монитора"
  while IFS= read -r line; do
    [[ $line == *'|'* ]] && M[${line%%|*}]=${line#*|}
  done <<<"$out"
  if ((DRY)); then for k in "${!M[@]}"; do printf '  %s = %s\n' "$k" "${M[$k]}"; done | sort; fi

  local total=${M[devices_total]:-0} off=${M[devices_offline_10m]:-0} pct=100
  ((total > 0)) && pct=$(((total - off) * 100 / total))
  if device_hours && ((total > 0)); then
    if ((${M[clubs_all_offline]:-0} > 0)); then
      problem club_offline critical "клубов целиком без связи дольше 10 минут: ${M[clubs_all_offline]} (интернет или питание клуба). Оплаченные игры доигрываются, новые по QR не стартуют."
    else
      fine club_offline "клубы снова на связи"
    fi
    if ((pct < MIN_ONLINE_PCT)); then
      problem devices_online warning "контроллеров на связи $pct % ($((total - off)) из $total), порог $MIN_ONLINE_PCT %"
    else
      fine devices_online "контроллеров на связи $pct % ($((total - off)) из $total)"
    fi
    if ((${M[kkt_bridges_offline]:-0} > 0)); then
      problem kkt_bridge warning "мостов ККТ без связи дольше 10 минут: ${M[kkt_bridges_offline]} — чеки на ресепшене копятся в очереди"
    else
      fine kkt_bridge "мосты ККТ на связи"
    fi
  fi

  if ((${M[outbox_payment_due]:-0} > 0)); then
    problem outbox_payment critical "оплаты без обработки дольше 2 минут: ${M[outbox_payment_due]} (оплата → свет, outbox)"
  else
    fine outbox_payment "оплаты обрабатываются"
  fi
  if ((${M[outbox_oldest_due_s]:-0} > 300)); then
    problem outbox_lag critical "очередь outbox стоит: ${M[outbox_due]} событий, старшее ждёт $((${M[outbox_oldest_due_s]} / 60)) мин"
  else
    fine outbox_lag "очередь outbox движется"
  fi
  if ((${M[outbox_retrying]:-0} > 0)); then
    problem outbox_retry warning "событий outbox на повторах (5+ попыток): ${M[outbox_retrying]} — смотреть outbox_handler_failed в логах сервера"
  else
    fine outbox_retry "повторов outbox нет"
  fi
  if ((${M[notify_queued_10m]:-0} > 0 || ${M[notify_failed_1h]:-0} >= 5)); then
    problem notify_queue warning "уведомления: в очереди дольше 10 мин — ${M[notify_queued_10m]:-0}, не доставлено за час — ${M[notify_failed_1h]:-0} (бот, прокси Telegram, Web Push)"
  else
    fine notify_queue "уведомления доставляются"
  fi
  if ((${M[receipts_stuck]:-0} > 0)); then
    problem receipts warning "чеков не пробито дольше 15 минут: ${M[receipts_stuck]} (54-ФЗ: ККТ клуба или ЮKassa)"
  else
    fine receipts "очередь чеков пуста"
  fi
  if ((${M[receipts_failed_24h]:-0} > 0)); then
    problem receipts_failed warning "чеков с ошибкой за сутки: ${M[receipts_failed_24h]}"
  else
    fine receipts_failed "ошибок чеков за сутки нет"
  fi
  if ((${M[yookassa_alarms_15m]:-0} > 0)); then
    problem yookassa_alarms warning "тревоги по оплатам ЮKassa за 15 минут: ${M[yookassa_alarms_15m]} (вебхук не пришёл, расхождение, возврат)"
  else
    fine yookassa_alarms "тревог по оплатам нет"
  fi
  if ((${M[alarms_critical_open_30m]:-0} > 0)); then
    problem alarms_open warning "критичные тревоги клубов без реакции дольше 30 минут: ${M[alarms_critical_open_30m]}"
  else
    fine alarms_open "критичные тревоги клубов приняты"
  fi
  if ((${M[wal_archive_failing]:-0} > 0)); then
    problem wal_archive critical "архив WAL не пишется (archive_command): бэкап на момент времени не растёт, диск заполняется"
  elif ((${M[wal_last_archived_s]:--1} > 3600)); then
    problem wal_archive warning "архив WAL не обновлялся $((${M[wal_last_archived_s]} / 60)) мин"
  else
    fine wal_archive "архив WAL пишется"
  fi
}

check_logs() {
  local logs n
  logs=$(bl_compose logs --since 5m --no-color --no-log-prefix server 2>/dev/null || true)
  n=$(grep -cE '"msg":"(yookassa_error|payment_reconcile_failed|refund_reconcile_failed|payment_link_failed)"' <<<"$logs" || true)
  if ((n >= 3)); then
    problem yookassa_errors warning "ошибок запросов к ЮKassa за 5 минут: $n (logs server: yookassa_error)"
  else
    fine yookassa_errors "запросы к ЮKassa без ошибок"
  fi
  n=$(grep -cE '"msg":"(mqtt_disconnected|mqtt_error)"' <<<"$logs" || true)
  if ((n > 0)); then
    problem mqtt_bridge warning "мост MQTT сервера терял связь с брокером за 5 минут: $n раз"
  else
    fine mqtt_bridge "мост MQTT на связи"
  fi
  n=$(grep -cE '"msg":"(db_pool_error|db_error|outbox_drain_failed|http_unhandled)"' <<<"$logs" || true)
  if ((n >= 5)); then
    problem server_errors warning "ошибок сервера за 5 минут: $n (db_error, outbox_drain_failed, http_unhandled)"
  else
    fine server_errors "ошибок сервера нет"
  fi
}

check_disk() {
  local p pct worst=0 where='' mem_avail mem_total
  for p in / /var/lib/docker "$BL_STATE_DIR"; do
    [[ -d $p ]] || continue
    pct=$(df -P "$p" | awk 'NR==2 {gsub("%","",$5); print $5}')
    if ((pct > worst)); then worst=$pct where=$p; fi
  done
  if ((worst >= CRIT_PCT)); then
    problem disk critical "диск $where занят на $worst %: база и архив WAL остановятся при 100 %"
  elif ((worst >= WARN_PCT)); then
    problem disk warning "диск $where занят на $worst %"
  else
    fine disk "место на диске есть ($worst %)"
  fi
  mem_total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  mem_avail=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  if ((mem_avail * 100 / mem_total < 10)); then
    problem memory warning "свободной памяти $((mem_avail / 1024)) МБ из $((mem_total / 1024)) МБ"
  else
    fine memory "память в норме"
  fi
}

check_backups() {
  local now age f n
  now=$(date +%s)
  f="$BL_STATE_DIR/backup/last-base-ok"
  age=$((now - $(cat "$f" 2>/dev/null || echo 0)))
  if ((age > 26 * 3600)); then
    problem backup_base critical "ежедневного бэкапа базы не было $((age / 3600)) ч (billiardum-backup.service)"
  else
    fine backup_base "ежедневный бэкап базы есть"
  fi
  f="$BL_STATE_DIR/backup/last-wal-ok"
  age=$((now - $(cat "$f" 2>/dev/null || echo 0)))
  n=$(find "$BL_STATE_DIR/wal-archive" "$BL_STATE_DIR/wal-outgoing" -maxdepth 1 -type f ! -name '*.part' ! -name '.*' 2>/dev/null | wc -l)
  if ((age > 20 * 60 || n > 50)); then
    problem backup_wal warning "WAL не уходит в хранилище: последняя отправка $((age / 60)) мин назад, ждут $n файлов (billiardum-wal-push.service)"
  else
    fine backup_wal "WAL уходит в хранилище"
  fi
}

main() {
  mkdir -p "$BL_STATE_DIR/monitor"
  exec 9>"$BL_STATE_DIR/monitor/lock"
  flock -n 9 || exit 0
  check_external
  if [[ $MODE == all ]]; then
    check_containers || true
    check_db || true
    check_logs
    check_disk
    check_backups
  fi
  date +%s >"$BL_STATE_DIR/monitor/last-run"
}

# Подключённый через source (тесты) — только функции.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main; fi
