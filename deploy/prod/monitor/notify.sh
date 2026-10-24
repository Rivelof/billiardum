# shellcheck shell=bash
# Тревоги Андрею (PRODUCT §20): через бота платформы, а не внешние сервисы.
#   * Telegram — тот же бот, что у сервера (TELEGRAM_BOT_TOKEN), только через прокси
#     TELEGRAM_PROXY_URL: api.telegram.org с сервера закрыт. Получатели — MONITOR_TELEGRAM_CHAT_IDS
#     (id чатов Андрея с ботом, через запятую).
#   * MAX — основной канал продукта, но адаптер сервера пока заглушка (server/notify/max.mjs:
#     нет документации API). MONITOR_MAX_USER_IDS зарезервирована, сообщения туда не уходят.
#   * Всегда — журнал systemd (journalctl -t billiardum-alert).
# Скрипты монитора не ходят через сервер намеренно: тревога должна дойти, когда сервер или база
# лежат. Текст тревоги — без персональных данных (только числа, имена сервисов и клубов).
# Подключается после lib.sh и bl_load_env.

bl_json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/}
  s=${s//$'\t'/ }
  printf '"%s"' "$s"
}

# Отправляет текст всем получателям. 0 — дошло хотя бы до одного.
bl_notify_send() {
  local text="Бильярдум · прод · $(hostname -s)"$'\n'"$1" chat delivered=1 body
  logger -t billiardum-alert -p user.warning -- "${1//$'\n'/ | }" 2>/dev/null || true
  if [[ -z ${TELEGRAM_BOT_TOKEN:-} || -z ${TELEGRAM_PROXY_URL:-} ]]; then
    bl_log "тревога не отправлена: нет TELEGRAM_BOT_TOKEN или TELEGRAM_PROXY_URL (только журнал)"
    return 1
  fi
  for chat in ${MONITOR_TELEGRAM_CHAT_IDS//,/ }; do
    [[ $chat =~ ^-?[0-9]{1,20}$ ]] || { bl_log "MONITOR_TELEGRAM_CHAT_IDS: «$chat» не id чата"; continue; }
    body="{\"chat_id\":$chat,\"text\":$(bl_json_str "${text:0:3900}"),\"disable_web_page_preview\":true}"
    # Токен — в конфиге curl через дескриптор, не в аргументах (ps его не покажет).
    if curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
      -K <(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\nproxy = "%s"\n' "$TELEGRAM_BOT_TOKEN" "$TELEGRAM_PROXY_URL") \
      -H 'content-type: application/json' --data-binary "$body" 2>/dev/null | grep -qx 200; then
      delivered=0
    else
      bl_log "Telegram: тревога в чат …${chat: -4} не доставлена"
    fi
  done
  if [[ -n ${MONITOR_MAX_USER_IDS:-} ]]; then
    bl_log "MAX: адаптер сервера ещё заглушка (server/notify/max.mjs), тревога ушла только в Telegram"
  fi
  return $delivered
}

# Проблема key: отправить сразу, потом напоминать раз в MONITOR_REPEAT_MIN минут (60).
# Уровень: critical | warning. Возвращает 0.
bl_alert() {
  local key=$1 level=$2 text=$3 dir="$BL_STATE_DIR/monitor/alerts" file now since mark
  mkdir -p "$dir"
  file="$dir/$key"
  now=$(date +%s)
  mark='[ВНИМАНИЕ]'
  [[ $level == critical ]] && mark='[КРИТИЧНО]'
  if [[ -f $file ]]; then
    since=$(head -n1 "$file")
    (((now - $(stat -c %Y "$file")) >= ${MONITOR_REPEAT_MIN:-60} * 60)) || return 0
    bl_notify_send "$mark Всё ещё: $text (с $(TZ=${MONITOR_TZ:-Europe/Moscow} date -d "@$since" '+%d.%m %H:%M'))" || true
    touch "$file"
  else
    bl_notify_send "$mark $text" || true
    printf '%s\n' "$now" >"$file"
  fi
  return 0
}

# Проблема key ушла: сообщить, если о ней сообщали.
bl_resolve() {
  local key=$1 text=$2 file="$BL_STATE_DIR/monitor/alerts/$1"
  [[ -f $file ]] || return 0
  bl_notify_send "[НОРМА] Восстановлено: $text" || true
  rm -f "$file"
}
