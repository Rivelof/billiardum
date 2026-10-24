#!/usr/bin/env bash
# Новый сертификат брокера или правка deploy/prod/mosquitto/mosquitto.conf — без перезапуска
# Mosquitto (CLAUDE.md), можно в часы работы клубов (RUNBOOK §8):
#   1. сертификаты из /etc/billiardum/mqtt копируются в контейнер с правами пользователя mosquitto;
#   2. SIGHUP: брокер перечитывает настройки и сертификаты, подключённые клиенты не отключаются.
# Проверено на Mosquitto 2.0: после SIGHUP новые подключения получают новый сертификат.
# Смена listener, порта или плагина SIGHUP не применяет — это перезапуск, только в окне.

. "$(dirname "$(readlink -f "$0")")/lib.sh"
bl_load_env

d=$BL_MQTT_CERTS_DIR
openssl verify -CAfile "$d/ca.crt" "$d/mqtt.crt" >/dev/null || bl_die "mqtt.crt не подписан ca.crt — ничего не применено"
bl_compose exec -T mosquitto sh -ec '
  cp /certs/ca.crt /certs/mqtt.crt /certs/mqtt.key /mosquitto/certs/
  chown mosquitto:mosquitto /mosquitto/certs/*
  chmod 600 /mosquitto/certs/mqtt.key'
bl_compose kill -s HUP mosquitto
bl_log "брокер перечитал настройки и сертификаты (SIGHUP)"
