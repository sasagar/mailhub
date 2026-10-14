-- mailhub の DB を、mailhub のロールだけが使えるようにする（同じ Postgres に他のアプリが同居しているため）。
-- 管理者（postgres）で一度流す。何度流しても同じ結果になる。
--   sudo -u postgres psql -d mailhub -f deploy/sql/harden-mailhub-db.sql
--
-- 既定では、どのロールもすべての DB に CONNECT でき（PUBLIC）、PostgreSQL 14 以前は public スキーマに
-- テーブルを作れる。mailhub の DB については、mailhub と mailhub_mcp だけが繋がり、作れるのは所有者だけにする。
-- 同居しているほかの DB（ikaskey など）にも同じことをするのは、その DB の管理側（infra）で行う

revoke connect on database mailhub from public;
grant connect on database mailhub to mailhub, mailhub_mcp;

revoke create on schema public from public;
grant usage on schema public to mailhub_mcp;
