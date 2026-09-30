create table accounts (
  id          serial primary key,
  label       text not null,
  email       text not null unique,
  provider    text not null check (provider in ('gmail', 'icloud', 'generic')),
  imap_host   text not null,
  imap_port   integer not null default 993,
  smtp_host   text,
  smtp_port   integer,
  username    text not null,
  -- AES-256-GCM: iv(12) | tag(16) | ciphertext
  secret      bytea not null,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

create table mailboxes (
  id              serial primary key,
  account_id      integer not null references accounts on delete cascade,
  path            text not null,
  role            text check (role in ('inbox', 'archive', 'all', 'sent', 'trash', 'junk', 'drafts')),
  -- 前回同期時点のサーバー状態。null は未同期
  uid_validity    bigint,
  uid_next        bigint,
  highest_modseq  bigint,
  synced_at       timestamptz,
  unique (account_id, path)
);

create table messages (
  id           bigserial primary key,
  account_id   integer not null references accounts on delete cascade,
  mailbox_id   integer not null references mailboxes on delete cascade,
  uid          bigint not null,
  message_id   text,
  in_reply_to  text,
  gm_msgid     text,
  gm_thrid     text,
  subject      text,
  from_addr    jsonb,
  to_addrs     jsonb,
  cc_addrs     jsonb,
  sent_at      timestamptz,
  received_at  timestamptz,
  flags        text[] not null default '{}',
  labels       text[] not null default '{}',
  size         integer,
  unique (mailbox_id, uid)
);

create index messages_account_received on messages (account_id, received_at desc);
create index messages_received on messages (received_at desc);
create index messages_message_id on messages (message_id);
