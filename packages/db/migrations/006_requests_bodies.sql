-- Worker（IMAP に繋がらない）から同期デーモンに頼む汎用の依頼。今は本文の取得（fetch_body）。結果は一時的なもの
create table requests (
  id           bigserial primary key,
  kind         text not null check (kind in ('fetch_body')),
  account_id   integer not null references accounts on delete cascade,
  params       jsonb not null,
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  result       jsonb,
  error        text,
  requested_by text not null,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index requests_created on requests (created_at);

create function notify_request() returns trigger language plpgsql as $$
begin
  perform pg_notify('mailhub_requests', new.id::text);
  return new;
end $$;
create trigger requests_notify after insert on requests for each row execute function notify_request();

-- 解析済みの本文の一時保存（開き直しを速くする）。メールの所在（アカウント・フォルダ・UID）で引く
create table message_bodies (
  account_id   integer not null references accounts on delete cascade,
  mailbox      text not null,
  uid          bigint not null,
  headers      jsonb not null,
  text_body    text,
  html_body    text,
  attachments  jsonb not null default '[]',
  fetched_at   timestamptz not null default now(),
  primary key (account_id, mailbox, uid)
);
create index message_bodies_fetched on message_bodies (fetched_at);

-- 操作に「既読にする」を足す
alter table operations drop constraint operations_kind_check;
alter table operations add constraint operations_kind_check check (kind in ('archive', 'mark_seen'));
