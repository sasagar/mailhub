import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  // 画面（web/、app/index.html）と Worker（src/server.ts）を 1 つのプロジェクトでビルドする。
  // アプリは /app/ に置き、トップ（/）は public/index.html の説明ページ（Google の OAuth の確認で
  // ホームページがログイン画面だと通らないため）
  plugins: [react(), cloudflare()],
  // 入り口の指定は画面（client）のビルドだけに効かせる。全体に書くと Worker のビルドにも効いて失敗する
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: { app: 'app/index.html' },
        },
      },
    },
  },
})
