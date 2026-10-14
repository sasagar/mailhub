import type { Sql } from '@mailhub/db'
import { decryptSecret, encryptSecret, isLegacySecret } from './crypto.ts'

export type Provider = 'gmail' | 'icloud' | 'generic'

export type Account = {
  id: number
  // 画面・ログに出す短い名前
  label: string
  // 送信するときの差出人名
  fromName: string
  email: string
  provider: Provider
  imapHost: string
  imapPort: number
  smtpHost: string | null
  smtpPort: number | null
  username: string
  authType: 'password' | 'oauth'
  // password ならアプリパスワード、oauth なら Google の更新用トークン（どちらも復号済み）
  secret: string
}

export const PRESETS: Record<
  Exclude<Provider, 'generic'>,
  { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }
> = {
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  icloud: { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
}

export async function loadAccounts(sql: Sql, key: Buffer): Promise<Account[]> {
  const rows = await sql`
    select id, label, from_name, email, provider, imap_host, imap_port, smtp_host, smtp_port, username, auth_type, secret
    from accounts where enabled order by id`
  // 古い形式（AAD なし）の暗号文は、読めたら新しい形式で書き直す
  for (const r of rows) {
    if (!isLegacySecret(r.secret)) continue
    const upgraded = encryptSecret(decryptSecret(r.secret, key, r.email), key, r.email)
    await sql`update accounts set secret = ${upgraded} where id = ${r.id} and secret = ${r.secret}`
    r.secret = upgraded
  }
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    fromName: r.from_name,
    email: r.email,
    provider: r.provider,
    imapHost: r.imap_host,
    imapPort: r.imap_port,
    smtpHost: r.smtp_host,
    smtpPort: r.smtp_port,
    username: r.username,
    authType: r.auth_type,
    secret: decryptSecret(r.secret, key, r.email),
  }))
}
