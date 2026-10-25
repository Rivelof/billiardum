#!/usr/bin/env bash
# Безопасность M5.6, заход 2 (pentester) — проверки на стенде (реальный Caddy + сервер + БД).
# Задачи 3 и 4 контракта захода 2:
#   3. 403/404/401 обслуживания и прогноза для ресепшна, чужого клуба и без входа;
#      кэш прогноза (через Caddy) не смешивает клубы и роли.
#   4. Событие обслуживания на корте (M5.8) — 400.
#
# Атакует ТОЛЬКО свой временный клуб под номерами +7999672xxxx (правила захода 2).
# Клуб сида и столы 1–8 не трогает. Ничего разрушающего: все отказы (401/403/404/400) —
# без записи; единственная запись — событие обслуживания на СВОём столе своего клуба.
#
# Запуск:
#   bash tests/security/m5-6/stand.sh                 # провизионит свой клуб и гоняет матрицу
#   STAND=https://localhost:8443 bash …/stand.sh
# Повторный прогон создаёт новые тестовые клубы (лимит тестовых клубов на владельца может
# потребовать передать готовые id через окружение): CLUBX, COURT, TABLE, CLUBY.

set -u
S="${STAND:-https://localhost:8443}"
C="curl -sS -k --max-time 15"
pass=0; fail=0
uuid() { cat /proc/sys/kernel/random/uuid; }
dev() { $C -X POST "$S/api/auth/dev" -H 'content-type: application/json' -d "{\"phone\":\"$1\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }
# check EXPECTED METHOD PATH [curl-extra-args...]
check() {
  local want="$1" method="$2" path="$3"; shift 3
  local body code
  body=$($C -o /tmp/pt.$$ -w '%{http_code}' -X "$method" "$S$path" "$@")
  code="$body"
  local snip; snip=$(tr -d '\n' </tmp/pt.$$ | head -c 60); rm -f /tmp/pt.$$
  if [ "$code" = "$want" ]; then printf '  OK  %-4s %-6s %-48s %s\n' "$code" "$method" "$path" "$snip"; pass=$((pass+1));
  else printf '  XX  got %s want %s  %-6s %-40s %s\n' "$code" "$want" "$method" "$path" "$snip"; fail=$((fail+1)); fi
}

echo "Стенд: $S"
echo "== Провижининг (свои номера +7999672xxxx, свои клубы) =="
O1=$(dev +79996720001); R=$(dev +79996720003); F=$(dev +79996720002)
[ -n "$O1" ] && [ -n "$R" ] && [ -n "$F" ] || { echo "dev-login не вернул токены (включён ли dev-вход?)"; exit 1; }

CLUBX="${CLUBX:-}"; COURT="${COURT:-}"; TABLE="${TABLE:-}"; CLUBY="${CLUBY:-}"
if [ -z "$CLUBX" ]; then
  CLUBX=$($C -X POST "$S/api/clubs" -H "authorization: Bearer $O1" -H 'content-type: application/json' \
    -d '{"name":"PenTest Club X","city_name":"Казань","timezone":"Europe/Moscow"}' | sed -n 's/.*"club_id":"\([^"]*\)".*/\1/p')
  COURT=$($C -X POST "$S/api/clubs/$CLUBX/resources" -H "authorization: Bearer $O1" -H 'content-type: application/json' \
    -d '{"number":101,"kind":"padel_court","title":"Корт 1"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  TABLE=$($C -X POST "$S/api/clubs/$CLUBX/resources" -H "authorization: Bearer $O1" -H 'content-type: application/json' \
    -d '{"number":1,"kind":"pyramid","title":"Стол 1"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  $C -X POST "$S/api/clubs/$CLUBX/staff" -H "authorization: Bearer $O1" -H 'content-type: application/json' \
    -d '{"phone":"+79996720003","role":"reception"}' >/dev/null
  R=$(dev +79996720003)   # привязка роли при первом входе с номером приглашения
  CLUBY=$($C -X POST "$S/api/clubs" -H "authorization: Bearer $F" -H 'content-type: application/json' \
    -d '{"name":"PenTest Club Y","city_name":"Казань","timezone":"Europe/Moscow"}' | sed -n 's/.*"club_id":"\([^"]*\)".*/\1/p')
fi
echo "  CLUBX=$CLUBX COURT=$COURT TABLE=$TABLE CLUBY=$CLUBY"
[ -n "$CLUBX" ] && [ -n "$COURT" ] && [ -n "$TABLE" ] || { echo "провижининг не удался (лимит тестовых клубов? передайте CLUBX/COURT/TABLE через окружение)"; exit 1; }
OW=(-H "authorization: Bearer $O1"); RC=(-H "authorization: Bearer $R"); FR=(-H "authorization: Bearer $F")
JSON=(-H 'content-type: application/json')

echo "== Задача 3: GET /maintenance — права =="
check 401 GET "/api/clubs/$CLUBX/maintenance"
check 403 GET "/api/clubs/$CLUBX/maintenance" "${RC[@]}"
check 403 GET "/api/clubs/$CLUBX/maintenance" "${FR[@]}"
check 200 GET "/api/clubs/$CLUBX/maintenance" "${OW[@]}"
check 404 GET "/api/clubs/not-a-uuid/maintenance" "${OW[@]}"

echo "== Задача 3: GET /forecast — права =="
check 401 GET "/api/clubs/$CLUBX/forecast"
check 403 GET "/api/clubs/$CLUBX/forecast" "${RC[@]}"
check 403 GET "/api/clubs/$CLUBX/forecast" "${FR[@]}"
check 200 GET "/api/clubs/$CLUBX/forecast" "${OW[@]}"

echo "== Задача 3: PUT /maintenance/thresholds — права =="
check 401 PUT "/api/clubs/$CLUBX/maintenance/thresholds" "${JSON[@]}" -d '{"cloth":1000}'
check 403 PUT "/api/clubs/$CLUBX/maintenance/thresholds" "${RC[@]}" "${JSON[@]}" -d '{"cloth":1000}'

echo "== Задача 3: чужой клуб — владелец X не читает прогноз/обслуживание Y =="
[ -n "$CLUBY" ] && check 403 GET "/api/clubs/$CLUBY/forecast" "${OW[@]}"
[ -n "$CLUBY" ] && check 403 GET "/api/clubs/$CLUBY/maintenance" "${OW[@]}"

echo "== Задача 3: кэш прогноза не смешивает клубы (ключ по club_id, no-store) =="
D="2026-12-15"
# свежий ключ (date) → первый ответ без x-cache (miss), второй — x-cache: hit
h1=$($C -D - -o /dev/null "${OW[@]}" "$S/api/clubs/$CLUBX/forecast?date=$D" | tr -d '\r')
h2=$($C -D - -o /dev/null "${OW[@]}" "$S/api/clubs/$CLUBX/forecast?date=$D" | tr -d '\r')
cc=$(printf '%s' "$h1" | grep -i '^cache-control:' | head -1)
x1=$(printf '%s' "$h1" | grep -ic '^x-cache:'); x2=$(printf '%s' "$h2" | grep -ic '^x-cache:')
if printf '%s' "$cc" | grep -qi 'no-store'; then echo "  OK  Cache-Control: no-store (Caddy, без общего кэша)"; pass=$((pass+1)); else echo "  XX  нет no-store: $cc"; fail=$((fail+1)); fi
if [ "$x1" = "0" ] && [ "$x2" = "1" ]; then echo "  OK  x-cache: miss→hit на своём ключе club_id|date"; pass=$((pass+1)); else echo "  XX  x-cache miss/hit не подтвердилось (miss=$x1 hit=$x2)"; fail=$((fail+1)); fi
bx=$($C "${OW[@]}" "$S/api/clubs/$CLUBX/forecast" | sed -n 's/.*"club_id":"\([^"]*\)".*/\1/p')
if [ "$bx" = "$CLUBX" ]; then echo "  OK  тело прогноза X несёт club_id=X (не чужой)"; pass=$((pass+1)); else echo "  XX  club_id в теле: $bx"; fail=$((fail+1)); fi
if [ -n "$CLUBY" ]; then
  by=$($C "${FR[@]}" "$S/api/clubs/$CLUBY/forecast" | sed -n 's/.*"club_id":"\([^"]*\)".*/\1/p')
  if [ "$by" = "$CLUBY" ] && [ "$by" != "$bx" ]; then echo "  OK  клуб Y видит свой прогноз (club_id=Y), кэш X не подменил"; pass=$((pass+1)); else echo "  XX  Y club_id: $by"; fail=$((fail+1)); fi
fi

echo "== Задача 4: событие обслуживания на корте — 400; на столе — 201 =="
check 400 POST "/api/clubs/$CLUBX/maintenance" "${OW[@]}" "${JSON[@]}" -H "idempotency-key: $(uuid)" -d "{\"resource_id\":\"$COURT\",\"kind\":\"cloth\",\"cost_kopecks\":100000}"
check 201 POST "/api/clubs/$CLUBX/maintenance" "${OW[@]}" "${JSON[@]}" -H "idempotency-key: $(uuid)" -d "{\"resource_id\":\"$TABLE\",\"kind\":\"cloth\"}"
check 403 POST "/api/clubs/$CLUBX/maintenance" "${RC[@]}" "${JSON[@]}" -H "idempotency-key: $(uuid)" -d "{\"resource_id\":\"$COURT\",\"kind\":\"cloth\"}"

echo "== Итог: pass=$pass fail=$fail =="
[ "$fail" = "0" ]
