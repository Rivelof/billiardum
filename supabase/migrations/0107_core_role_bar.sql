-- 0107 (backend-core): роль bar — бармен (decisions №97, M2).
--
-- Экран бара, статусы заказов и стоп-лист; без кассы, денег и зала. Права бармена задают
-- маршруты модулей (roles), поток SSE клуба отдаёт бармену только события бара.

alter table bl.club_members drop constraint club_members_role_check;
alter table bl.club_members add constraint club_members_role_check
  check (role in ('owner', 'manager', 'reception', 'installer', 'bar'));
