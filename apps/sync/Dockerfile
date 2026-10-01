FROM node:24-slim
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
