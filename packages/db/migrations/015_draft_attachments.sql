-- 下書きの添付ファイル。Web 画面から付け、同期デーモンが送るときに読む。
-- 付け外しのたびに下書きの version を上げる（送信は画面で確かめた版と一致したときだけ受け付けるので、
-- 確かめた後に添付をすり替えられても送られない）。下書きを消せば一緒に消える
create table draft_attachments (
  id          bigserial primary key,
  draft_id    bigint not null references drafts on delete cascade,
  filename    text not null,
  mime_type   text not null,
  size        integer not null,
  content     bytea not null,
  created_at  timestamptz not null default now()
);
create index draft_attachments_draft on draft_attachments (draft_id);
