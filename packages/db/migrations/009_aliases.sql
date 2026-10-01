-- 送信に使えるエイリアス（Gmail の「他のメールアドレスから送信」、Workspace のエイリアスなど）。
-- 認証はアカウント本体で行い、From にエイリアスのアドレスと差出人名を付ける
create table aliases (
  id          serial primary key,
  account_id  integer not null references accounts on delete cascade,
  address     text not null unique,
  from_name   text not null,
  created_at  timestamptz not null default now()
);

-- 下書きの差出人アドレス。null ならアカウント本体のアドレス
alter table drafts add column from_address text;
