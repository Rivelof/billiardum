-- Сид разработки каталога (backend-directory, M4): только синтетика. Города, карточка тестового
-- клуба в программе (status platform) и демо-карточка клуба без программы для сценария T25
-- (заявка гостя → без контакта сразу оператору). В проде каталог пуст до клубов (№132).

insert into bl.cities (id, slug, name, region, timezone) values
  ('ca000000-0000-4000-8000-000000000001', 'ekaterinburg', 'Екатеринбург', 'Свердловская область', 'Asia/Yekaterinburg'),
  ('ca000000-0000-4000-8000-000000000002', 'moskva', 'Москва', 'Москва', 'Europe/Moscow')
on conflict (id) do nothing;

insert into bl.club_public (id, city_id, slug, name, status, club_id, address, hours_text, around_the_clock, phone, disciplines, description)
values
  ('cb100000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001', 'testovyy-klub', 'Тестовый клуб', 'platform',
   'c1000000-0000-4000-8000-000000000001', 'ул. Тестовая, 1', 'Круглосуточно', true, '+70000000099', '{pyramid,pool}',
   'Синтетическая карточка для разработки.'),
  ('cb100000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001', 'demo-bez-programmy', 'Демо-клуб без программы', 'listed',
   null, 'ул. Примерная, 2', 'Ежедневно 12:00–02:00', false, '+70000000098', '{pyramid}',
   'Синтетическая карточка: бронь по заявке.')
on conflict (id) do nothing;
