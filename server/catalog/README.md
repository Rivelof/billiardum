# Каталог бара (backend-pos, M2)

Контракт — `docs/contracts/m2.md` §3–§5, решение №76, PRODUCT §5, §16.4. Общее описание бара и кассы — `server/orders/README.md`.

- `api.mjs` — `menuFor(db, {clubId, audience: guest|staff})` (контракт §5): гостю без `is_alcohol`, пока `bl.platform_settings.qr_alcohol_allowed` не `true`; персоналу — всё, с `stock_qty`; `available` — не в стоп-листе и (при `pos_stop_at_zero`) остаток > 0. `resolveItems` — строки заказа со снимком цены и модификаторов: алкоголь гостю — `not_found`, стоп-лист — `stop_list`, модификаторы только из групп товара в пределах `min_select`/`max_select` (без выбора — по умолчанию).
- `service.mjs` — категории, товары, группы модификаторов и модификаторы (управляющий и выше; стоп-лист — `setStopList`, ресепшн и выше, №88), удаления нет (`active: false`), журнал `catalog.*` с изменениями «было → стало»; импорт CSV атомарно, обновление по `sku`, иначе по категории и названию.
- `csv.mjs` — разбор CSV: «,» или «;», кавычки, BOM, русские и английские заголовки (`категория|category`, `название|name`, `цена|price` в рублях, `ед|unit`, `алкоголь|is_alcohol`, `ндс|vat_code`, `предмет|payment_subject`, `артикул|sku`, `описание`, `фото`, `стоп`, `склад`); ошибки — `[{line, field, code}]`.
- Фото — путь сайта (`/media/…`) или `https://` (загрузки файлов в M2 нет).

Маршруты — `api/routes/catalog.mjs`. Тесты — `server/catalog/test/csv.test.mjs`, `server/orders/test/db/catalog.test.mjs`.
