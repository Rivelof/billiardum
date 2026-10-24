# API клуба «Бильярдум», версия 1

API для интеграций клуба: CRM, учётные системы, сайты клуба, табло. Первая версия — только чтение (решения №199–202). Создание броней и продаж через API — в бэклоге: для них нужны оплата и личность гостя.

- Адрес: `https://<домен Бильярдума>/api/v1/club/…`. Версия — в пути.
- Вход: заголовок `Authorization: Bearer blk_…`. Ключ выпускает владелец клуба в программе клуба («Настройки → API и вебхуки»). Ключ показывается один раз — сохраните его в хранилище секретов. Ключ работает только для своего клуба; права задаются при выпуске.
- Права (`scopes`): `tables:read` — столы и статус сейчас; `tariffs:read` — цены сейчас и по расписанию; `availability:read` — свободные интервалы для брони; `sales:read` — продажи и оплаты агрегатами; `bookings:read` — брони без персональных данных.
- Лимиты: 600 запросов в минуту на ключ; `GET /sales` — 60 в минуту. Превышение — `429` и заголовок `Retry-After` (секунды).
- Деньги — целые копейки (`149050` = 1 490,50 ₽). Время — ISO 8601 в UTC; поля `*_local` и `days` тарифов — местное время клуба (`club.timezone`, IANA). Даты `from`, `to`, `date` — рабочие сутки клуба (начинаются в `club.day_start_local`, обычно 06:00).
- Персональных данных гостей в API и вебхуках нет: ни телефонов, ни имён, ни идентификаторов гостей и их игр.
- Ошибки — только код: `{"error": "scope_required"}`.

| Статус | Код | Когда |
|---|---|---|
| 400 | `bad_request` | неверный параметр (период, дата, тип стола, курсор) |
| 401 | `unauthorized` | нет ключа, ключ неверный или отозван |
| 403 | `scope_required` | у ключа нет права на маршрут |
| 403 | `club_suspended` | клуб приостановлен платформой |
| 404 | `not_found` | нет такого маршрута |
| 405 | `method_not_allowed` | метод не GET |
| 429 | `rate_limited` | превышен лимит, см. `Retry-After` |
| 500 | `internal` | ошибка сервера, повторите позже |

## Примеры

```sh
export BL_KEY='blk_…'   # ключ из программы клуба
export BL='https://<домен Бильярдума>/api/v1/club'

# Столы и статус сейчас
curl -sS -H "Authorization: Bearer $BL_KEY" "$BL/tables"

# Только пул
curl -sS -H "Authorization: Bearer $BL_KEY" "$BL/tables?kind=billiard_pool"

# Цены сейчас и правила тарифов
curl -sS -H "Authorization: Bearer $BL_KEY" "$BL/tariffs"

# Свободные интервалы на дату (рабочие сутки клуба)
curl -sS -H "Authorization: Bearer $BL_KEY" "$BL/availability?date=2026-10-25&kind=billiard_pyramid"

# Продажи за неделю по суткам
curl -sS -H "Authorization: Bearer $BL_KEY" "$BL/sales?from=2026-10-18&to=2026-10-24"

# Брони за месяц, страницами по 200
curl -sS -H "Authorization: Bearer $BL_KEY" "$BL/bookings?from=2026-10-01&to=2026-10-31&limit=200"
curl -sS -H "Authorization: Bearer $BL_KEY" "$BL/bookings?from=2026-10-01&to=2026-10-31&limit=200&cursor=<next_cursor>"
```

Ответ `GET /tables`:

```json
{
  "club": { "id": "c1000000-0000-4000-8000-000000000001", "name": "Клуб", "timezone": "Asia/Yekaterinburg", "day_start_local": "06:00", "mode": "live" },
  "at": "2026-10-24T15:04:05.000Z",
  "tables": [
    { "resource_id": "e1000000-0000-4000-8000-000000000001", "number": 1, "title": "Стол 1", "type": "billiard_pyramid",
      "status": "busy", "busy_until": "2026-10-24T16:30:00.000Z", "hold_until": null },
    { "resource_id": "e1000000-0000-4000-8000-000000000002", "number": 2, "title": "Стол 2", "type": "billiard_pyramid",
      "status": "free", "busy_until": null, "hold_until": null }
  ]
}
```

Ответ `GET /sales` (столбцы те же, что у выгрузки «Выручка по дням» дашборда):

```json
{
  "club": { "id": "…", "name": "Клуб", "timezone": "Asia/Yekaterinburg", "day_start_local": "06:00", "mode": "live" },
  "period": { "from": "2026-10-23", "to": "2026-10-24", "today": "2026-10-24", "includes_today": true, "missing_days": [] },
  "kind": null,
  "totals": { "total_kopecks": 1120000, "refunds_kopecks": 10000, "net_kopecks": 1110000, "tables_kopecks": 385000, "bar_kopecks": 135000,
              "other_kopecks": 600000, "by_method": { "cash": 595000, "card_terminal": 35000, "sbp": 465000, "card": 25000 }, "games": 5 },
  "days": [
    { "date": "2026-10-23", "today": false, "total_kopecks": 1080000, "refunds_kopecks": 0, "net_kopecks": 1080000, "tables_kopecks": 345000,
      "bar_kopecks": 135000, "other_kopecks": 600000, "by_method": { "cash": 580000, "card_terminal": 35000, "sbp": 440000, "card": 25000 },
      "games": 4, "avg_check_game_kopecks": 86250, "avg_check_bar_kopecks": 67500, "utilization_pct": 4.3 }
  ]
}
```

`missing_days` — закрытые сутки, которые сервер ещё досчитывает (повторите запрос позже). Текущие сутки (`today: true`) меняются в течение дня.

## Вебхуки

Владелец регистрирует адрес `https://` (порт 443) и выбирает события. Секрет подписи `whsec_…` показывается один раз.

- События: `session.started` (игра началась или продолжилась после перерыва — `resumed: true`), `session.ended` (игра закончилась), `booking.created`, `booking.canceled`, `shift.closed`; кнопка «Отправить тестовое событие» шлёт `ping`.
- Запрос: `POST`, `Content-Type: application/json; charset=utf-8`, тело — событие. Заголовки:
  - `X-Bl-Event` — тип события;
  - `X-Bl-Event-Id` — id события (одинаковый во всех повторах — используйте для защиты от дублей);
  - `X-Bl-Delivery` — id доставки;
  - `X-Bl-Timestamp` — время подписи, Unix-секунды;
  - `X-Bl-Signature` — `v1=<hex>`, где `<hex>` = HMAC-SHA256(секрет, `<X-Bl-Timestamp>.<тело>`).
- Успех — любой ответ `2xx` за 10 секунд. Иначе повтор через 1, 5, 15, 30 минут, 1, 2, 4, 8 часов и последний — через 24 часа после события; потом доставка помечается как неудачная (видно в журнале доставок). Редиректы (`3xx`) не выполняются и считаются неудачей.
- Порядок доставки не гарантирован; доставка «хотя бы один раз».
- Адрес не может вести во внутреннюю сеть: адреса `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `::1`, `fc00::/7`, `fe80::/10`, IPv4 внутри IPv6 и другие зарезервированные сети отклоняются при регистрации и проверяются снова при каждой доставке.

Тело события:

```json
{
  "id": "6f1c…",
  "type": "session.ended",
  "created_at": "2026-10-24T16:30:05.000Z",
  "club_id": "c1000000-0000-4000-8000-000000000001",
  "test": false,
  "data": {
    "game_id": "8a3e5c1d-…", "resource_id": "e1000000-…", "resource_number": 3, "source": "qr", "booking_id": null,
    "started_at": "2026-10-24T15:30:00.000Z", "unlimited": false,
    "ended_at": "2026-10-24T16:30:00.000Z", "reason": "expired", "played_minutes": 60
  }
}
```

| `type` | `data` |
|---|---|
| `session.started` | `game_id, resource_id, resource_number, source (qr, booking, reception, staff, tournament), booking_id, started_at, unlimited, paid_until, resumed` |
| `session.ended` | `game_id, resource_id, resource_number, source, booking_id, started_at, unlimited, ended_at, reason (expired, stopped, refunded, cancelled), played_minutes` |
| `booking.created` | `booking_id, resource_id, resource_number, starts_at, ends_at, status, source (app, site, phone, staff), created_at` |
| `booking.canceled` | как `booking.created` + `canceled_at, canceled_by (guest, staff)` |
| `shift.closed` | `shift_id, number, opened_at, closed_at, discrepancy_kopecks` |
| `ping` | `webhook_id` |

`game_id` — псевдоним игры: одинаковый у `session.started` и `session.ended` одной игры. `test: true` — событие клуба в тестовом режиме.

### Проверка подписи

Проверяйте подпись по сырому телу запроса (до разбора JSON) и отклоняйте запросы со временем старше 5 минут.

Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const SECRET = process.env.BL_WEBHOOK_SECRET; // whsec_…

function verify(headers, rawBody) {
  const t = headers['x-bl-timestamp'];
  const sig = String(headers['x-bl-signature'] ?? '');
  if (!/^\d+$/.test(t ?? '') || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = `v1=${createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex')}`;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!verify(req.headers, raw)) {
      res.writeHead(401).end();
      return;
    }
    const event = JSON.parse(raw);
    // Повторы приходят с тем же event.id — обработайте один раз.
    console.log(event.type, event.id);
    res.writeHead(200).end();
  });
}).listen(8080);
```

Python:

```python
import hashlib
import hmac
import os
import time

SECRET = os.environ["BL_WEBHOOK_SECRET"].encode()  # whsec_…


def verify(headers: dict, raw_body: bytes) -> bool:
    t = headers.get("X-Bl-Timestamp", "")
    sig = headers.get("X-Bl-Signature", "")
    if not t.isdigit() or abs(time.time() - int(t)) > 300:
        return False
    mac = hmac.new(SECRET, t.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, "v1=" + mac)


# Flask:
# @app.post("/hooks/billiardum")
# def hook():
#     if not verify(request.headers, request.get_data()):
#         abort(401)
#     event = request.get_json()
#     return "", 200
```

## OpenAPI 3.1

```yaml
openapi: 3.1.0
info:
  title: Бильярдум — API клуба
  version: 1.0.0
  description: >
    Только чтение. Вход — ключ API клуба (Bearer blk_…). Деньги — копейки, время — UTC ISO 8601,
    даты — рабочие сутки клуба. Персональных данных гостей нет.
servers:
  - url: https://{host}/api/v1/club
    variables:
      host:
        default: localhost
        description: Домен сервера Бильярдума (публичный адрес программы клуба).
security:
  - clubKey: []
components:
  securitySchemes:
    clubKey:
      type: http
      scheme: bearer
      bearerFormat: blk_
  parameters:
    kind:
      name: kind
      in: query
      required: false
      schema: { type: string, enum: [billiard_pyramid, billiard_pool, billiard_snooker, billiard_mixed] }
    day:
      name: date
      in: query
      required: false
      description: Рабочие сутки клуба, по умолчанию — текущие.
      schema: { type: string, format: date }
    from:
      name: from
      in: query
      required: false
      schema: { type: string, format: date }
    to:
      name: to
      in: query
      required: false
      schema: { type: string, format: date }
  responses:
    Error:
      description: Ошибка — только код.
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }
    RateLimited:
      description: Превышен лимит.
      headers:
        Retry-After: { schema: { type: integer }, description: Секунды до нового окна. }
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }
  schemas:
    Error:
      type: object
      required: [error]
      properties:
        error:
          type: string
          enum: [bad_request, unauthorized, scope_required, club_suspended, not_found, method_not_allowed, rate_limited, internal]
    Club:
      type: object
      required: [id, name, timezone]
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        timezone: { type: string, description: IANA }
        day_start_local: { type: string, pattern: '^\d{2}:\d{2}$' }
        mode: { type: string, enum: [test, live, suspended] }
    Interval:
      type: object
      required: [from, to]
      properties:
        from: { type: string, format: date-time }
        to: { type: string, format: date-time }
    Price:
      type: [object, 'null']
      properties:
        price_per_hour_kopecks: { type: integer }
        until_local: { type: [string, 'null'] }
        until: { type: [string, 'null'], format: date-time }
        from_local: { type: string }
        from: { type: string, format: date-time }
    Table:
      type: object
      properties:
        resource_id: { type: string, format: uuid }
        number: { type: integer }
        title: { type: string }
        type: { type: string }
        status: { type: string, enum: [free, busy, reserved, service, offline, fault] }
        busy_until: { type: [string, 'null'], format: date-time }
        hold_until: { type: [string, 'null'], format: date-time }
    TariffRule:
      type: object
      properties:
        rule_id: { type: string, format: uuid }
        resource_type: { type: [string, 'null'] }
        resource_id: { type: [string, 'null'], format: uuid }
        days: { type: array, items: { type: integer, minimum: 1, maximum: 7 }, description: ISO дни недели рабочих суток; праздник — день holiday_iso_day }
        start_local: { type: string }
        end_local: { type: string, description: '00:00 — до полуночи' }
        price_per_hour_kopecks: { type: integer }
        step_minutes: { type: integer }
        min_minutes: { type: integer }
        priority: { type: integer }
    Money:
      type: object
      properties:
        cash: { type: integer }
        card_terminal: { type: integer }
        sbp: { type: integer }
        card: { type: integer }
    SalesDay:
      type: object
      properties:
        date: { type: string, format: date }
        today: { type: boolean }
        total_kopecks: { type: integer }
        refunds_kopecks: { type: integer }
        net_kopecks: { type: integer }
        tables_kopecks: { type: integer }
        bar_kopecks: { type: integer }
        other_kopecks: { type: integer }
        by_method: { $ref: '#/components/schemas/Money' }
        games: { type: integer }
        avg_check_game_kopecks: { type: [integer, 'null'] }
        avg_check_bar_kopecks: { type: [integer, 'null'] }
        utilization_pct: { type: [number, 'null'] }
    Booking:
      type: object
      properties:
        booking_id: { type: string, format: uuid }
        resource_id: { type: string, format: uuid }
        resource_number: { type: integer }
        resource_type: { type: string }
        starts_at: { type: string, format: date-time }
        ends_at: { type: string, format: date-time }
        status: { type: string, enum: [pending_payment, confirmed, reserved, started, expired, canceled, completed] }
        source: { type: string, enum: [app, site, phone, staff] }
        created_at: { type: string, format: date-time }
        canceled_at: { type: [string, 'null'], format: date-time }
        test: { type: boolean }
    WebhookEvent:
      type: object
      required: [id, type, created_at, club_id, test, data]
      properties:
        id: { type: string, format: uuid }
        type: { type: string, enum: [session.started, session.ended, booking.created, booking.canceled, shift.closed, ping] }
        created_at: { type: string, format: date-time }
        club_id: { type: string, format: uuid }
        test: { type: boolean }
        data: { type: object }
paths:
  /tables:
    get:
      summary: Столы и статус сейчас
      description: 'Право tables:read.'
      parameters: [{ $ref: '#/components/parameters/kind' }]
      responses:
        '200':
          description: Столы
          content:
            application/json:
              schema:
                type: object
                properties:
                  club: { $ref: '#/components/schemas/Club' }
                  at: { type: string, format: date-time }
                  tables: { type: array, items: { $ref: '#/components/schemas/Table' } }
        '401': { $ref: '#/components/responses/Error' }
        '403': { $ref: '#/components/responses/Error' }
        '429': { $ref: '#/components/responses/RateLimited' }
  /tariffs:
    get:
      summary: Цены сейчас и правила тарифов
      description: 'Право tariffs:read. Правила — по местному времени клуба; праздники — на 90 дней вперёд.'
      parameters: [{ $ref: '#/components/parameters/kind' }]
      responses:
        '200':
          description: Тарифы
          content:
            application/json:
              schema:
                type: object
                properties:
                  club: { $ref: '#/components/schemas/Club' }
                  at: { type: string, format: date-time }
                  holiday_iso_day: { type: integer }
                  rounding_kopecks: { type: integer }
                  holidays:
                    type: array
                    items: { type: object, properties: { date: { type: string, format: date }, kind: { type: string, enum: [holiday, transfer] } } }
                  rules: { type: array, items: { $ref: '#/components/schemas/TariffRule' } }
                  tables:
                    type: array
                    items:
                      type: object
                      properties:
                        resource_id: { type: string, format: uuid }
                        number: { type: integer }
                        title: { type: string }
                        type: { type: string }
                        price_now: { $ref: '#/components/schemas/Price' }
                        price_next: { $ref: '#/components/schemas/Price' }
        '401': { $ref: '#/components/responses/Error' }
        '403': { $ref: '#/components/responses/Error' }
        '429': { $ref: '#/components/responses/RateLimited' }
  /availability:
    get:
      summary: Свободные интервалы для брони
      description: 'Право availability:read. Тот же расчёт, что у страницы брони. Дата — от сегодня до max_days.'
      parameters: [{ $ref: '#/components/parameters/day' }, { $ref: '#/components/parameters/kind' }]
      responses:
        '200':
          description: Интервалы
          content:
            application/json:
              schema:
                type: object
                properties:
                  club: { $ref: '#/components/schemas/Club' }
                  date: { type: string, format: date }
                  from: { type: string, format: date-time }
                  to: { type: string, format: date-time }
                  open_at: { type: string, format: date-time }
                  close_at: { type: string, format: date-time }
                  now: { type: string, format: date-time }
                  step_minutes: { type: integer }
                  min_minutes: { type: integer }
                  max_minutes: { type: integer }
                  lead_minutes: { type: integer }
                  max_days: { type: integer }
                  tables:
                    type: array
                    items:
                      type: object
                      properties:
                        resource_id: { type: string, format: uuid }
                        number: { type: integer }
                        title: { type: string }
                        type: { type: string }
                        free: { type: array, items: { $ref: '#/components/schemas/Interval' } }
                        busy:
                          type: array
                          items:
                            allOf:
                              - { $ref: '#/components/schemas/Interval' }
                              - { type: object, properties: { kind: { type: string, enum: [session, service, pending, booking, tournament, closed] } } }
                        rates:
                          type: array
                          items:
                            allOf:
                              - { $ref: '#/components/schemas/Interval' }
                              - { type: object, properties: { per_hour_kopecks: { type: integer } } }
        '400': { $ref: '#/components/responses/Error' }
        '401': { $ref: '#/components/responses/Error' }
        '403': { $ref: '#/components/responses/Error' }
        '429': { $ref: '#/components/responses/RateLimited' }
  /sales:
    get:
      summary: Продажи по суткам
      description: 'Право sales:read. Лимит 60 в минуту. Период — до 366 суток, по умолчанию текущие сутки.'
      parameters:
        - { $ref: '#/components/parameters/from' }
        - { $ref: '#/components/parameters/to' }
        - { name: kind, in: query, required: false, schema: { type: string, enum: [billiard_pyramid, billiard_pool, billiard_snooker] } }
      responses:
        '200':
          description: Продажи
          content:
            application/json:
              schema:
                type: object
                properties:
                  club: { $ref: '#/components/schemas/Club' }
                  period:
                    type: object
                    properties:
                      from: { type: string, format: date }
                      to: { type: string, format: date }
                      today: { type: string, format: date }
                      includes_today: { type: boolean }
                      missing_days: { type: array, items: { type: string, format: date } }
                  kind: { type: [string, 'null'] }
                  totals:
                    type: object
                    properties:
                      total_kopecks: { type: integer }
                      refunds_kopecks: { type: integer }
                      net_kopecks: { type: integer }
                      tables_kopecks: { type: integer }
                      bar_kopecks: { type: integer }
                      other_kopecks: { type: integer }
                      by_method: { $ref: '#/components/schemas/Money' }
                      games: { type: integer }
                  days: { type: array, items: { $ref: '#/components/schemas/SalesDay' } }
        '400': { $ref: '#/components/responses/Error' }
        '401': { $ref: '#/components/responses/Error' }
        '403': { $ref: '#/components/responses/Error' }
        '429': { $ref: '#/components/responses/RateLimited' }
  /bookings:
    get:
      summary: Брони без персональных данных
      description: 'Право bookings:read. Период — сутки начала брони, до 93 суток.'
      parameters:
        - { $ref: '#/components/parameters/from' }
        - { $ref: '#/components/parameters/to' }
        - { $ref: '#/components/parameters/kind' }
        - { name: status, in: query, required: false, schema: { type: string, enum: [pending_payment, confirmed, reserved, started, expired, canceled, completed] } }
        - { name: limit, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 1000, default: 500 } }
        - { name: cursor, in: query, required: false, schema: { type: string } }
      responses:
        '200':
          description: Брони по времени начала
          content:
            application/json:
              schema:
                type: object
                properties:
                  club: { $ref: '#/components/schemas/Club' }
                  period: { type: object, properties: { from: { type: string, format: date }, to: { type: string, format: date } } }
                  items: { type: array, items: { $ref: '#/components/schemas/Booking' } }
                  next_cursor: { type: [string, 'null'] }
        '400': { $ref: '#/components/responses/Error' }
        '401': { $ref: '#/components/responses/Error' }
        '403': { $ref: '#/components/responses/Error' }
        '429': { $ref: '#/components/responses/RateLimited' }
webhooks:
  clubEvent:
    post:
      summary: Событие клуба
      description: >
        Подпись — X-Bl-Signature: v1=<hex HMAC-SHA256(секрет, "<X-Bl-Timestamp>.<тело>")>.
        Ответ 2xx за 10 с — доставлено; иначе повторы до 24 часов.
      parameters:
        - { name: X-Bl-Event, in: header, required: true, schema: { type: string } }
        - { name: X-Bl-Event-Id, in: header, required: true, schema: { type: string, format: uuid } }
        - { name: X-Bl-Delivery, in: header, required: true, schema: { type: string, format: uuid } }
        - { name: X-Bl-Timestamp, in: header, required: true, schema: { type: integer } }
        - { name: X-Bl-Signature, in: header, required: true, schema: { type: string, pattern: '^v1=[0-9a-f]{64}$' } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/WebhookEvent' }
      responses:
        '200': { description: Принято }
```
