#!/usr/bin/env bash
# Создаёт /etc/billiardum/prod.env по deploy/prod/.env.prod.example (первая установка, RUNBOOK §4.3):
# пароли базы и брокера, SECRETS_ENC_KEY, пара VAPID, секрет вебхука Telegram и ключ проверки
# восстановления — случайные; остальное — из образца. Уже существующий файл не трогает:
# только дописывает недостающие переменные из образца (пустыми или со значением образца).
# Значения не печатаются — только длина. Нужны openssl, age-keygen.
#
#   sudo deploy/prod/bin/gen-env.sh [путь, по умолчанию /etc/billiardum/prod.env]

set -euo pipefail
ROOT=$(cd "$(dirname "$(readlink -f "$0")")/../../.." && pwd)
EXAMPLE="$ROOT/deploy/prod/.env.prod.example"
OUT=${1:-/etc/billiardum/prod.env}

command -v openssl >/dev/null || { echo "нужен openssl" >&2; exit 1; }
command -v age-keygen >/dev/null || { echo "нужен age (apt install age)" >&2; exit 1; }

rand() {
  local s
  s=$(openssl rand -base64 120 | tr -dc 'A-Za-z0-9')
  ((${#s} >= $1)) || { echo "gen-env: мало случайных символов" >&2; exit 1; }
  printf '%s' "${s:0:$1}"
}
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

vapid() {
  local key
  key=$(openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null)
  # Закрытый — 32 байта d, открытый — 65 байт точки без сжатия (последние байты DER).
  VAPID_PRIVATE_KEY=$(openssl ec -outform DER 2>/dev/null <<<"$key" | tail -c +8 | head -c 32 | b64url)
  VAPID_PUBLIC_KEY=$(openssl ec -pubout -outform DER 2>/dev/null <<<"$key" | tail -c 65 | b64url)
}

declare -A GEN=()
GEN[POSTGRES_PASSWORD]=$(rand 40)
GEN[DB_APP_PASSWORD]=$(rand 40)
GEN[MQTT_ADMIN_PASSWORD]=$(rand 32)
GEN[MQTT_SERVER_PASSWORD]=$(rand 32)
GEN[SECRETS_ENC_KEY]=$(openssl rand -base64 32)
GEN[TELEGRAM_WEBHOOK_SECRET]=$(rand 48)
vapid
GEN[VAPID_PRIVATE_KEY]=$VAPID_PRIVATE_KEY
GEN[VAPID_PUBLIC_KEY]=$VAPID_PUBLIC_KEY
restore_key=$(age-keygen 2>/dev/null)
GEN[BACKUP_RESTORE_AGE_KEY]=$(grep '^AGE-SECRET-KEY-' <<<"$restore_key")
restore_pub=$(grep -o 'age1[0-9a-z]*' <<<"$restore_key" | head -n1)

umask 077
mkdir -p "$(dirname "$OUT")"
tmp=$(mktemp "$OUT.XXXXXX")
trap 'rm -f "$tmp"' EXIT
[[ -f $OUT ]] && cp "$OUT" "$tmp"

added=0
while IFS= read -r line || [[ -n $line ]]; do
  [[ $line =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
  key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
  grep -q "^$key=" "$tmp" 2>/dev/null && continue
  if [[ -n ${GEN[$key]:-} ]]; then
    value=${GEN[$key]}
    echo "$key: создан, длина ${#value}"
  fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  added=$((added + 1))
done <"$EXAMPLE"

# Ключ проверки восстановления — среди получателей бэкапа (ключ Андрея добавляет он сам).
if grep -q '^BACKUP_AGE_RECIPIENTS=$' "$tmp" && [[ -n $restore_pub ]] && grep -q "^BACKUP_RESTORE_AGE_KEY=${GEN[BACKUP_RESTORE_AGE_KEY]}$" "$tmp"; then
  sed -i "s|^BACKUP_AGE_RECIPIENTS=$|BACKUP_AGE_RECIPIENTS=$restore_pub|" "$tmp"
  echo "BACKUP_AGE_RECIPIENTS: добавлен открытый ключ проверки восстановления; добавьте через пробел ключ Андрея"
fi

chmod 600 "$tmp"
mv -f "$tmp" "$OUT"
trap - EXIT
echo "$OUT: добавлено переменных $added. Заполните пустые (домен, бот, прокси, хранилище, ключи age Андрея) и запустите preflight.sh."
