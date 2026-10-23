#!/usr/bin/env bash
# PoC-батарея M5.1 «Подключение клуба без выезда». Pentester.
#
# Запуск:  BASE=https://localhost:8443 bash tests/security/m5/poc.sh
# Только локальный стенд. Телефоны +7999650xxxx, свои новые клубы.
# НЕ трогает столы 1–8 и клуб сида (на них работает тестер).
#
# Проверяет защиты (должны держаться) и одно наблюдение (нулевой тариф).
set -u
BASE=${BASE:-https://localhost:8443}
SP=$(mktemp -d)
trap 'rm -rf "$SP"' EXIT

login() { curl -sk -m 10 "$BASE/api/auth/dev" -X POST -H 'content-type: application/json' \
  -d "{\"phone\":\"$1\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }
req() { # req TOKEN METHOD PATH [BODY]
  local t=$1 m=$2 p=$3 b=${4:-}
  if [ -n "$b" ]; then
    curl -sk -m 15 -H "authorization: Bearer $t" -H 'content-type: application/json' \
      -X "$m" "$BASE$p" -d "$b" -w '  [%{http_code}]\n'
  else
    curl -sk -m 15 -H "authorization: Bearer $t" -X "$m" "$BASE$p" -w '  [%{http_code}]\n'
  fi
}
mkclub() { req "$1" POST /api/clubs "{\"name\":\"$2\",\"city_name\":\"Москва\",\"timezone\":\"Europe/Moscow\"}"; }
cid() { sed -n 's/.*"club_id":"\([^"]*\)".*/\1/p'; }

echo "### Вход (свои номера) ###"
# T1 — атакующий-владелец (новый номер без клубов), T2 — посторонний.
T1=$(login +79996500010); T2=$(login +79996500002)
echo "user1 token len=${#T1}, user2 token len=${#T2}"

echo; echo "### 1. Лимит 3 тестовых клубов (новый пользователь, 8 параллельно) ###"
TR=$(login +79996500009)
for i in $(seq 1 8); do mkclub "$TR" "Race $i" >"$SP/r$i" & done; wait
echo "создано:   $(grep -l club_id "$SP"/r* 2>/dev/null | wc -l)  (ожидается 3)"
echo "clubs_limit: $(grep -l clubs_limit "$SP"/r* 2>/dev/null | wc -l)  (ожидается 5)"

echo; echo "### рабочий клуб атакующего (user1) ###"
CLUB=$(mkclub "$T1" "Pentest M5" | cid); echo "CLUB=$CLUB"
RID=$(req "$T1" POST "/api/clubs/$CLUB/resources" '{"number":701,"kind":"pool"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'); echo "RID=$RID"

echo; echo "### 2. Подмена владельца / чужая карточка ###"
echo -n "listing_id чужой/несуществующий: "; mkclub_listing() { req "$T1" POST /api/clubs "{\"name\":\"X\",\"city_name\":\"Москва\",\"timezone\":\"Europe/Moscow\",\"listing_id\":\"11111111-1111-1111-1111-111111111111\"}"; }; mkclub_listing

echo; echo "### 3. Переход в live без чек-листа ###"
req "$T1" POST "/api/clubs/$CLUB/go-live" '{"accept_offer":true}'

echo; echo "### 4. Режимы без platform_admin ###"
echo -n "suspend: "; req "$T1" POST "/api/platform/clubs/$CLUB/suspend" '{"reason":"x"}'
echo -n "resume->test: "; req "$T1" POST "/api/platform/clubs/$CLUB/resume" '{"reason":"x","mode":"test"}'

echo; echo "### 5. Изоляция клубов: user2 без роли в клубе user1 ###"
echo -n "onboarding: "; req "$T2" GET "/api/clubs/$CLUB/onboarding"
echo -n "payment-settings (секрет): "; req "$T2" GET "/api/clubs/$CLUB/payment-settings"
echo -n "payment-settings/live: "; req "$T2" GET "/api/clubs/$CLUB/payment-settings/live"
echo -n "resources: "; req "$T2" GET "/api/clubs/$CLUB/resources"
echo -n "bind устройства: "; req "$T2" POST "/api/clubs/$CLUB/devices/bind" "{\"qr\":\"BLD1:00000000-0000-4000-8000-000000000001:ABCDEFGH1234\",\"resource_id\":\"$RID\"}"

echo; echo "### 6. Секрет магазина наружу не целиком (свежий клуб — маска null) ###"
req "$T1" GET "/api/clubs/$CLUB/payment-settings/live"

echo; echo "### 7. Разбор BLD1: инъекции и формат ###"
for QR in 'BLD2:00000000-0000-4000-8000-000000000001:ABCDEFGH' \
          'BLD1:not-a-uuid:ABCDEFGH' \
          'BLD1:00000000-0000-4000-8000-000000000001:AB' \
          "BLD1:00000000-0000-4000-8000-000000000001:ABCD';DROP--" ; do
  echo -n "[$QR]: "; req "$T1" POST "/api/clubs/$CLUB/devices/bind" "{\"qr\":\"$QR\",\"resource_id\":\"$RID\"}"
done

echo; echo "### 8. Перебор кода привязки (5 попыток + лимит device 6/мин) ###"
DEV=$(python3 -c "import uuid;print(uuid.uuid4())" 2>/dev/null || echo 11111111-2222-4333-8444-5555550c0de0)
req "$T1" POST "/api/clubs/$CLUB/devices/bind" "{\"device_id\":\"$DEV\",\"claim_code\":\"GoodCode123\",\"resource_id\":\"$RID\"}" >/dev/null
for i in 1 2 3 4 5 6; do
  echo -n "claim wrong#$i: "; curl -sk -m 12 -H 'content-type: application/json' "$BASE/api/devices/claim" \
    -X POST -d "{\"device_id\":\"$DEV\",\"claim_code\":\"WrongCode$i\"}" -w '  [%{http_code}]\n'
done
# 1..5 -> 403 forbidden (неверный код, окно закрывается на 5-й), 6-й -> 429 rate_limited (лимит 6/мин на device)

echo; echo "### 9. Импорт .xlsx: XXE, billion laughs, zip-бомба, zip-slip ###"
for k in xxe laughs bomb slip; do
  node "$(dirname "$0")/mkxlsx.mjs" "$k" "$SP/$k.xlsx" >/dev/null
  echo -n "[$k]: "
  curl -sk -m 25 -H "authorization: Bearer $T1" \
    -F "file=@$SP/$k.xlsx;type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" \
    -F "dry_run=1" "$BASE/api/clubs/$CLUB/catalog/import" -w '  [%{http_code}]\n'
done

echo; echo "### 10. Тарифы: отрицательная цена, дыра, НУЛЕВАЯ цена (наблюдение) ###"
echo -n "цена < 0: "; req "$T1" PUT "/api/clubs/$CLUB/tariffs" '{"rules":[{"kind":null,"days":[1,2,3,4,5,6,7],"from":"06:00","to":"06:00","price_per_hour_kopecks":-1,"min_minutes":30,"step_minutes":1}]}'
echo -n "дыра:     "; req "$T1" PUT "/api/clubs/$CLUB/tariffs" '{"rules":[{"kind":null,"days":[1,2,3,4,5,6,7],"from":"06:00","to":"18:00","price_per_hour_kopecks":10000,"min_minutes":30,"step_minutes":1}]}'
echo -n "цена = 0 (НАБЛЮДЕНИЕ, принимается): "; req "$T1" PUT "/api/clubs/$CLUB/tariffs" '{"rules":[{"kind":null,"days":[1,2,3,4,5,6,7],"from":"06:00","to":"06:00","price_per_hour_kopecks":0,"min_minutes":30,"step_minutes":1}]}' | head -c 80; echo

echo; echo "### 11. Ресепшн/посторонний не меняет зал (user2 без роли) ###"
echo -n "user2 POST resources: "; req "$T2" POST "/api/clubs/$CLUB/resources" '{"number":9,"kind":"pool"}'
echo -n "user2 PUT tariffs:    "; req "$T2" PUT "/api/clubs/$CLUB/tariffs" '{"rules":[]}'

echo; echo "готово."
