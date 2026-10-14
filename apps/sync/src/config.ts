import { readFileSync } from 'node:fs'

// 秘密の値は <名前>_FILE（k8s の Secret をファイルとして渡したもの）があればそこから読み、無ければ環境変数から読む。
// 環境変数で渡すと、同じユーザーのプロセスから /proc/<pid>/environ で読めてしまうため、本番はファイルで渡す
export function secret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`]
  return file ? readFileSync(file, 'utf8').trim() : process.env[name]
}

function required(name: string): string {
  const value = secret(name)
  if (!value) throw new Error(`環境変数 ${name}（または ${name}_FILE）が未設定です`)
  return value
}

export function loadConfig() {
  // postgres.js は PGPASSWORD を環境変数から読む。実行中に入れた値は /proc/<pid>/environ には出ない
  const pgPassword = secret('PGPASSWORD')
  if (pgPassword) process.env.PGPASSWORD = pgPassword
  const masterKey = Buffer.from(required('MAILHUB_MASTER_KEY'), 'base64')
  if (masterKey.length !== 32) throw new Error('MAILHUB_MASTER_KEY は 32 バイトを base64 にしたものにしてください')
  if (!process.env.DATABASE_URL && !process.env.PGHOST) throw new Error('DATABASE_URL か PGHOST を設定してください')
  return {
    databaseUrl: process.env.DATABASE_URL,
    masterKey,
  }
}

export type Config = ReturnType<typeof loadConfig>
