-- MCP の Worker（Hyperdrive）用ロール mailhub_mcp に、必要な分だけ権限を付ける。
-- マイグレーションでテーブルが増えたら、もう一度流す（何度流しても同じ結果になる）。
--   psql -d mailhub -f deploy/sql/grant-mcp.sql
--
-- 方針: 読めるのは一覧に要るものだけ。accounts の secret（暗号化済みのアプリパスワード）は列ごと読めなくする。
-- 書けるのは operations への追加だけ（実行は同期デーモン）。Worker が乗っ取られても暗号文すら取れない。

revoke all on all tables in schema public from mailhub_mcp;
revoke all on all sequences in schema public from mailhub_mcp;
grant usage on schema public to mailhub_mcp;

grant select (id, label, email, provider, enabled) on accounts to mailhub_mcp;
grant select on mailboxes, messages to mailhub_mcp;
grant select, insert on operations to mailhub_mcp;
grant usage on sequence operations_id_seq to mailhub_mcp;

-- 検索の依頼を積み、結果を読む（実行は同期デーモン）
grant select, insert on search_requests to mailhub_mcp;
grant usage on sequence search_requests_id_seq to mailhub_mcp;

-- 本文の取得などを頼み、結果を読む（実行は同期デーモン）。解析済みの本文は読むだけ
grant select, insert on requests to mailhub_mcp;
grant usage on sequence requests_id_seq to mailhub_mcp;
grant select on message_bodies to mailhub_mcp;

-- 下書きを作り・直し・消す。送信は requests に kind = 'send' を積む（同期デーモンが SMTP で送る）
grant select, insert, update, delete on drafts to mailhub_mcp;
grant usage on sequence drafts_id_seq to mailhub_mcp;

-- エイリアスは読むだけ（追加・削除は同期デーモン側の CLI）
grant select on aliases to mailhub_mcp;
