import type { ImapFlow } from 'imapflow'
import type { MailboxRole, Sql } from '@mailhub/db'
import type { Provider } from '../accounts.ts'

const ROLE_BY_SPECIAL_USE: Record<string, MailboxRole> = {
  '\\Inbox': 'inbox',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Sent': 'sent',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Drafts': 'drafts',
}

export type MailboxRow = {
  id: number
  path: string
  role: MailboxRole | null
}

// サーバーのフォルダ一覧を DB に反映し、役割（inbox / archive など）を付ける
export async function refreshMailboxes(sql: Sql, client: ImapFlow, accountId: number): Promise<MailboxRow[]> {
  const list = await client.list()
  const rows = list
    .filter((box) => !box.flags.has('\\Noselect'))
    .map((box) => ({
      account_id: accountId,
      path: box.path,
      role: (box.specialUse && ROLE_BY_SPECIAL_USE[box.specialUse]) || null,
    }))
  if (rows.length === 0) return []
  const saved = await sql`
    insert into mailboxes ${sql(rows)}
    on conflict (account_id, path) do update set role = excluded.role
    returning id, path, role`
  return saved.map((r) => ({ id: r.id, path: r.path, role: r.role }))
}

// 一括アーカイブの移動先。
// Gmail は常に All Mail（受信トレイのラベルを外すのと同じ効果）。Gmail に "Archive" という
// ユーザーラベルがあると imapflow が名前から \Archive と推測するが、そこへ移すとラベルが増えるだけになる
export function archiveTarget(mailboxes: MailboxRow[], provider: Provider): MailboxRow | undefined {
  const all = mailboxes.find((m) => m.role === 'all')
  if (provider === 'gmail') return all
  return mailboxes.find((m) => m.role === 'archive') ?? all
}

// 迷惑メールフォルダ。\Junk の印が無いサーバーもあるので、よくある名前でも探す
const JUNK_NAMES = /^(?:.*[/.])?(junk|junk e-?mail|spam|bulk mail|迷惑メール)$/i
export function junkFolder(mailboxes: MailboxRow[]): MailboxRow | undefined {
  return mailboxes.find((m) => m.role === 'junk') ?? mailboxes.find((m) => JUNK_NAMES.test(m.path))
}

export function inboxFolder(mailboxes: MailboxRow[]): MailboxRow | undefined {
  return mailboxes.find((m) => m.role === 'inbox') ?? mailboxes.find((m) => m.path.toUpperCase() === 'INBOX')
}

export type MoveKind = 'archive' | 'spam' | 'not_spam'

// 操作ごとの移動先
export function moveTarget(kind: MoveKind, mailboxes: MailboxRow[], provider: Provider): MailboxRow | undefined {
  if (kind === 'spam') return junkFolder(mailboxes)
  if (kind === 'not_spam') return inboxFolder(mailboxes)
  return archiveTarget(mailboxes, provider)
}
