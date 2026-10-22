# ベースイメージはダイジェストで固定する（タグの付け替えで中身が変わらないように）。更新するときはダイジェストごと差し替える
FROM node:26.12.1-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec
# Node 25 から corepack が同梱されないので、package.json の packageManager と同じ版の pnpm を入れる
RUN npm install -g pnpm@10.33.0
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
