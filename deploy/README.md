# デプロイ

| 部品                        | 置き場所                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 同期デーモン（`apps/sync`） | k3s。`deploy/k3s/mailhub.yaml`。イメージは GitHub Actions が `ghcr.io/sasagar/mailhub-sync` に作り、keel が入れ替える |
| Postgres                    | k3s のノードで動いている Postgres に `mailhub` DB を作る。Pod からはノード IP（`status.hostIP`）で繋ぐ                |
| Remote MCP（`apps/mcp`）    | Cloudflare Workers。DB へは Hyperdrive（Cloudflare Tunnel 経由）                                                      |

## ロール

| ロール        | 使うもの                 | 権限                                                                            |
| ------------- | ------------------------ | ------------------------------------------------------------------------------- |
| `mailhub`     | 同期デーモン             | DB の所有者                                                                     |
| `mailhub_mcp` | Remote MCP（Hyperdrive） | `deploy/sql/grant-mcp.sql` の分だけ。暗号化済みのアプリパスワードの列は読めない |

## 初回だけ

1. DB とロールを作る（パスワードはサーバー上で生成し、画面に出さない）

   ```sh
   sudo -u postgres psql -c "create role mailhub login password '...'"
   sudo -u postgres psql -c "create role mailhub_mcp login password '...'"
   sudo -u postgres psql -c "create database mailhub owner mailhub"
   ```

   `pg_hba.conf` に Pod の CIDR から `mailhub` DB・`mailhub` ロールへの `scram-sha-256` を足して reload する。
   Postgres を公開側のインターフェースで受け付けないこと。

2. Secret を作る。暗号化キーは DB と別の場所（ここ）にだけ置く

   ```sh
   kubectl create namespace mailhub
   kubectl -n mailhub create secret generic mailhub-secret \
     --from-literal=PGPASSWORD='<mailhub のパスワード>' \
     --from-literal=MAILHUB_MASTER_KEY="$(openssl rand -base64 32)"
   ```

   `MAILHUB_MASTER_KEY` はパスワードマネージャーにも控える（失うと保存済みのアプリパスワードを復号できない）。

3. `kubectl apply -f deploy/k3s/mailhub.yaml`。起動時にマイグレーションが走る

4. `deploy/sql/grant-mcp.sql` を `mailhub` DB に流す（マイグレーションでテーブルが増えたら流し直す）

5. アカウント追加は Pod 内で対話実行する

   ```sh
   kubectl -n mailhub exec -it deploy/mailhub-sync -- node_modules/.bin/tsx src/cli/add-account.ts
   kubectl -n mailhub rollout restart deploy/mailhub-sync   # 追加したアカウントを読み込ませる
   ```

## Remote MCP

1. Cloudflare Access に SaaS（OIDC）アプリを作る。リダイレクト URL は `https://<ホスト>/callback`
2. Hyperdrive を作り（接続先は `mailhub_mcp`）、`wrangler.jsonc` の `hyperdrive[].id` を差し替える
3. Secret を入れる: `ACCESS_CLIENT_ID` / `ACCESS_CLIENT_SECRET` / `ACCESS_TOKEN_URL` / `ACCESS_AUTHORIZATION_URL` /
   `ACCESS_JWKS_URL` / `ALLOWED_EMAILS`（`wrangler secret put <名前>`）
4. `pnpm --filter @mailhub/mcp deploy`

## バックアップ

`pg_dump mailhub` を日次で取る。メールは IMAP から作り直せるが、アカウント設定（暗号化済みパスワード）と操作の履歴は IMAP に無い。
復元には dump と `MAILHUB_MASTER_KEY` の両方が要る。
