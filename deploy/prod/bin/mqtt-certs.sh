#!/usr/bin/env bash
# CA платформы и сертификат брокера MQTT для прода (протокол §2: TLS 1.2+, ECDSA P-256,
# CA закреплён в прошивке — kMqttCaPem в firmware/src/certs.local.h).
#
# Запускать НЕ на сервере, а на доверенном ноутбуке Андрея (OpenSSL 3):
#   deploy/prod/bin/mqtt-certs.sh init-ca ~/billiardum-ca
#       ca.key (зашифрован паролем, спросит дважды) и ca.crt на 20 лет. ca.key не покидает
#       ноутбук и резервную копию Андрея; потеря ca.key = перепрошивка всех контроллеров
#       при смене сертификата брокера.
#   deploy/prod/bin/mqtt-certs.sh issue ~/billiardum-ca ./mqtt-out mqtt.billiardum.ru
#       mqtt.key и mqtt.crt на 5 лет, рядом копия ca.crt. Имена: mqtt.{домен} — контроллерам,
#       mosquitto — серверу по сети Compose, localhost — проверке здоровья внутри контейнера.
# На сервер — только ca.crt, mqtt.crt, mqtt.key в /etc/billiardum/mqtt (RUNBOOK §4.4).
#
# Срок сертификата брокера контроллер без SNTP не проверяет, а сервер (Node) — проверяет:
# замена за 90 дней до конца (preflight.sh и монитор предупреждают), без перезапуска брокера —
# deploy/prod/bin/mqtt-reload.sh. Новый сертификат того же CA контроллеры принимают сами.

set -euo pipefail

CA_DAYS=7305    # 20 лет
LEAF_DAYS=1826  # 5 лет

die() { echo "mqtt-certs: $*" >&2; exit 1; }

init_ca() {
  local dir=$1
  [[ -e $dir/ca.key ]] && die "$dir/ca.key уже есть — CA не пересоздаётся (контроллеры доверяют ему)"
  mkdir -p "$dir"
  chmod 700 "$dir"
  umask 077
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -aes-256-cbc -out "$dir/ca.key"
  openssl req -x509 -new -key "$dir/ca.key" -sha256 -days "$CA_DAYS" \
    -subj '/O=Billiardum/CN=Billiardum Platform MQTT CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -addext 'subjectKeyIdentifier=hash' \
    -out "$dir/ca.crt"
  chmod 644 "$dir/ca.crt"
  echo "CA: $dir/ca.crt (в прошивку и на сервер), $dir/ca.key (только офлайн)."
  openssl x509 -in "$dir/ca.crt" -noout -subject -enddate -fingerprint -sha256
}

issue() {
  local ca=$1 out=$2 host=$3 tmp
  [[ -f $ca/ca.key && -f $ca/ca.crt ]] || die "нет $ca/ca.key или $ca/ca.crt (сначала init-ca)"
  [[ $host =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "имя брокера — хост без схемы и порта"
  mkdir -p "$out"
  chmod 700 "$out"
  umask 077
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$out/mqtt.key"
  openssl req -new -key "$out/mqtt.key" -subj "/O=Billiardum/CN=$host" -out "$tmp/mqtt.csr"
  cat >"$tmp/ext.cnf" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:mosquitto,DNS:localhost,DNS:$host
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF
  openssl x509 -req -in "$tmp/mqtt.csr" -CA "$ca/ca.crt" -CAkey "$ca/ca.key" -CAcreateserial \
    -CAserial "$tmp/ca.srl" -sha256 -days "$LEAF_DAYS" -extfile "$tmp/ext.cnf" -out "$out/mqtt.crt"
  cp "$ca/ca.crt" "$out/ca.crt"
  chmod 600 "$out/mqtt.key"
  chmod 644 "$out/mqtt.crt" "$out/ca.crt"
  openssl verify -CAfile "$out/ca.crt" "$out/mqtt.crt"
  openssl x509 -in "$out/mqtt.crt" -noout -subject -enddate -ext subjectAltName
  echo "На сервер: $out/ca.crt, $out/mqtt.crt, $out/mqtt.key → /etc/billiardum/mqtt/ (ca.key — нет)."
}

case ${1:-} in
  init-ca) [[ $# == 2 ]] || die "init-ca <папка CA>"; init_ca "$2" ;;
  issue) [[ $# == 4 ]] || die "issue <папка CA> <папка вывода> <имя брокера>"; issue "$2" "$3" "$4" ;;
  *) die "init-ca <папка CA> | issue <папка CA> <папка вывода> <имя брокера>" ;;
esac
