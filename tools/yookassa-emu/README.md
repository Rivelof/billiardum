# Эмулятор ЮKassa (`@billiardum/yookassa-emu`)

Подмножество ЮKassa API v3 для разработки и тестов (контракт M1 §5, decisions №55): сеть среды разработки закрыта для `api.yookassa.ru`, а инвариант 7 (чек на каждый приём денег) проверяется уже здесь. Только разработка: при `NODE_ENV=production` не запускается. Всё хранится в памяти процесса. Зависимостей нет.

Сервер ходит сюда, когда `YOOKASSA_API_URL` указывает на эмулятор (например `http://yookassa-emu:8090/v3`); в проде — только `https://api.yookassa.ru/v3` (сервер не запустится с другим адресом).

## Запуск

```
YOOKASSA_EMU_SHOP_ID=900001 YOOKASSA_EMU_SECRET=… \
YOOKASSA_EMU_WEBHOOK_URL='http://server:3000/api/webhooks/yookassa/{club_id}' \
YOOKASSA_EMU_PUBLIC_URL=http://localhost:8090 \
npm run start -w @billiardum/yookassa-emu
```

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `YOOKASSA_EMU_PORT` | `8090` | порт |
| `YOOKASSA_EMU_HOST` | `127.0.0.1` | адрес; в Compose — `0.0.0.0` |
| `YOOKASSA_EMU_SHOP_ID`, `YOOKASSA_EMU_SECRET` | — | магазин (Basic `shopId:secretKey`); те же значения берёт `server/payments/provision-dev.mjs` для тестового клуба (обе пары магазина клуба) |
| `YOOKASSA_EMU_SHOP_TEST` | `1` | `0` — магазин боевой: `GET /v3/me` `test: false`, у платежей `test: false` (M5.1 №154) |
| `YOOKASSA_EMU_SHOP_FISCALIZATION` | `1` | `0` — у магазина выключена отправка чеков: `GET /v3/me` `fiscalization_enabled: false` |
| `YOOKASSA_EMU_WEBHOOK_URL` | — | адрес вебхука; `{club_id}` заменяется на `metadata.club_id` платежа (у настоящей ЮKassa адрес задаётся в личном кабинете магазина) |
| `YOOKASSA_EMU_PUBLIC_URL` | `http://localhost:{port}` | внешний адрес для `confirmation_url` (страница `/pay/{id}` открывается в браузере гостя) |
| `YOOKASSA_EMU_WEBHOOK_DELAY_MS` | `0` | задержка перед вебхуком |
| `YOOKASSA_EMU_WEBHOOK_RETRIES` | `3` | попыток доставки вебхука (ЮKassa повторяет, пока клуб не ответит 200) |
| `YOOKASSA_EMU_WEBHOOK_RETRY_DELAY_MS` | `1000` | пауза между попытками (растёт линейно) |
| `YOOKASSA_EMU_CONTROL_TOKEN` | — | если задан, `/__emu/*` только с заголовком `X-Emu-Token` |

## API v3

Basic `shopId:secretKey` (иначе `401 invalid_credentials`), у каждого `POST` — заголовок `Idempotence-Key` до 64 символов (иначе `400`). Повтор с тем же ключом и тем же телом возвращает сохранённый ответ, с другим телом — `400 invalid_request` (`parameter: Idempotence-Key`). Ключи — на магазин.

| Метод | Что делает |
|---|---|
| `POST /v3/payments` | `amount {value: "1600.00", currency: "RUB"}`, `capture` (по умолчанию `false`, как у ЮKassa), `confirmation {type: "redirect", return_url}` или `{type: "qr"}` (только СБП; в ответе `confirmation {type: "qr", confirmation_data}` — в эмуляторе это ссылка на `/pay/{id}`, её можно отсканировать телефоном), `payment_method_data.type` (`bank_card`, `sbp`), `description` ≤ 128, `metadata` (≤ 16 строк), **`receipt` обязателен**. Ответ — платёж `pending` с `confirmation.confirmation_url = {PUBLIC_URL}/pay/{id}` |
| `GET /v3/payments/{id}` | платёж своего магазина (чужой — `404`) |
| `GET /v3/me` | сведения о магазине (M5.1 №154): `{account_id, test, fiscalization_enabled, payment_methods, status}` — сервер проверяет пару магазина клуба при сохранении |
| `POST /v3/payments/{id}/capture` | только `waiting_for_capture`; `amount` ≤ заморожённой; при другой сумме — чек на неё обязателен |
| `POST /v3/payments/{id}/cancel` | только `waiting_for_capture` → `canceled` (`merchant`, `canceled_by_merchant`) |
| `POST /v3/refunds` | `payment_id` (`succeeded`), `amount` ≤ остатка, **`receipt` обязателен**; сразу `succeeded` |
| `GET /v3/refunds/{id}` | возврат своего магазина |
| `POST /v3/receipts` | отдельный чек (M3, зачёт предоплаты): `type` `payment` (по `succeeded`-платежу) или `refund`, `send: true`, `customer`, `items`, `settlements` (`cashless`, `prepayment`, `postpayment`, `consideration`); сумма позиций = сумме расчётов; при `prepayment` позиции `full_payment`/`partial_payment` и зачёт не больше остатка платежа (можно частями). Ответ: `rt_…`, `status: succeeded`, фискальные поля |
| `GET /v3/receipts/{id}` | чек своего магазина |

Чек: `customer.phone` (цифры E.164 без `+`) или `customer.email`; 1–100 позиций с `description` ≤ 128, `quantity`, `amount`, `vat_code` 1–12, `payment_mode`, `payment_subject`; `tax_system_code` 1–6 по желанию. **Сумма позиций (цена × количество) должна равняться сумме платежа или возврата — иначе `400`, `parameter: receipt.items`.**

Допущение decisions №26: СБП только одностадийная — `sbp` с `capture: false` даёт `400`.

Объект платежа: `id` (вид `xxxxxxxx-000f-5000-8000-xxxxxxxxxxxx`), `status` (`pending`, `waiting_for_capture`, `succeeded`, `canceled`), `paid`, `amount`, `income_amount`, `description`, `recipient`, `payment_method {type, id, saved, title?, card?}`, `captured_at`, `created_at`, `expires_at` (заморозка, 7 дней), `confirmation` (только в `pending`), `test` (по магазину), `refunded_amount`, `refundable`, `receipt_registration`, `metadata`, `cancellation_details {party, reason}`. Ошибка: `{type: "error", id, code, description, parameter?}`.

## Страница подтверждения

`GET /pay/{id}` — сумма, способ и кнопки «Оплатить» и «Отказ» (без внешних ресурсов, CSP `default-src 'none'`). «Оплатить»: `capture: true` → `succeeded`, иначе `waiting_for_capture`; «Отказ» → `canceled` (`payment_network`, `general_decline`). Затем `303` на `return_url` (у QR без `return_url` — обратно на страницу со статусом) и вебхук `payment.succeeded`, `payment.waiting_for_capture` или `payment.canceled` (`refund.succeeded` — после возврата) на адрес клуба: `{type: "notification", event, object}`.

## Управление для тестов (`/__emu/...`)

| Запрос | Что делает |
|---|---|
| `POST /__emu/payments/{id}/succeed[?wait=1]` | как «Оплатить» (`wait=1` — ответ после доставки вебхука) |
| `POST /__emu/payments/{id}/cancel[?wait=1]` | как «Отказ» (заморозка — `expired_on_capture`) |
| `POST /__emu/payments/{id}/webhook?repeat=N[&event=…]` | повтор вебхука N раз (до 50); тело `{override: {...}}` — подмена полей объекта, `{raw: "..."}` — тело как есть, `{url}` — другой адрес (для pentester) |
| `POST /__emu/config` | `{webhook_delay_ms, webhook_retries, webhook_retry_delay_ms, webhook_url, fail_next: {count, status}, lose_next_response, down}`: задержка вебхуков, сбой следующих N запросов API (по умолчанию 500, операция не выполняется), «ответ потерян» (см. ниже), API недоступен (503) |
| `POST /__emu/shops` | `{shop_id, secret, webhook_url?, test?, fiscalization_enabled?}` — ещё магазин (второй клуб; `test: false` — боевой, `fiscalization_enabled: false` — без чеков; по умолчанию оба `true`); тот же `shop_id` — замена |
| `GET /__emu/payments`, `GET /__emu/payments/{id}` | платежи с чеками (`receipt`, `receipts`: платёж, списание, возвраты) |
| `GET /__emu/receipts` | отдельные чеки (зачёты) |
| `GET /__emu/webhooks` | доставки вебхуков и попытки со статусами |
| `GET /__emu/requests` | журнал запросов API (метод, путь, `Idempotence-Key`, статус) |
| `POST /__emu/reset` | очистить всё, кроме магазинов |

## Тесты

`npm test -w @billiardum/yookassa-emu` — 26 тестов: авторизация, ключ идемпотентности, отказ без чека и при несовпадении суммы позиций, форма объекта, QR для СБП, страница подтверждения, вебхуки с повтором до 200, двухстадийный платёж, возвраты, управление.

Поля, в которых эмулятор опирается на память, а не на проверенную документацию (сверить с настоящим магазином, когда откроется `api.yookassa.ru`): ответ на повтор `Idempotence-Key` с другим телом; `capture` по умолчанию; требование чека при `capture` с меньшей суммой и при возврате; `quantity` числом или строкой; диапазон `vat_code` (1–12, включая ставки 5 %, 7 % и 22 % с 2026 года); поддержка СБП в двухстадийной оплате; `expires_at` заморозки.

### «Операция выполнена, ответ потерян»

`POST /__emu/config {"lose_next_response": N}` или `{"lose_next_response": {"path": "/v3/refunds", "method": "POST", "count": 1, "mode": "error" | "reset"}}`: следующие `count` изменяющих запросов (создание платежа, списание и отмена заморозки, возврат, чек; по умолчанию любой `POST /v3/…`, `path` — точный путь или префикс) выполняются, результат сохраняется под `Idempotence-Key`, а клиент получает `500` (`mode: error`, по умолчанию) или обрыв соединения (`mode: reset`). Повтор тем же ключом отдаёт сохранённый результат — второй операции нет. В `/__emu/requests` у такого запроса `lost: true` (статус `500` или `reset`). `/__emu/reset` снимает режим.
