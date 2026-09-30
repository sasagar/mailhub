import postgres from 'postgres'

export type Sql = postgres.Sql

// Node（同期デーモン）と Workers（Hyperdrive 経由）の両方から使う。
// url を省くと PGHOST / PGUSER / PGPASSWORD / PGDATABASE を読む（k3s ではこちら）。
// bigint 列は文字列で返るので、呼び出し側で Number() / BigInt() に変換する。
export function createSql(url: string | undefined, options: postgres.Options<{}> = {}): Sql {
  const merged = { onnotice: () => {}, ...options }
  return url ? postgres(url, merged) : postgres(merged)
}

export type MailboxRole = 'inbox' | 'archive' | 'all' | 'sent' | 'trash' | 'junk' | 'drafts'
