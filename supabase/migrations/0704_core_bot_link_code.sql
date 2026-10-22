-- 0704 (backend-core, ревью входа п. 2): код подтверждения входа через бота.
--
-- Фишинговая ссылка t.me/<бот>?start=<nonce> чужого браузера больше не входит сразу:
-- браузер, создавший nonce, показывает короткий код (6 цифр), бот после Start просит ввести
-- код с экрана; nonce переходит в done только после совпадения кода. Три неверных кода —
-- nonce failed. В базе — только sha256(nonce_hash:код).

alter table bl.bot_link_nonces
  add column code_hash text check (code_hash ~ '^[0-9a-f]{64}$'),
  add column code_attempts integer not null default 0 check (code_attempts between 0 and 10),
  add column confirmed_at timestamptz;

alter table bl.bot_link_nonces drop constraint bot_link_nonces_status_check;
alter table bl.bot_link_nonces
  add constraint bot_link_nonces_status_check check (status in ('pending', 'linked', 'done', 'consumed', 'failed'));
-- Уже завершённые входы до кода считаются подтверждёнными (история); незавершённые старые
-- nonce без кода больше не завершаются (Start требует code_hash).
update bl.bot_link_nonces set confirmed_at = coalesce(done_at, linked_at, created_at)
 where status in ('done', 'consumed') and confirmed_at is null;
-- Готово только после кода.
alter table bl.bot_link_nonces
  add constraint bot_link_nonces_done_confirmed check (status not in ('done', 'consumed') or confirmed_at is not null);

grant update (code_attempts, confirmed_at) on bl.bot_link_nonces to app_api;

comment on column bl.bot_link_nonces.code_hash is 'sha256(nonce_hash:код) — код подтверждения входа с экрана браузера.';
comment on column bl.bot_link_nonces.confirmed_at is 'Гость ввёл в боте верный код с экрана.';
