-- 迷惑メールにする（spam: 受信トレイ → 迷惑メールフォルダ）と、迷惑メールではない（not_spam: 迷惑メールフォルダ → 受信トレイ）
alter table operations drop constraint operations_kind_check;
alter table operations add constraint operations_kind_check
  check (kind in ('archive', 'mark_seen', 'spam', 'not_spam'));
