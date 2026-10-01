-- メールサーバー側での検索の依頼と結果。Worker（MCP / Web 画面）は IMAP に直接繋がらないので、
-- ここに積んで同期デーモンに頼み、結果を待つ。結果は一時的なもので、古いものは同期デーモンが消す
create table search_requests (
  id           bigserial primary key,
  -- null なら全アカウント
  account_id   integer references accounts on delete cascade,
  query        text not null check (length(query) between 1 and 500),
  max_results  integer not null default 50 check (max_results between 1 and 200),
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  results      jsonb,
  error        text,
  requested_by text not null,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index search_requests_created on search_requests (created_at);

create function notify_search_request() returns trigger language plpgsql as $$
begin
  perform pg_notify('mailhub_search', new.id::text);
  return new;
end $$;

create trigger search_requests_notify after insert on search_requests
  for each row execute function notify_search_request();
