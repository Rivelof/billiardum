#!/usr/bin/env bash
# PoC-батарея M5.7 «Публичный API для клубов», часть 1: ключи и изоляция (pentester).
#
# Запуск:  BASE=https://localhost:8443 bash tests/security/m5-7/poc.sh
# Только локальный стенд. Телефоны +7999670xxxx, свои новые клубы. К базе и секретам не обращается.
# Ключи в вывод не печатаются (только длина). Нагрузки нет: максимум 7 параллельных запросов.
#
# Каждая строка — «ОК» (защита выдержала) или «FAIL» (находка). Код возврата — число FAIL.
set -u
BASE=${BASE:-https://localhost:8443}
FAILS=0
ok(){ echo "  ОК   $*"; }
bad(){ echo "  FAIL $*"; FAILS=$((FAILS+1)); }
# expect <описание> <ожидаемый код> <фактический код>
expect(){ if [ "$3" = "$2" ]; then ok "$1 ($3)"; else bad "$1: ожидали $2, получили $3"; fi; }

login(){ curl -sk -m 10 "$BASE/api/auth/dev" -X POST -H 'content-type: application/json' -d "{\"phone\":\"$1\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }
cid(){ sed -n 's/.*"club_id":"\([^"]*\)".*/\1/p'; }
field(){ sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
code(){ curl -sk -m 20 -o /dev/null -w '%{http_code}' "$@"; }
body(){ curl -sk -m 20 "$@"; }
J='content-type: application/json'
mkclub(){ body -H "authorization: Bearer $1" -H "$J" -X POST "$BASE/api/clubs" -d "{\"name\":\"$2\",\"city_name\":\"Москва\",\"timezone\":\"Europe/Moscow\"}" | cid; }
ALL='["tables:read","tariffs:read","availability:read","sales:read","bookings:read"]'
mkkey(){ body -H "authorization: Bearer $1" -H "$J" -X POST "$BASE/api/clubs/$2/api-keys" -d "{\"name\":\"$3\",\"scopes\":$4}"; }
api(){ local k=$1; shift; code -H "authorization: Bearer $k" "$@"; }

S=${S:-$RANDOM}; N=$(( S % 9000 ))
ph(){ printf '+7999670%04d' $(( N + $1 )); }
TA=$(login "$(ph 0)"); TB=$(login "$(ph 1)")
CA=$(mkclub "$TA" "Pentest API A57"); CB=$(mkclub "$TB" "Pentest API B57")
echo "CA=$CA CB=$CB"
for p in "$TA $CA" "$TB $CB"; do
  set -- $p
  body -H "authorization: Bearer $1" -H "$J" -X POST "$BASE/api/clubs/$2/resources" -d '{"kind":"pool","number":1}' >/dev/null
  body -H "authorization: Bearer $1" -H "$J" -X PUT "$BASE/api/clubs/$2/tariffs" \
    -d '{"rules":[{"kind":"pool","days":[1,2,3,4,5,6,7],"from":"06:00","to":"06:00","price_per_hour_kopecks":50000,"min_minutes":30,"step_minutes":15}]}' >/dev/null
done
RB=$(body -H "authorization: Bearer $TB" "$BASE/api/clubs/$CB/resources" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
# Бронь в клубе B с именем и телефоном гостя (свой номер) — для проверки ПДн в /bookings.
TOMORROW=$(date -u -d '+1 day' +%Y-%m-%dT12:00:00Z)
GUEST_PHONE=$(ph 9)
body -H "authorization: Bearer $TB" -H "$J" -X POST "$BASE/api/clubs/$CB/bookings" \
  -d "{\"resource_id\":\"$RB\",\"starts_at\":\"$TOMORROW\",\"minutes\":60,\"name\":\"Пентест Гость\",\"phone\":\"$GUEST_PHONE\"}" -w ' [%{http_code}]\n' | sed 's/"phone[^,]*//g' | head -c 200; echo

OUT=$(mkkey "$TA" "$CA" "a-all" "$ALL"); KA=$(echo "$OUT" | field key); KA_ID=$(echo "$OUT" | field key_id)
OUT=$(mkkey "$TB" "$CB" "b-all" "$ALL"); KB=$(echo "$OUT" | field key)
OUT=$(mkkey "$TA" "$CA" "a-tables" '["tables:read"]'); KT=$(echo "$OUT" | field key)
echo "ключи: KA ${#KA}, KB ${#KB}, KT ${#KT} символов"

echo; echo "### 1. Ключ клуба A не даёт данные клуба B ###"
R=$(body -H "authorization: Bearer $KA" -H "x-club-id: $CB" -H "cookie: bl_session=$TB" "$BASE/api/v1/club/tables?club=$CB&club_id=$CB")
echo "$R" | grep -q "\"id\":\"$CA\"" && ! echo "$R" | grep -q "$CB" && ok "X-Club-Id, ?club=, cookie B игнорируются — ответ клуба A" || bad "ответ содержит клуб B: $(echo "$R" | head -c 200)"
for p in tables tariffs availability sales bookings; do
  R=$(body -H "authorization: Bearer $KA" -H "x-club-id: $CB" "$BASE/api/v1/club/$p?club=$CB")
  if echo "$R" | grep -q "$CB" || { [ -n "$RB" ] && echo "$R" | grep -q "$RB"; }; then bad "/$p отдаёт данные B"; else ok "/$p — только клуб A"; fi
done
expect "клуб B в пути /api/v1/club/{B}/tables" 404 "$(api "$KA" "$BASE/api/v1/club/$CB/tables")"
expect "ключ A на staff-маршруте клуба B" 401 "$(api "$KA" "$BASE/api/clubs/$CB/resources")"
expect "ключ A на staff-маршруте своего клуба" 401 "$(api "$KA" "$BASE/api/clubs/$CA/resources")"
expect "ключ A на /api/me" 401 "$(api "$KA" "$BASE/api/me")"
expect "ключ A в cookie на /api/v1/club/tables" 401 "$(code -H "cookie: bl_session=$KA" "$BASE/api/v1/club/tables")"
expect "сессия владельца B (Bearer) на /api/v1/club/tables" 401 "$(api "$TB" "$BASE/api/v1/club/tables")"
expect "сессия владельца B (cookie) на /api/v1/club/tables" 401 "$(code -H "cookie: bl_session=$TB" "$BASE/api/v1/club/tables")"
expect "ключ в ?api_key= (не в заголовке)" 401 "$(code "$BASE/api/v1/club/tables?api_key=$KA&token=$KA")"

echo; echo "### 2. Неверный и отозванный ключ ###"
FAKE="${KA:0:12}$(printf 'A%.0s' $(seq 1 35))"
expect "тот же префикс, другой хвост" 401 "$(api "$FAKE" "$BASE/api/v1/club/tables")"
expect "ключ на 1 символ короче" 401 "$(api "${KA:0:46}" "$BASE/api/v1/club/tables")"
expect "ключ + лишний символ" 401 "$(api "${KA}A" "$BASE/api/v1/club/tables")"
expect "ключ в нижнем регистре" 401 "$(api "$(echo "$KA" | tr 'A-Z' 'a-z')" "$BASE/api/v1/club/tables")"
expect "схема 'bearer' строчными" 401 "$(code -H "authorization: bearer $KA" "$BASE/api/v1/club/tables")"
expect "ключ A до отзыва" 200 "$(api "$KA" "$BASE/api/v1/club/tables")"
expect "B отзывает ключ A через свой клуб" 404 "$(code -H "authorization: Bearer $TB" -H "$J" -X POST "$BASE/api/clubs/$CB/api-keys/$KA_ID/revoke" -d '{}')"
expect "B отзывает ключ A через путь клуба A" 403 "$(code -H "authorization: Bearer $TB" -H "$J" -X POST "$BASE/api/clubs/$CA/api-keys/$KA_ID/revoke" -d '{}')"
expect "ключ A всё ещё жив после попыток B" 200 "$(api "$KA" "$BASE/api/v1/club/tables")"
expect "A отзывает свой ключ" 200 "$(code -H "authorization: Bearer $TA" -H "$J" -X POST "$BASE/api/clubs/$CA/api-keys/$KA_ID/revoke" -d '{}')"
expect "отозванный ключ сразу" 401 "$(api "$KA" "$BASE/api/v1/club/tables")"
expect "отозванный ключ, другой маршрут" 401 "$(api "$KA" "$BASE/api/v1/club/sales")"

echo; echo "### 3. Только GET /api/v1/club/* ###"
for m in POST PUT PATCH DELETE; do
  expect "$m /api/v1/club/tables" 405 "$(api "$KB" -H "$J" -X $m "$BASE/api/v1/club/tables" -d '{}')"
done
expect "HEAD /api/v1/club/tables" 405 "$(api "$KB" -I "$BASE/api/v1/club/tables")"
expect "ключ B на POST /api/clubs/{B}/bookings" 401 "$(api "$KB" -H "$J" -X POST "$BASE/api/clubs/$CB/bookings" -d '{}')"
expect "ключ B выпускает ключ" 401 "$(api "$KB" -H "$J" -X POST "$BASE/api/clubs/$CB/api-keys" -d "{\"name\":\"x\",\"scopes\":$ALL}")"
expect "несуществующий /api/v1/club/sessions" 404 "$(api "$KB" "$BASE/api/v1/club/sessions")"
C=$(api "$KB" --path-as-is "$BASE/api/v1/club/../clubs/$CB/resources")
[ "$C" = 401 ] || [ "$C" = 404 ] && ok "обход пути /api/v1/club/../clubs/{B}/resources ($C)" || bad "обход пути: $C"
expect "/api/v1/club/tables/ (слэш)" 404 "$(api "$KB" "$BASE/api/v1/club/tables/")"

echo; echo "### 4. Права ключа ###"
expect "tables:read → /tables" 200 "$(api "$KT" "$BASE/api/v1/club/tables")"
for p in tariffs availability sales bookings; do
  R=$(body -H "authorization: Bearer $KT" "$BASE/api/v1/club/$p" -w ' [%{http_code}]')
  echo "$R" | grep -q '"scope_required".*\[403\]' && ok "/$p без права → 403 scope_required" || bad "/$p без права: $R"
done
expect "права вне списка при выпуске" 400 "$(code -H "authorization: Bearer $TA" -H "$J" -X POST "$BASE/api/clubs/$CA/api-keys" -d '{"name":"x","scopes":["tables:write"]}')"
expect "пустые права при выпуске" 400 "$(code -H "authorization: Bearer $TA" -H "$J" -X POST "$BASE/api/clubs/$CA/api-keys" -d '{"name":"x","scopes":[]}')"

echo; echo "### 5. Нет ПДн в ответах (клуб B с бронью гостя) ###"
for p in tables tariffs availability "availability?date=$(date -u -d "+1 day" +%F)" sales "bookings?from=$(date -u +%F)&to=$(date -u -d '+2 day' +%F)"; do
  R=$(body -H "authorization: Bearer $KB" "$BASE/api/v1/club/$p")
  LEAK=$(echo "$R" | grep -oE "\"(phone|guest_phone|guest_name|name_masked|user_id|session_id|payment_id|created_by|staff_id|email|phone_masked)\":|${GUEST_PHONE#+}|${GUEST_PHONE:5}|Пентест Гость" | sort -u | tr '\n' ' ')
  [ -z "$LEAK" ] && ok "/${p%%\?*} без ПДн ($(echo -n "$R" | wc -c) байт)" || bad "/${p%%\?*}: $LEAK"
done
R=$(body -H "authorization: Bearer $KB" "$BASE/api/v1/club/bookings?from=$(date -u +%F)&to=$(date -u -d '+2 day' +%F)")
echo "$R" | grep -q '"booking_id"' && ok "бронь гостя видна в /bookings (проверка ПДн содержательна)" || echo "  ??   бронь не создалась — проверка /bookings без данных"

echo; echo "### 6. Лимит 5 ключей и личный вход ###"
TC=$(login "$(ph 2)"); CC=$(mkclub "$TC" "Pentest API C57")
TMP=$(mktemp -d)
for i in 1 2 3 4 5 6 7; do
  ( code -H "authorization: Bearer $TC" -H "$J" -X POST "$BASE/api/clubs/$CC/api-keys" -d "{\"name\":\"p$i\",\"scopes\":[\"tables:read\"]}"; echo ) > "$TMP/$i" &
done; wait
CREATED=$(cat "$TMP"/* | grep -c 201); LIMITED=$(cat "$TMP"/* | grep -c 409); rm -rf "$TMP"
ACTIVE=$(body -H "authorization: Bearer $TC" "$BASE/api/clubs/$CC/api-keys" | sed -n 's/.*"active":\([0-9]*\),"limit".*/\1/p')
[ "$CREATED" = 5 ] && [ "$LIMITED" = 2 ] && [ "$ACTIVE" = 5 ] && ok "7 параллельных выпусков: 5×201, 2×409, активных $ACTIVE" || bad "параллельно: 201=$CREATED 409=$LIMITED активных=$ACTIVE"
expect "6-й ключ последовательно" 409 "$(code -H "authorization: Bearer $TC" -H "$J" -X POST "$BASE/api/clubs/$CC/api-keys" -d '{"name":"p6","scopes":["tables:read"]}')"
# Вход по PIN владельца на терминале ресепшена.
TERM=$(body -H "authorization: Bearer $TC" -H "$J" -X POST "$BASE/api/staff/terminal" -d "{\"club_id\":\"$CC\",\"name\":\"Pentest terminal\"}" | field terminal_token)
code -H "authorization: Bearer $TC" -H "$J" -X PUT "$BASE/api/staff/pin" -d "{\"club_id\":\"$CC\",\"pin\":\"570157\"}" >/dev/null
UC=$(body -H "authorization: Bearer $TC" "$BASE/api/me" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
PIN=$(body -H "authorization: Bearer $TERM" -H "$J" -X POST "$BASE/api/staff/pin" -d "{\"user_id\":\"$UC\",\"pin\":\"570157\"}" | field token)
if [ -n "$PIN" ]; then
  KID=$(body -H "authorization: Bearer $TC" "$BASE/api/clubs/$CC/api-keys" | sed -n 's/.*"key_id":"\([^"]*\)".*/\1/p' | head -1)
  code -H "authorization: Bearer $TC" -H "$J" -X POST "$BASE/api/clubs/$CC/api-keys/$KID/revoke" -d '{}' >/dev/null
  R=$(body -H "authorization: Bearer $PIN" -H "$J" -X POST "$BASE/api/clubs/$CC/api-keys" -d '{"name":"pin","scopes":["tables:read"]}' -w ' [%{http_code}]')
  echo "$R" | grep -q 'personal login required.*\[403\]\|\[403\]' && ! echo "$R" | grep -q '"key"' && ok "выпуск по PIN на терминале → 403" || bad "выпуск по PIN: $(echo "$R" | sed 's/blk_[A-Za-z0-9_-]*/blk_***/g')"
else
  echo "  ??   PIN-вход не получился — проверено только по коду (api/routes/clubapi.mjs:20)"
fi
TM=$(login "$(ph 3)")
code -H "authorization: Bearer $TC" -H "$J" -X POST "$BASE/api/clubs/$CC/staff/invites" -d "{\"phone\":\"$(ph 3)\",\"role\":\"manager\"}" >/dev/null
TM=$(login "$(ph 3)")
expect "управляющий выпускает ключ" 403 "$(code -H "authorization: Bearer $TM" -H "$J" -X POST "$BASE/api/clubs/$CC/api-keys" -d '{"name":"m","scopes":["tables:read"]}')"
expect "управляющий смотрит список ключей" 403 "$(code -H "authorization: Bearer $TM" "$BASE/api/clubs/$CC/api-keys")"
expect "владелец B выпускает ключ клубу A" 403 "$(code -H "authorization: Bearer $TB" -H "$J" -X POST "$BASE/api/clubs/$CA/api-keys" -d '{"name":"x","scopes":["tables:read"]}')"
R=$(body -H "authorization: Bearer $TA" "$BASE/api/clubs/$CA/api-keys")
echo "$R" | grep -qE '"key"|key_hash|blk_[A-Za-z0-9_-]{20,}' && bad "список ключей содержит ключ или хеш" || ok "список ключей — без ключа и хеша"

echo; echo "### 7. Журнал api_key.* без ключа ###"
AUD=$(body -H "authorization: Bearer $TA" "$BASE/api/clubs/$CA/audit?limit=200")
echo "$AUD" | grep -q 'api_key.create' && echo "$AUD" | grep -q 'api_key.revoke' && ok "в журнале есть api_key.create и api_key.revoke" || bad "нет записей api_key.* в журнале: $(echo "$AUD" | head -c 200)"
if echo "$AUD" | grep -qE "${KT:-NOKEY}|${KB:-NOKEY}|blk_[A-Za-z0-9_-]{20,}|key_hash"; then bad "ключ или хеш в журнале"; else ok "в журнале нет ключа и хеша (только префикс)"; fi
expect "журнал цел (verify)" 200 "$(code -H "authorization: Bearer $TA" "$BASE/api/clubs/$CA/audit/verify")"

echo; echo "### 8. Устойчивость разбора (низкая) ###"
# server/clubapi/read.mjs:220 — курсор проверяется /^[0-9a-f-]{36}$/, а не как UUID: 36 дефисов
# проходят и падают на $7::uuid (22P02) → 500 internal вместо 400 bad_request.
CUR=$(printf '["2026-10-24T00:00:00Z","------------------------------------"]' | base64 -w0 | tr '+/' '-_' | tr -d '=')
expect "кривой курсор /bookings → 400" 400 "$(api "$KB" "$BASE/api/v1/club/bookings?cursor=$CUR")"

echo; echo "### итог: FAIL=$FAILS ###"
exit "$FAILS"
