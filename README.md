# mailhub

複数のメールアカウント（Gmail・iCloud・独自ドメインなど）を IMAP でまとめ、状態を自前の Postgres に一元化する個人用メーラー。
端末ごとに同期状態を持たせず、一括操作はサーバー側で 1 回で実行する。エージェント（Claude など）からは Remote MCP で操作する。

```
IMAP サーバー群 ⇄ 同期デーモン（apps/sync, k3s） ⇄ Postgres ⇄ Remote MCP（apps/mcp, Cloudflare Workers） ⇄ MCP クライアント
```

- **同期**: IMAP IDLE で変化を受け取り、5 分ごとに CONDSTORE の差分とサーバー・DB の UID 突き合わせで取りこぼしを直す
- **操作**: MCP などは `operations` テーブルに積むだけ。同期デーモンがフォルダごとに IMAP の MOVE 1 回で実行する
- **認証**: Remote MCP は OAuth 2.1（`@cloudflare/workers-oauth-provider`）。ログインは Cloudflare Access に任せ、
  同意画面でトークンごとに `mail.read` / `mail.triage` を選ぶ
- アプリパスワードは AES-256-GCM で暗号化して保存し、鍵は DB と別の場所（k3s の Secret）に置く

## 開発

```sh
pnpm install
docker compose up -d postgres
cp .env.example .env            # MAILHUB_MASTER_KEY を入れる
pnpm account:add                # アカウントを追加（IMAP ログインを確かめてから保存）
pnpm sync                       # 同期デーモン
pnpm verify                     # DB とサーバーを UID 単位で突き合わせる
pnpm --filter @mailhub/mcp dev  # Remote MCP（apps/mcp/.dev.vars が要る）
```

チェックとテストは Vite+: `pnpm check`（整形・lint・型）、`pnpm test`。デプロイは [deploy/README.md](deploy/README.md)。
