function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`環境変数 ${name} が未設定です`)
  return value
}

export function loadConfig() {
  const masterKey = Buffer.from(required('MAILHUB_MASTER_KEY'), 'base64')
  if (masterKey.length !== 32) throw new Error('MAILHUB_MASTER_KEY は 32 バイトを base64 にしたものにしてください')
  if (!process.env.DATABASE_URL && !process.env.PGHOST) throw new Error('DATABASE_URL か PGHOST を設定してください')
  return {
    databaseUrl: process.env.DATABASE_URL,
    masterKey,
  }
}

export type Config = ReturnType<typeof loadConfig>
