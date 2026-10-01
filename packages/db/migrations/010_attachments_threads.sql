-- 添付ファイルの取得（fetch_attachment）とスレッドの取得（thread）を同期デーモンに頼めるようにする
alter table requests drop constraint requests_kind_check;
alter table requests add constraint requests_kind_check check (kind in ('fetch_body', 'send', 'fetch_attachment', 'thread'));

-- 取り出した添付ファイルの一時置き場。Worker が返したら役目は終わり。1 時間で消す
create table attachment_blobs (
  account_id  integer not null references accounts on delete cascade,
  mailbox     text not null,
  uid         bigint not null,
  part_index  integer not null,
  filename    text not null,
  mime_type   text not null,
  content     bytea not null,
  created_at  timestamptz not null default now(),
  primary key (account_id, mailbox, uid, part_index)
);
