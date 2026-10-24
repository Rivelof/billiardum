#!/usr/bin/env bash
# PoC-батарея M5.3 «Подписка клубов» (pentester).
#
# Запуск:  BASE=https://localhost:8443 bash tests/security/m5-3/poc.sh
# Только локальный стенд. Телефоны +7999660xxxx, свои новые клубы. К базе и секретам не обращается.
#
# Проверяет защиты, которые ДОЛЖНЫ держаться:
#   - подделка вебхука /api/webhooks/yookassa-platform (неизвестный id, чужой event, кривой id) — no-op,
#     итог/paid_until не меняется, секреты не светятся;
#   - платформенные ручки (mark-paid, price, plans, список) недоступны владельцу клуба — 403;
#   - чужой клуб не видит подписку — 403;
#   - управляющий видит только состояние (без карты/цены/счетов).
# Полный путь первой оплаты и return_url проверены чтением кода (server/billing/service.mjs:
# parseReturnUrl — только свой origin; club_subscriptions: у app_api нет прав писать price/paid_until —
# миграция 1150, политика club_subscriptions_system требует bl.ctx_is_platform()).
set -u
BASE=${BASE:-https://localhost:8443}
login(){ curl -sk -m 10 "$BASE/api/auth/dev" -X POST -H 'content-type: application/json' -d "{\"phone\":\"$1\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }
cid(){ sed -n 's/.*"club_id":"\([^"]*\)".*/\1/p'; }
g(){ curl -sk -m 20 -H "authorization: Bearer $1" -X GET "$BASE$2" -w ' [%{http_code}]\n'; }
req(){ curl -sk -m 20 -H "authorization: Bearer $1" -H 'content-type: application/json' -X "$2" "$BASE$3" -d "$4" -w ' [%{http_code}]\n'; }
wh(){ curl -sk -m 20 -X POST "$BASE/api/webhooks/yookassa-platform" -H 'content-type: application/json' -d "$1" -w ' [%{http_code}]\n'; }
mkclub(){ curl -sk -m 20 -H "authorization: Bearer $1" -H 'content-type: application/json' -X POST "$BASE/api/clubs" -d "{\"name\":\"$2\",\"city_name\":\"Москва\",\"timezone\":\"Europe/Moscow\"}"; }

S=${S:-$RANDOM}; N=$(( S % 9990 ))
ph(){ printf '+7999660%04d' $(( N + $1 )); }
TA=$(login "$(ph 0)"); TB=$(login "$(ph 1)")
CA=$(mkclub "$TA" "Pentest A52" | cid); CB=$(mkclub "$TB" "Pentest B52" | cid)
curl -sk "$BASE/api/clubs/$CA/staff/invites" -H "authorization: Bearer $TA" -H 'content-type: application/json' -X POST -d "{\"phone\":\"$(ph 2)\",\"role\":\"manager\"}" >/dev/null
TM=$(login "$(ph 2)")
echo "CA=$CA CB=$CB"

echo; echo "### 1. Подделка вебхука платформы (должна быть no-op) ###"
echo -n "неизвестный payment id + чужой metadata: "
wh "{\"event\":\"payment.succeeded\",\"object\":{\"id\":\"forged-$(date +%s)\",\"status\":\"succeeded\",\"amount\":{\"value\":\"790.00\",\"currency\":\"RUB\"},\"metadata\":{\"kind\":\"subscription\",\"club_id\":\"$CA\",\"billing_payment_id\":\"11111111-1111-4111-8111-111111111111\",\"purpose\":\"invoice\"}}}"
echo -n "чужой тип события refund.*:  "; wh '{"event":"refund.succeeded","object":{"id":"xyz"}}'
echo -n "кривой id (пробелы/..):      "; wh '{"event":"payment.succeeded","object":{"id":"bad id /../"}}'
echo -n "пустое тело:                 "; wh '{}'
echo -n "клуб A всё ещё без платного периода (paid_until null): "; g "$TA" "/api/clubs/$CA/subscription" | grep -o '"paid_until":[^,]*' | head -1

echo; echo "### 2. Платформенные ручки недоступны владельцу клуба (ожид. 403) ###"
echo -n "список подписок:  "; g  "$TA" "/api/platform/subscriptions"
echo -n "mark-paid:        "; req "$TA" POST "/api/platform/subscriptions/$CA/mark-paid" '{"invoice_id":"00000000-0000-4000-8000-000000000001","reason":"x","document":"n1"}'
echo -n "set price:        "; req "$TA" PUT  "/api/platform/subscriptions/$CA/price" '{"price_per_table_kopecks":1,"reason":"x"}'
echo -n "update plan:      "; req "$TA" PUT  "/api/platform/plans/bf000000-0000-4000-8000-000000000001" '{"price_per_table_kopecks":1}'

echo; echo "### 3. Чужой клуб и роли ###"
echo -n "B смотрит подписку A (403):        "; g "$TB" "/api/clubs/$CA/subscription"
echo -n "управляющий A — только состояние:  "; g "$TM" "/api/clubs/$CA/subscription"
echo -n "управляющий A — счета (403):       "; g "$TM" "/api/clubs/$CA/subscription/invoices"

echo; echo "### готово ###"
