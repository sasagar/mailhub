-- MCP / Web / CLI が積み、同期デーモンが IMAP で実行する操作のキュー。
-- 端末から 1 通ずつ送らず、ここに 1 行積めばデーモンが 1 回の MOVE で処理する
create table operations (
  id           bigserial primary key,
  account_id   integer not null references accounts on delete cascade,
  mailbox_id   integer not null references mailboxes on delete cascade,
  kind         text not null check (kind in ('archive')),
  uids         bigint[] not null,
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  -- 誰が積んだか（例: 'cli', 'mcp:<token 名>'）
  requested_by text not null,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

create index operations_queued on operations (account_id, id) where status = 'queued';

-- 積んだ側が NOTIFY を忘れても、デーモンがすぐ拾えるようにする
create function notify_operation() returns trigger language plpgsql as $$
begin
  perform pg_notify('mailhub_operations', new.account_id::text);
  return new;
end $$;

create trigger operations_notify after insert on operations
  for each row execute function notify_operation();
