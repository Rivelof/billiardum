#!/usr/bin/env bash
# PoC-батарея M5.7 «Публичный API для клубов», часть 2: исходящие вебхуки на стенде (pentester).
#
# Запуск:  BASE=https://localhost:8443 bash tests/security/m5-7/webhooks.sh
# Только локальный стенд. Телефоны +7999671xxxx, свои новые клубы. К базе и секретам не обращается.
# Ни одна доставка наружу не запускается: единственный принятый адрес — https://[2a00::1]/… (публичный
# по классификации, не назначен), события только shift.closed (смены в клубе не открываются), адрес
# выключается до любых проверок /test. Секрет в вывод не печатается (только длина).
# Сетевые доставки, подпись, повторы и failed — tests/security/m5-7/webhooks-deliver.mjs (локально).
#
# Каждая строка — «ОК» (защита выдержала) или «FAIL» (находка). Код возврата — число FAIL.
set -u
BASE=${BASE:-https://localhost:8443}
FAILS=0
ok(){ echo "  ОК   $*"; }
bad(){ echo "  FAIL $*"; FAILS=$((FAILS+1)); }
expect(){ if [ "$3" = "$2" ]; then ok "$1 ($3)"; else bad "$1: ожидали $2, получили $3"; fi; }

J='content-type: application/json'
login(){ curl -sk -m 10 "$BASE/api/auth/dev" -X POST -H "$J" -d "{\"phone\":\"$1\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }
field(){ sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }
code(){ curl -sk -m 20 -o /dev/null -w '%{http_code}' "$@"; }
body(){ curl -sk -m 20 "$@"; }
mkclub(){ body -H "authorization: Bearer $1" -H "$J" -X POST "$BASE/api/clubs" -d "{\"name\":\"$2\",\"city_name\":\"Москва\",\"timezone\":\"Europe/Moscow\"}" | field club_id; }
# reg <token> <club> <url> → «код тело»
reg(){ local r; while :; do
  r=$(body -H "authorization: Bearer $1" -H "$J" -X POST "$BASE/api/clubs/$2/webhooks" \
    -d "{\"url\":\"$3\",\"events\":[\"shift.closed\"]}" -w ' %{http_code}')
  [ "${r##* }" = 429 ] || break; sleep 20; done; echo "$r"; }

S=${S:-$RANDOM}; N=$(( S % 9000 ))
ph(){ printf '+7999671%04d' $(( N + $1 )); }
TA=$(login "$(ph 0)"); TB=$(login "$(ph 1)")
CA=$(mkclub "$TA" "Pentest WH A57"); CB=$(mkclub "$TB" "Pentest WH B57")
echo "CA=$CA CB=$CB"

echo; echo "### 1. Регистрация: внутренние назначения отклоняются ###"
# Ожидаем 400 с кодом url_forbidden или url_invalid; 201 — находка (адрес создан — сразу выключаем).
BAD_URLS=(
  'https://127.0.0.1/' 'https://127.255.255.254/' 'https://10.0.0.1/' 'https://10.255.255.255/'
  'https://172.16.0.1/' 'https://172.31.255.254/' 'https://192.168.0.1/' 'https://192.168.255.1/'
  'https://169.254.169.254/latest/meta-data/' 'https://0.0.0.0/' 'https://0/' 'https://100.64.0.1/'
  'https://[::1]/' 'https://[::]/' 'https://[::ffff:127.0.0.1]/' 'https://[::ffff:7f00:1]/' 'https://[0:0:0:0:0:ffff:a00:1]/'
  'https://[::ffff:169.254.169.254]/' 'https://[::127.0.0.1]/' 'https://[::ffff:0:7f00:1]/'
  'https://[fd00::1]/' 'https://[fc00::1]/' 'https://[fe80::1]/' 'https://[fec0::1]/' 'https://[ff02::1]/'
  'https://[64:ff9b::7f00:1]/' 'https://[64:ff9b::a9fe:a9fe]/' 'https://[64:ff9b:1::a00:1]/'
  'https://[2002:7f00:1::1]/' 'https://[2002:a9fe:a9fe::1]/' 'https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/'
  'https://2130706433/' 'https://3232235521/' 'https://017700000001/' 'https://0177.0.0.1/' 'https://0x7f000001/'
  'https://0x7f.0.0.1/' 'https://0xA9.0xFE.0xA9.0xFE/' 'https://127.1/' 'https://10.1/' 'https://0x0a.0x0.0x0.0x1/'
  'https://%31%32%37.0.0.1/' 'https://１２７.０.０.１/'
  'https://server/' 'https://db/' 'https://mosquitto/' 'https://caddy/' 'https://server./' 'https://SERVER/'
  'https://localhost/' 'https://LOCALHOST./' 'https://api.localhost/' 'https://db.local/' 'https://x.internal/'
  'https://127.0.0.1.nip.io/' 'https://localtest.me/'
  'http://hooks.example.ru/' 'http://[2a00::1]/' 'ftp://[2a00::1]/' 'file:///etc/passwd' 'gopher://[2a00::1]/'
  'https://[2a00::1]:8443/' 'https://[2a00::1]:80/' 'https://[2a00::1]:3000/'
  'https://user:pw@[2a00::1]/' 'https://user@[2a00::1]/' 'https://:pw@[2a00::1]/'
  'https://[2a00::1]/#frag' 'https://[2a00::1]@127.0.0.1/' 'https://127.0.0.1\\@[2a00::1]/'
)
for u in "${BAD_URLS[@]}"; do
  R=$(reg "$TA" "$CA" "$u"); C=${R##* }
  if [ "$C" = 400 ] && echo "$R" | grep -Eq '"error":"(url_forbidden|url_invalid|bad_request)"'; then
    ok "$u → $C $(echo "$R" | field error)"
  else
    bad "$u принят: $C $(echo "$R" | sed 's/whsec_[A-Za-z0-9_-]*/whsec_<скрыто>/' | head -c 160)"
    W=$(echo "$R" | field webhook_id); [ -n "$W" ] && code -H "authorization: Bearer $TA" -H "$J" -X POST "$BASE/api/clubs/$CA/webhooks/$W/disable" -d '{}' >/dev/null
  fi
done
sleep 61  # лимит POST /webhooks — 20 в минуту
expect "events вне списка" 400 "$(code -H "authorization: Bearer $TA" -H "$J" -X POST "$BASE/api/clubs/$CA/webhooks" -d '{"url":"https://[2a00::1]/","events":["payment.succeeded"]}')"

# :0443 — тот же порт 443: парсер URL нормализует адрес, сохраняется без порта (не находка).
R=$(reg "$TA" "$CA" 'https://[2a00::1]:0443/p'); W=$(echo "$R" | field webhook_id)
echo "$R" | grep -q '"url":"https://\[2a00::1\]/p"' && ok ":0443 нормализован в 443, сохранён без порта" || bad ":0443: ${R##* } $(echo "$R" | field url)"
[ -n "$W" ] && code -H "authorization: Bearer $TA" -H "$J" -X POST "$BASE/api/clubs/$CA/webhooks/$W/disable" -d '{}' >/dev/null

echo; echo "### 2. Секрет показывается один раз ###"
R=$(reg "$TA" "$CA" 'https://[2a00::1]/pentest-m57?token=rcv-token-123'); C=${R##* }
WA=$(echo "$R" | field webhook_id); SEC=$(echo "$R" | field secret)
expect "регистрация публичного адреса" 201 "$C"
echo "  секрет: ${#SEC} символов, префикс ${SEC:0:6}"
# Выключаем сразу: дальше ни /test, ни события не дойдут до сети.
expect "выключение своего адреса" 200 "$(code -H "authorization: Bearer $TA" -H "$J" -X POST "$BASE/api/clubs/$CA/webhooks/$WA/disable" -d '{}')"
L=$(body -H "authorization: Bearer $TA" "$BASE/api/clubs/$CA/webhooks")
if [ -n "$SEC" ] && ! echo "$L" | grep -q 'whsec_\|"secret' && ! echo "$L" | grep -qF "$SEC"; then ok "список адресов без секрета"; else bad "секрет в списке адресов"; fi
D=$(body -H "authorization: Bearer $TA" "$BASE/api/clubs/$CA/webhooks/$WA/deliveries")
if ! echo "$D" | grep -q 'whsec_'; then ok "журнал доставок без секрета"; else bad "секрет в журнале доставок"; fi
A=$(body -H "authorization: Bearer $TA" "$BASE/api/clubs/$CA/audit?limit=50")
if echo "$A" | grep -q 'webhook.create' && ! echo "$A" | grep -q 'whsec_' && ! echo "$A" | grep -q 'rcv-token-123'; then
  ok "журнал действий: webhook.create без секрета и без пути/запроса адреса"
else bad "журнал действий: $(echo "$A" | grep -o '.\{0,80\}webhook.create.\{0,200\}' | sed 's/whsec_[A-Za-z0-9_-]*/whsec_<скрыто>/' | head -c 300)"; fi
expect "проверка цепочки журнала" 200 "$(code -H "authorization: Bearer $TA" "$BASE/api/clubs/$CA/audit/verify")"
expect "/test на выключенном адресе (доставки нет)" 409 "$(code -H "authorization: Bearer $TA" -H "$J" -X POST "$BASE/api/clubs/$CA/webhooks/$WA/test" -d '{}')"
# Лог сервера: секрет и whsec_ не встречаются (печатаем только число совпадений).
SRV=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '(^|[-_])server([-_]|$)' | head -1)
if [ -n "$SRV" ] && [ -n "$SEC" ]; then
  NL=$(docker logs --since 10m "$SRV" 2>&1 | grep -cF "$SEC"); NW=$(docker logs --since 10m "$SRV" 2>&1 | grep -c 'whsec_')
  [ "$NL" = 0 ] && [ "$NW" = 0 ] && ok "лог сервера за 10 минут: секрет 0, whsec_ 0" || bad "лог сервера: секрет $NL, whsec_ $NW"
else echo "  -- лог сервера не проверен (контейнер не найден)"; fi

echo; echo "### 5. Чужой клуб ###"
H="authorization: Bearer $TB"
expect "B: список вебхуков клуба A" 403 "$(code -H "$H" "$BASE/api/clubs/$CA/webhooks")"
R=$(body -H "$H" "$BASE/api/clubs/$CB/webhooks"); echo "$R" | grep -q "$WA" && bad "B видит адрес A в своём списке" || ok "список B не содержит адрес A"
expect "B: журнал доставок A через свой клуб" 404 "$(code -H "$H" "$BASE/api/clubs/$CB/webhooks/$WA/deliveries")"
expect "B: журнал доставок A через путь A" 403 "$(code -H "$H" "$BASE/api/clubs/$CA/webhooks/$WA/deliveries")"
expect "B: выключить адрес A через свой клуб" 404 "$(code -H "$H" -H "$J" -X POST "$BASE/api/clubs/$CB/webhooks/$WA/disable" -d '{}')"
expect "B: выключить адрес A через путь A" 403 "$(code -H "$H" -H "$J" -X POST "$BASE/api/clubs/$CA/webhooks/$WA/disable" -d '{}')"
expect "B: тест адреса A через свой клуб" 404 "$(code -H "$H" -H "$J" -X POST "$BASE/api/clubs/$CB/webhooks/$WA/test" -d '{}')"
expect "B: тест адреса A через путь A" 403 "$(code -H "$H" -H "$J" -X POST "$BASE/api/clubs/$CA/webhooks/$WA/test" -d '{}')"
expect "B: зарегистрировать адрес в клубе A" 403 "$(code -H "$H" -H "$J" -X POST "$BASE/api/clubs/$CA/webhooks" -d '{"url":"https://[2a00::1]/b","events":["shift.closed"]}')"
expect "без входа: список A" 401 "$(code "$BASE/api/clubs/$CA/webhooks")"
OUT=$(body -H "authorization: Bearer $TA" -H "$J" -X POST "$BASE/api/clubs/$CA/api-keys" -d '{"name":"wh","scopes":["tables:read"]}')
KA=$(echo "$OUT" | field key)
expect "ключ API клуба A на вебхуках A" 401 "$(code -H "authorization: Bearer $KA" "$BASE/api/clubs/$CA/webhooks")"
expect "кривой webhook id" 404 "$(code -H "authorization: Bearer $TA" "$BASE/api/clubs/$CA/webhooks/not-a-uuid/deliveries")"

echo; echo "### 6. Журнал доставок: кривой курсор ###"
# НАХОДКА (низкая): server/clubapi/webhooks.mjs:316 проверяет время курсора через Date.parse —
# V8 принимает «1» (2001-01-01), Postgres на $4::timestamptz падает (22007) → 500 вместо 400."
cur(){ printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
UU=00000000-0000-4000-8000-000000000000
for c in '["x","'$UU'"]' '["1","'$UU'"]' '["2026-10-24 Fri","'$UU'"]' '["Oct 24, 2026 25:61","'$UU'"]'; do
  expect "курсор $c" 400 "$(code -H "authorization: Bearer $TA" "$BASE/api/clubs/$CA/webhooks/$WA/deliveries?cursor=$(cur "$c")")"
done
expect "корректный курсор" 200 "$(code -H "authorization: Bearer $TA" "$BASE/api/clubs/$CA/webhooks/$WA/deliveries?cursor=$(cur '["2026-10-24T00:00:00Z","'$UU'"]')")"

echo; echo "Итого FAIL: $FAILS"
exit "$FAILS"
