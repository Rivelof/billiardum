#!/usr/bin/env bash
# PoC-батарея M5.2 «Дашборд владельца» (pentester).
#
# Запуск:  BASE=https://localhost:8443 bash tests/security/m5-2/poc.sh
# Только локальный стенд. Телефоны +7999660xxxx, свои новые клубы.
# НЕ трогает столы 1–8 и клуб сида (на них работает тестер). К базе и секретам не обращается.
#
# Проверяет защиты, которые ДОЛЖНЫ держаться:
#   - изоляция клубов (путь, ?club=, X-Club-Id) для дашборда, кассы, историй, «Кто играл»;
#   - роли: ресепшн и бар — 403; управляющий без экспорта; справочник статей и счета — владелец;
#   - сводка club=all — только свои клубы владельца/управляющего;
#   - касса: отрицательная/нулевая/огромная/дробная сумма — 400; двойное сторно и чужое сторно;
#   - «Кто играл»: полный телефон — только владелец с причиной, journal guest.lookup;
#   - период > 366 дней — 400.
set -u
BASE=${BASE:-https://localhost:8443}
login(){ curl -sk -m 10 "$BASE/api/auth/dev" -X POST -H 'content-type: application/json' -d "{\"phone\":\"$1\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }
cid(){ sed -n 's/.*"club_id":"\([^"]*\)".*/\1/p'; }
rid(){ sed -n 's/.*"id":"\([^"]*\)".*/\1/p'; }
eid(){ sed -n 's/.*"entry_id":"\([^"]*\)".*/\1/p'; }
uuid(){ cat /proc/sys/kernel/random/uuid; }
g(){ curl -sk -m 20 -H "authorization: Bearer $1" -X GET "$BASE$2" -w ' [%{http_code}]\n'; }
p(){ curl -sk -m 20 -H "authorization: Bearer $1" -H 'content-type: application/json' -H "idempotency-key: $(uuid)" -X "$2" "$BASE$3" -d "$4" -w ' [%{http_code}]\n'; }
mkclub(){ curl -sk -m 20 -H "authorization: Bearer $1" -H 'content-type: application/json' -X POST "$BASE/api/clubs" -d "{\"name\":\"$2\",\"city_name\":\"Москва\",\"timezone\":\"Europe/Moscow\"}"; }

echo "### вход: владелец A, владелец B, персонал A ###"
# Свежие номера +7999660xxxx на каждый прогон (лимит 3 тестовых клуба на пользователя).
S=${S:-$RANDOM}; N=$(( S % 9990 ))
ph(){ printf '+7999660%04d' $(( N + $1 )); }
TA=$(login "$(ph 0)"); TB=$(login "$(ph 1)")
CA=$(mkclub "$TA" "Pentest A52" | cid); CB=$(mkclub "$TB" "Pentest B52" | cid)
echo "CA=$CA CB=$CB"
curl -sk "$BASE/api/clubs/$CA/staff/invites" -H "authorization: Bearer $TA" -H 'content-type: application/json' -X POST -d "{\"phone\":\"$(ph 2)\",\"role\":\"manager\"}"  >/dev/null
curl -sk "$BASE/api/clubs/$CA/staff/invites" -H "authorization: Bearer $TA" -H 'content-type: application/json' -X POST -d "{\"phone\":\"$(ph 3)\",\"role\":\"reception\"}" >/dev/null
curl -sk "$BASE/api/clubs/$CA/staff/invites" -H "authorization: Bearer $TA" -H 'content-type: application/json' -X POST -d "{\"phone\":\"$(ph 4)\",\"role\":\"bar\"}" >/dev/null
TM=$(login "$(ph 2)"); TR=$(login "$(ph 3)"); TBar=$(login "$(ph 4)")

echo; echo "### 1. Изоляция: владелец B против клуба A (ожидается 403/404) ###"
echo -n "dashboard путь:   "; g "$TB" "/api/clubs/$CA/dashboard"
echo -n "cashbook:         "; g "$TB" "/api/clubs/$CA/cashbook"
echo -n "history/orders:   "; g "$TB" "/api/clubs/$CA/history/orders"
echo -n "who-played:       "; g "$TB" "/api/clubs/$CA/resources/00000000-0000-4000-8000-000000000001/sessions"
echo -n "subscription:     "; g "$TB" "/api/clubs/$CA/subscription"
echo -n "?club=A подмена (возвращает СВОЙ CB, не A): "; g "$TB" "/api/clubs/$CB/dashboard?club=$CA" | grep -o "\"id\":\"$CA\"" | head -1 || echo "(A не просочился)"
echo -n "X-Club-Id=A подмена: "; curl -sk -H "authorization: Bearer $TB" -H "x-club-id: $CA" "$BASE/api/clubs/$CB/dashboard" -w ' [%{http_code}]\n' | grep -o "\"id\":\"$CA\"" || echo "(A не просочился)"

echo; echo "### 2. Роли (ожидается 403) ###"
echo -n "ресепшн dashboard: "; g "$TR" "/api/clubs/$CA/dashboard"
echo -n "ресепшн cashbook:  "; g "$TR" "/api/clubs/$CA/cashbook"
echo -n "ресепшн who-played:"; g "$TR" "/api/clubs/$CA/resources/00000000-0000-4000-8000-000000000001/sessions"
echo -n "бар dashboard:     "; g "$TBar" "/api/clubs/$CA/dashboard"
echo -n "управляющий export:"; g "$TM" "/api/clubs/$CA/dashboard/export.csv?table=revenue_daily"
echo -n "управляющий invoices: "; g "$TM" "/api/clubs/$CA/subscription/invoices"
echo -n "управляющий категория статьи: "; p "$TM" POST "/api/clubs/$CA/cashbook/categories" '{"kind":"expense","name":"Хак"}'

echo; echo "### 3. Сводка club=all — только свои клубы ###"
echo -n "A видит B в all? (ожид. 0): "; g "$TA" "/api/clubs/all/dashboard" | grep -c "$CB"
echo -n "управляющий-only export all (ожид. 403): "; g "$TM" "/api/clubs/all/dashboard/export.csv?table=revenue_daily"

echo; echo "### 4. Касса: валидация сумм ###"
CAT=$(g "$TA" "/api/clubs/$CA/cashbook/categories" | grep -o '"category_id":"[^"]*","kind":"expense"' | head -1 | sed 's/.*"category_id":"\([^"]*\)".*/\1/')
echo -n "отрицательная: "; p "$TA" POST "/api/clubs/$CA/cashbook" "{\"kind\":\"expense\",\"amount_kopecks\":-500,\"category_id\":\"$CAT\"}"
echo -n "ноль:          "; p "$TA" POST "/api/clubs/$CA/cashbook" "{\"kind\":\"expense\",\"amount_kopecks\":0,\"category_id\":\"$CAT\"}"
echo -n "огромная:      "; p "$TA" POST "/api/clubs/$CA/cashbook" "{\"kind\":\"expense\",\"amount_kopecks\":999999999999999,\"category_id\":\"$CAT\"}"
echo -n "дробная:       "; p "$TA" POST "/api/clubs/$CA/cashbook" "{\"kind\":\"expense\",\"amount_kopecks\":10.5,\"category_id\":\"$CAT\"}"
EID=$(p "$TA" POST "/api/clubs/$CA/cashbook" "{\"kind\":\"expense\",\"amount_kopecks\":1234,\"category_id\":\"$CAT\",\"comment\":\"=HYPERLINK(1)\"}" | eid)
echo -n "сторно #1:          "; p "$TA" POST "/api/clubs/$CA/cashbook/$EID/storno" '{"reason":"ошибка"}'
echo -n "сторно #2 (409):    "; p "$TA" POST "/api/clubs/$CA/cashbook/$EID/storno" '{"reason":"снова"}'
echo -n "чужое сторно (404): "; p "$TB" POST "/api/clubs/$CB/cashbook/$EID/storno" '{"reason":"чужое"}'

echo; echo "### 5. «Кто играл»: полный телефон ###"
SID=$(uuid)
echo -n "управляющий guest-phone (403): "; p "$TM" POST "/api/clubs/$CA/sessions/$SID/guest-phone" '{"reason":"x"}'
echo -n "ресепшн guest-phone (403):     "; p "$TR" POST "/api/clubs/$CA/sessions/$SID/guest-phone" '{"reason":"x"}'
echo -n "владелец без причины (400):    "; p "$TA" POST "/api/clubs/$CA/sessions/$SID/guest-phone" '{}'

echo; echo "### 6. Период > 366 дней (ожид. 400) ###"
echo -n "367 дней: "; g "$TA" "/api/clubs/all/dashboard?from=2025-10-23&to=2026-10-24"
echo -n "366 дней ок: "; g "$TA" "/api/clubs/$CA/dashboard?from=2025-10-24&to=2026-10-24&compare=1&tab=control"

echo; echo "### готово ###"
