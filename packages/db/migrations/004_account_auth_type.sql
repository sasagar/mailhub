-- 認証方式。password: アプリパスワード（secret に暗号化して保存）
-- oauth: Google の OAuth（secret に更新用トークンを暗号化して保存。接続のたびにアクセストークンを取り直す）
alter table accounts add column auth_type text not null default 'password' check (auth_type in ('password', 'oauth'));
