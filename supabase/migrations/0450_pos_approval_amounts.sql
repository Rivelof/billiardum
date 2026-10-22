-- 0450 (backend-pos, M2): одобрение скидки привязано к сумме корзины (decisions №100, pentester L1)
-- и название товара отдельным полем в строках заказа (для интерфейса, без разбора name).
--
-- * pos_discount_approvals.subtotal_kopecks — сумма бара корзины, на которую управляющий дал
--   скидку; max_discount_kopecks — скидка в копейках (процент от этой суммы или сумма). При
--   применении корзина не больше одобренной, скидка в копейках не больше одобренной.
--   Старые строки получают 0 и 0 — такие одобрения больше не применяются (отказ, а не обход).
-- * order_items.product_name — название товара на момент заказа (name — с модификаторами).

alter table bl.pos_discount_approvals
  add column subtotal_kopecks bigint not null default 0 check (subtotal_kopecks between 0 and 100000000),
  add column max_discount_kopecks bigint not null default 0 check (max_discount_kopecks >= 0),
  add constraint pos_discount_approvals_max_check check (max_discount_kopecks <= subtotal_kopecks);

alter table bl.order_items
  add column product_name text check (length(product_name) between 1 and 128);
