import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  // 画面（web/、index.html）と Worker（src/server.ts）を 1 つのプロジェクトでビルドする
  plugins: [react(), cloudflare()],
})
