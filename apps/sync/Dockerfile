# ベースイメージはダイジェストで固定する（タグの付け替えで中身が変わらないように）。更新するときはダイジェストごと差し替える
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json packages/db/
COPY apps/sync/package.json apps/sync/
RUN pnpm install --frozen-lockfile --prod --filter @mailhub/sync...
COPY packages/db packages/db
COPY apps/sync apps/sync
WORKDIR /app/apps/sync
USER 1000
# マイグレーションは main.ts の起動時に走る
CMD ["node_modules/.bin/tsx", "src/main.ts"]
