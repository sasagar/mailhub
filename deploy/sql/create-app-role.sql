-- 常駐デーモン用のロール mailhub_app。データの読み書きだけで、テーブルを作り替えられない（マイグレーションは
-- 所有者の mailhub が k3s の init コンテナで流す）。管理者（postgres）で、mailhub の DB に一度流す。
-- パスワードは psql の変数 app_password で渡す（コマンドの引数に残さないよう、標準入力から \set する）
--   sudo -u postgres psql -d mailhub -v app_password=... -f deploy/sql/create-app-role.sql
-- pg_hba.conf にも mailhub_app の行（Pod の範囲から scram-sha-256）が要る

select format('create role mailhub_app login password %L', :'app_password')
  where not exists (select 1 from pg_roles where rolname = 'mailhub_app') \gexec
select format('alter role mailhub_app password %L', :'app_password') \gexec

grant connect on database mailhub to mailhub_app;
grant usage on schema public to mailhub_app;
grant select, insert, update, delete on all tables in schema public to mailhub_app;
grant usage, select on all sequences in schema public to mailhub_app;
-- マイグレーションの記録は所有者だけが触る
revoke all on schema_migrations from mailhub_app;
-- これから mailhub（所有者）が作るテーブルにも同じ権限を付ける
alter default privileges for role mailhub in schema public grant select, insert, update, delete on tables to mailhub_app;
alter default privileges for role mailhub in schema public grant usage, select on sequences to mailhub_app;
