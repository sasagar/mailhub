-- 下書きと送信。MCP（エージェント）は下書きまで作れ、送信は Web 画面で本人が行う（mail.send の権限は Web 画面だけ）
create table drafts (
  id            bigserial primary key,
  account_id    integer not null references accounts on delete cascade,
  to_addrs      jsonb not null default '[]',
  cc_addrs      jsonb not null default '[]',
  bcc_addrs     jsonb not null default '[]',
  subject       text not null default '',
  body_text     text not null default '',
  -- 返信のとき、相手側でスレッドがまとまるためのヘッダー
  in_reply_to   text,
  references_   text,
  -- 返信元（受信トレイのメールなら mailhub の ID）
  reply_to_message_id bigint,
  status        text not null default 'draft' check (status in ('draft', 'sending', 'sent', 'failed')),
  error         text,
  -- 送ったメールの Message-ID
  sent_message_id text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create index drafts_open on drafts (updated_at desc) where status <> 'sent';

-- 送信も同期デーモンへの依頼として流す
alter table requests drop constraint requests_kind_check;
alter table requests add constraint requests_kind_check check (kind in ('fetch_body', 'send'));
