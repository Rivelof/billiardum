-- 1052 (backend-B, M5.1 №159): заявка «Заказать комплект» контроллеров.
--
-- bl.leads.kind: program — заявка на программу с сайта (M4), kit — заказ комплекта
-- контроллеров из мастера подключения. tables_count у заявки kit — сколько столов оснастить.
-- Права и политики прежние (0800): запись — POST /api/leads в контексте платформы.

alter table bl.leads add column kind text not null default 'program' check (kind in ('program', 'kit'));
create index leads_kind_idx on bl.leads (kind, created_at desc);

comment on column bl.leads.kind is 'program — заявка на программу (M4), kit — заказ комплекта контроллеров (M5.1 №159).';
