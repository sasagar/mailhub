-- 操作ごとの追加指定。archive: { "markSeen": true } で移動の前に既読にする
alter table operations add column params jsonb not null default '{}';
