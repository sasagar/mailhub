import type { Sql } from '@mailhub/db'
import { decryptSecret } from './crypto.ts'

export type Provider = 'gmail' | 'icloud' | 'generic'

export type Account = {
  id: number
  label: string
  email: string
  provider: Provider
  imapHost: string
  imapPort: number
  username: string
  password: string
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
    select id, label, email, provider, imap_host, imap_port, username, secret
    from accounts where enabled order by id`
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    email: r.email,
    provider: r.provider,
    imapHost: r.imap_host,
    imapPort: r.imap_port,
    username: r.username,
    password: decryptSecret(r.secret, key),
  }))
}
