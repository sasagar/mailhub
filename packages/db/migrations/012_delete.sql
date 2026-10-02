-- 迷惑メールの削除（delete: 迷惑メールフォルダのメールを完全に消す）。Web 画面からだけ積む
alter table operations drop constraint operations_kind_check;
alter table operations add constraint operations_kind_check
  check (kind in ('archive', 'mark_seen', 'spam', 'not_spam', 'delete'));
