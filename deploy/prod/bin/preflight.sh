#!/usr/bin/env bash
# Проверка сервера и настроек прода перед первой установкой и каждым выпуском (deploy.sh
# вызывает сам). Ничего не меняет. Секреты не печатает — только длину.
#   deploy/prod/bin/preflight.sh            — всё
#   deploy/prod/bin/preflight.sh --env-only — только файл настроек (без Docker и сертификатов)
# Код выхода 1 — есть ошибки (строки «ОШИБКА»), предупреждения выход не меняют.

. "$(dirname "$(readlink -f "$0")")/lib.sh"
bl_load_env

ENV_ONLY=0
[[ ${1:-} == --env-only ]] && ENV_ONLY=1
errors=0
err() { printf 'ОШИБКА: %s\n' "$*"; errors=$((errors + 1)); }
warn() { printf 'внимание: %s\n' "$*"; }
ok() { printf 'ок: %s\n' "$*"; }

# --- Обязательные значения ---------------------------------------------------------------
required=(
  BL_DOMAIN ACME_EMAIL SITE_ORIGIN MQTT_PUBLIC_URL MAINTENANCE_WINDOW MAINTENANCE_TZ
  SERVER_WEB_SUBNET SERVER_WEB_SERVER_IP SERVER_WEB_CADDY_IP
  SITE_API_SUBNET SITE_API_SERVER_IP SITE_API_SITE_IP
  SITE_WEB_SUBNET SITE_WEB_CADDY_IP SITE_WEB_SITE_IP
  DB_NET_SUBNET EDGE_WEB_SUBNET EDGE_MQTT_SUBNET
  TRUSTED_PROXY_CIDRS PUBLIC_API_TRUSTED_CIDRS SITE_TRUSTED_PROXIES YOOKASSA_WEBHOOK_IPS
  POSTGRES_PASSWORD DB_APP_PASSWORD
  MQTT_ADMIN_USER MQTT_ADMIN_PASSWORD MQTT_SERVER_USER MQTT_SERVER_PASSWORD
  SECRETS_ENC_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT
  BACKUP_RCLONE_REMOTE BACKUP_AGE_RECIPIENTS BACKUP_RESTORE_AGE_KEY BACKUP_ENV_AGE_RECIPIENT
  MONITOR_TELEGRAM_CHAT_IDS
)
for v in "${required[@]}"; do [[ -n ${!v:-} ]] || err "$v не задана"; done

# Переменные разработки в проде не нужны: сервер их и так не слушает при NODE_ENV=production,
# но их присутствие значит, что файл скопирован с разработки.
for v in ALLOW_DEV_LOGIN DEV_ALLOW_ANY_MINUTES DEV_LAN_HOST YOOKASSA_EMU_SHOP_ID YOOKASSA_EMU_SECRET \
  YOOKASSA_EMU_SHOP_TEST YOOKASSA_EMU_SHOP_FISCALIZATION SIM_DEVICES_FILE DATABASE_ADMIN_URL NODE_ENV YOOKASSA_API_URL; do
  [[ -z ${!v:-} ]] || err "$v — переменная разработки, в файле прода её быть не должно"
done

# --- Секреты: длина и формат (значения не печатаются) ------------------------------------
min_len() { local n; n=$(bl_len "$1"); if ((n < $2)); then err "$1: длина $n, нужно от $2"; else ok "$1: длина $n"; fi; }
min_len POSTGRES_PASSWORD 32
min_len DB_APP_PASSWORD 32
min_len MQTT_ADMIN_PASSWORD 24
min_len MQTT_SERVER_PASSWORD 24
[[ ${POSTGRES_PASSWORD:-} != "${DB_APP_PASSWORD:-}" ]] || err "POSTGRES_PASSWORD и DB_APP_PASSWORD совпадают"
[[ ${MQTT_ADMIN_PASSWORD:-} != "${MQTT_SERVER_PASSWORD:-}" ]] || err "MQTT_ADMIN_PASSWORD и MQTT_SERVER_PASSWORD совпадают"
for v in POSTGRES_PASSWORD DB_APP_PASSWORD; do
  [[ ${!v:-} =~ ^[A-Za-z0-9_-]*$ ]] || err "$v: только [A-Za-z0-9_-] (пароль входит в адрес postgres://)"
done
if [[ -n ${SECRETS_ENC_KEY:-} ]]; then
  n=$( (printf '%s' "$SECRETS_ENC_KEY" | base64 -d 2>/dev/null || true) | wc -c)
  [[ $n == 32 ]] || err "SECRETS_ENC_KEY: base64 от 32 байт (сейчас $n байт)"
fi
if [[ -n ${VAPID_PUBLIC_KEY:-} ]]; then
  [[ ${#VAPID_PUBLIC_KEY} == 87 && ${#VAPID_PRIVATE_KEY} == 43 ]] || err "VAPID: открытый ключ — 65 байт, закрытый — 32 байта (base64url)"
fi
if [[ -n ${TELEGRAM_BOT_TOKEN:-} ]]; then
  [[ -n ${TELEGRAM_PROXY_URL:-} ]] || err "TELEGRAM_BOT_TOKEN без TELEGRAM_PROXY_URL: api.telegram.org с сервера закрыт"
  [[ ${TELEGRAM_PROXY_URL:-} =~ ^(http|https|socks5|socks5h):// ]] || err "TELEGRAM_PROXY_URL — http://, https:// или socks5://"
  [[ ${TELEGRAM_WEBHOOK_SECRET:-} =~ ^[A-Za-z0-9_-]{16,256}$ ]] || err "TELEGRAM_WEBHOOK_SECRET — 16–256 символов [A-Za-z0-9_-]"
  [[ -n ${TELEGRAM_BOT_USERNAME:-} ]] || err "TELEGRAM_BOT_USERNAME не задана"
else
  warn "TELEGRAM_BOT_TOKEN пуст: вход через Telegram и тревоги Андрею в Telegram выключены"
fi
[[ -n ${MAX_BOT_TOKEN:-} ]] || warn "MAX_BOT_TOKEN пуст (адаптер MAX пока заглушка, server/notify/max.mjs)"
if [[ -n ${PLATFORM_YOOKASSA_SHOP_ID:-}${PLATFORM_YOOKASSA_SECRET:-} ]]; then
  [[ -n ${PLATFORM_YOOKASSA_SHOP_ID:-} && -n ${PLATFORM_YOOKASSA_SECRET:-} ]] || err "PLATFORM_YOOKASSA_SHOP_ID и PLATFORM_YOOKASSA_SECRET — обе или ни одной"
  [[ ${PLATFORM_YOOKASSA_SECRET:-} == live_* ]] || warn "PLATFORM_YOOKASSA_SECRET не боевой (live_…)"
  [[ ${PLATFORM_YOOKASSA_SECRET:-} != *emu* && ${PLATFORM_YOOKASSA_SECRET:-} != *dev_only* ]] || err "PLATFORM_YOOKASSA_SECRET — ключ эмулятора разработки"
  ok "PLATFORM_YOOKASSA_SECRET: длина $(bl_len PLATFORM_YOOKASSA_SECRET)"
  [[ ${PLATFORM_VAT_CODE:-1} =~ ^([1-9]|1[0-2])$ ]] || err "PLATFORM_VAT_CODE — 1…12"
  [[ ${PLATFORM_TAX_SYSTEM_CODE:-1} =~ ^[1-6]$ ]] || err "PLATFORM_TAX_SYSTEM_CODE — 1…6"
  [[ -z ${PLATFORM_BILLING_RETURN_URL:-} || ${PLATFORM_BILLING_RETURN_URL} == "https://${BL_DOMAIN:-}/"* ]] || err "PLATFORM_BILLING_RETURN_URL — на https://BL_DOMAIN/…"
else
  warn "магазин платформы не задан: подписка клубов (M5.3) отвечает 503 billing_unavailable"
fi
[[ ${BACKUP_RESTORE_AGE_KEY:-} == AGE-SECRET-KEY-1* ]] || err "BACKUP_RESTORE_AGE_KEY — ключ age (AGE-SECRET-KEY-1…)"
for r in ${BACKUP_AGE_RECIPIENTS:-} ${BACKUP_ENV_AGE_RECIPIENT:-}; do
  [[ $r =~ ^age1[0-9a-z]{58}$ ]] || err "получатель age «${r:0:8}…» — открытый ключ age1…"
done
[[ $(wc -w <<<"${BACKUP_AGE_RECIPIENTS:-}") -ge 2 ]] || err "BACKUP_AGE_RECIPIENTS: два ключа — Андрея (офлайн) и проверки восстановления"
if [[ -n ${BACKUP_ENV_AGE_RECIPIENT:-} && " ${BACKUP_AGE_RECIPIENTS:-} " != *" $BACKUP_ENV_AGE_RECIPIENT "* ]]; then
  warn "BACKUP_ENV_AGE_RECIPIENT не среди BACKUP_AGE_RECIPIENTS: проверьте, что это ключ Андрея"
fi

# --- Домен и адреса ----------------------------------------------------------------------
[[ ${BL_DOMAIN:-} =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || err "BL_DOMAIN — имя хоста без схемы и порта"
[[ ${SITE_ORIGIN:-} == "https://${BL_DOMAIN:-}" ]] || warn "SITE_ORIGIN не https://BL_DOMAIN (канонические ссылки сайта)"
[[ ${MQTT_PUBLIC_URL:-} =~ ^mqtts://[a-z0-9.-]+:8883$ ]] || err "MQTT_PUBLIC_URL — mqtts://хост:8883"
[[ ${BL_SITE_NOINDEX:-} != 1 ]] || warn "BL_SITE_NOINDEX=1: сайт закрыт от индексации (так — только для стенда)"
[[ ${YANDEX_METRIKA_ID:-} =~ ^([0-9]{4,12})?$ ]] || err "YANDEX_METRIKA_ID — только цифры"

# --- Сети и доверенные прокси (decisions №70) --------------------------------------------
ip2int() { local IFS=. a b c d; read -r a b c d <<<"$1"; printf '%s' $(((a << 24) | (b << 16) | (c << 8) | d)); }
in_subnet() {
  local ip=$1 net=${2%/*} bits=${2#*/} mask
  [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ && $2 =~ ^[0-9.]+/[0-9]+$ ]] || return 1
  mask=$(((0xffffffff << (32 - bits)) & 0xffffffff))
  [[ $(($(ip2int "$ip") & mask)) == $(($(ip2int "$net") & mask)) ]]
}
check_ip() { in_subnet "${!1:-}" "${!2:-}" || err "$1 (${!1:-}) не в $2 (${!2:-})"; }
check_ip SERVER_WEB_SERVER_IP SERVER_WEB_SUBNET
check_ip SERVER_WEB_CADDY_IP SERVER_WEB_SUBNET
check_ip SITE_API_SERVER_IP SITE_API_SUBNET
check_ip SITE_API_SITE_IP SITE_API_SUBNET
check_ip SITE_WEB_CADDY_IP SITE_WEB_SUBNET
check_ip SITE_WEB_SITE_IP SITE_WEB_SUBNET
for v in SERVER_WEB_SUBNET SITE_API_SUBNET SITE_WEB_SUBNET; do
  [[ ${!v:-} == */29 ]] || err "$v — сеть /29: в ней только пара прокси → сервис"
done
sorted() { tr ',' '\n' <<<"$1" | sed '/^$/d' | sort | paste -sd, -; }
want_trusted=$(sorted "${SERVER_WEB_CADDY_IP:-}/32,${SITE_API_SITE_IP:-}/32")
[[ $(sorted "${TRUSTED_PROXY_CIDRS:-}") == "$want_trusted" ]] ||
  err "TRUSTED_PROXY_CIDRS — ровно адреса Caddy и сайта: $want_trusted (сейчас ${TRUSTED_PROXY_CIDRS:-пусто})"
[[ ${PUBLIC_API_TRUSTED_CIDRS:-} == "${SITE_API_SITE_IP:-}/32" ]] ||
  err "PUBLIC_API_TRUSTED_CIDRS — только адрес сайта ${SITE_API_SITE_IP:-}/32 (адрес Caddy снял бы лимит всем браузерам)"
[[ ${SITE_TRUSTED_PROXIES:-} == "${SITE_WEB_CADDY_IP:-}/32" ]] ||
  err "SITE_TRUSTED_PROXIES — только адрес Caddy ${SITE_WEB_CADDY_IP:-}/32"
[[ ${MAINTENANCE_WINDOW:-} =~ ^[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]$ ]] || err "MAINTENANCE_WINDOW — ЧЧ:ММ-ЧЧ:ММ по MAINTENANCE_TZ"
[[ -f /usr/share/zoneinfo/${MAINTENANCE_TZ:-нет} ]] || err "MAINTENANCE_TZ — пояс IANA (Europe/Moscow)"

if ((ENV_ONLY)); then
  ((errors == 0)) && echo "Файл настроек в порядке." || echo "Ошибок: $errors."
  exit $((errors > 0))
fi

# --- Сертификаты брокера (CA платформы) --------------------------------------------------
d=$BL_MQTT_CERTS_DIR
for f in ca.crt mqtt.crt mqtt.key; do [[ -f $d/$f ]] || err "нет $d/$f (deploy/prod/bin/mqtt-certs.sh)"; done
[[ ! -e $d/ca.key ]] || err "$d/ca.key на сервере: закрытый ключ CA хранится только офлайн у Андрея"
if [[ -f $d/mqtt.key ]]; then
  [[ $(stat -c '%a' "$d/mqtt.key") == 600 ]] || err "$d/mqtt.key — права 0600"
fi
if [[ -f $d/ca.crt && -f $d/mqtt.crt ]]; then
  openssl verify -CAfile "$d/ca.crt" "$d/mqtt.crt" >/dev/null 2>&1 && ok "сертификат брокера подписан CA платформы" || err "mqtt.crt не подписан ca.crt"
  mqtt_host=${MQTT_PUBLIC_URL#mqtts://}
  mqtt_host=${mqtt_host%:*}
  san=$(openssl x509 -in "$d/mqtt.crt" -noout -ext subjectAltName 2>/dev/null || true)
  [[ $san == *"DNS:mosquitto"* ]] || err "в mqtt.crt нет имени mosquitto (по нему ходит сервер)"
  [[ $san == *"DNS:localhost"* ]] || err "в mqtt.crt нет имени localhost (проверка здоровья брокера)"
  [[ $san == *"DNS:$mqtt_host"* ]] || err "в mqtt.crt нет имени $mqtt_host (MQTT_PUBLIC_URL)"
  text=$(openssl x509 -in "$d/mqtt.crt" -noout -text 2>/dev/null || true)
  [[ $text == *prime256v1* || $text == *P-256* ]] || err "mqtt.crt — не ECDSA P-256 (протокол §2)"
  openssl x509 -in "$d/mqtt.crt" -noout -checkend $((90 * 86400)) >/dev/null || err "mqtt.crt истекает меньше чем через 90 дней"
  if [[ -f $d/mqtt.key ]]; then
    a=$(openssl x509 -in "$d/mqtt.crt" -noout -pubkey | sha256sum)
    b=$(openssl pkey -in "$d/mqtt.key" -pubout 2>/dev/null | sha256sum)
    [[ $a == "$b" ]] || err "mqtt.key не от mqtt.crt"
  fi
fi

# --- Сервер ------------------------------------------------------------------------------
for t in docker age rclone openssl curl; do command -v "$t" >/dev/null || err "нет программы $t (RUNBOOK §4.1)"; done
if command -v docker >/dev/null; then
  docker compose version >/dev/null 2>&1 || err "нет docker compose (плагин Compose v2)"
  live=$(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null || true)
  [[ $live == true ]] || err "Docker без live-restore: обновление Docker перезапустит брокер (RUNBOOK §4.1)"
  if [[ -f /etc/docker/daemon.json ]] && grep -q '"userland-proxy"[[:space:]]*:[[:space:]]*false' /etc/docker/daemon.json; then
    ok "userland-proxy выключен: Caddy и брокер видят настоящие адреса клиентов"
  else
    warn "userland-proxy не выключен (/etc/docker/daemon.json): для IPv6 Caddy увидит адрес шлюза Docker"
  fi
fi
if command -v timedatectl >/dev/null; then
  [[ $(timedatectl show -p NTPSynchronized --value 2>/dev/null) == yes ]] || warn "часы не синхронизированы (chrony/timesyncd)"
fi
for p in "$BL_STATE_DIR" "$BL_STATE_DIR/wal-archive" "$BL_STATE_DIR/factory"; do
  [[ -d $p ]] || err "нет папки $p (RUNBOOK §4.2)"
done
if command -v df >/dev/null && [[ -d $BL_STATE_DIR ]]; then
  used=$(df -P "$BL_STATE_DIR" | awk 'NR==2 {gsub("%","",$5); print $5}')
  ((used < 80)) || warn "диск $BL_STATE_DIR занят на $used %"
fi

if ((errors == 0)); then echo "Проверка пройдена."; else echo "Ошибок: $errors."; fi
exit $((errors > 0))
