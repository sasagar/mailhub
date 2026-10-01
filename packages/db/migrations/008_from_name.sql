-- 画面・ログに出す表示名（label）と、送信時の差出人名（from_name）を分ける。
-- これまで label を両方に使っていたので、from_name には今の label を写す
alter table accounts add column from_name text;
update accounts set from_name = label;
alter table accounts alter column from_name set not null;
