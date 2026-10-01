// スレッド（やり取りのまとまり）を集める。Gmail はスレッド ID で「すべてのメール」を探す（アーカイブ済み・送信済みも入る）。
// それ以外は References / In-Reply-To の Message-ID をたどり、受信トレイ・アーカイブ・送信済みから探す
import type { FetchMessageObject, ImapFlow, SearchObject } from 'imapflow'
import type { Sql } from '@mailhub/db'
import type { Account } from './accounts.ts'
import type { BodyLocator } from './body.ts'
import { sideConnection } from './imap/side.ts'

export type ThreadItem = {
  account: string
  mailbox: string
  uid: number
  // 受信トレイにあるメールなら mailhub の ID
  messageId: string | null
  subject: string | null
  from: { name: string | null; address: string | null } | null
  receivedAt: string | null
  unread: boolean
  inInbox: boolean
  // 自分が送ったものか
  sent: boolean
}

const MAX_ITEMS = 100
const MAX_REFERENCES = 30

type Box = { id: number; path: string; role: string }
type Found = { item: ThreadItem; emailId: string | null; boxId: number }

const query = { uid: true, envelope: true, flags: true, internalDate: true, labels: true, emailId: true } as const

function toItem(account: Account, box: Box, m: FetchMessageObject, gmail: boolean): Found {
  const from = m.envelope?.from?.[0]
  return {
    emailId: m.emailId ?? null,
    boxId: box.id,
    item: {
      account: account.email,
      mailbox: box.path,
      uid: m.uid,
      messageId: null,
      subject: m.envelope?.subject ?? null,
      from: from ? { name: from.name ?? null, address: from.address ?? null } : null,
      receivedAt: m.internalDate ? new Date(m.internalDate).toISOString() : null,
      unread: !m.flags?.has('\\Seen'),
      inInbox: gmail ? (m.labels?.has('\\Inbox') ?? false) : box.role === 'inbox',
      sent: gmail ? (m.labels?.has('\\Sent') ?? false) : box.role === 'sent',
    },
  }
}

async function fetchAll(client: ImapFlow, uids: number[]): Promise<FetchMessageObject[]> {
  if (uids.length === 0) return []
  const out: FetchMessageObject[] = []
  for await (const m of client.fetch(uids.sort((a, b) => b - a).slice(0, MAX_ITEMS), query, { uid: true })) out.push(m)
  return out
}

// Message-ID の並び（"<a@x> <b@y>"）を個々の ID にする
const splitIds = (s: string | null | undefined) => (s ?? '').match(/<[^>]+>/g) ?? []

export async function fetchThread(sql: Sql, account: Account, loc: BodyLocator): Promise<{ items: ThreadItem[] }> {
  const boxes = (await sql`
    select id, path, role from mailboxes
    where account_id = ${account.id} and role in ('inbox', 'archive', 'all', 'sent')`) as unknown as Box[]
  const gmail = account.provider === 'gmail'

  const found = await sideConnection(account).run(async (client) => {
    // まず起点のメールのスレッド ID と参照ヘッダーを取る
    const lock = await client.getMailboxLock(loc.mailbox, { readOnly: true })
    let origin: FetchMessageObject | false | undefined
    try {
      origin = await client.fetchOne(
        String(loc.uid),
        { uid: true, envelope: true, threadId: true, headers: ['references'] },
        { uid: true },
      )
    } finally {
      lock.release()
    }
    if (!origin) throw new Error('メールが見つかりません（移動・削除された可能性）')

    const out: Found[] = []
    if (gmail) {
      const all = boxes.find((b) => b.role === 'all')
      if (!all || !origin.threadId) return out
      const l = await client.getMailboxLock(all.path, { readOnly: true })
      try {
        const uids = (await client.search({ threadId: origin.threadId }, { uid: true })) || []
        for (const m of await fetchAll(client, uids)) out.push(toItem(account, all, m, true))
      } finally {
        l.release()
      }
      return out
    }

    // Gmail 以外: 起点の Message-ID と、参照している Message-ID を集める
    const own = origin.envelope?.messageId ?? null
    const refs = splitIds(origin.headers?.toString().replace(/\r?\n[ \t]+/g, ' ')).slice(-MAX_REFERENCES)
    const ids = [...new Set([...refs, ...splitIds(origin.envelope?.inReplyTo), ...(own ? [own] : [])])]
    const criteria: SearchObject[] = ids.map((id) => ({ header: { 'message-id': id } }))
    // 起点に返信してきたものも拾う
    if (own) criteria.push({ header: { 'in-reply-to': own } }, { header: { references: own } })
    if (criteria.length === 0) return out
    const search: SearchObject = criteria.length === 1 ? criteria[0]! : { or: criteria }

    for (const box of boxes.filter((b) => b.role !== 'all')) {
      const l = await client.getMailboxLock(box.path, { readOnly: true })
      try {
        const uids = (await client.search(search, { uid: true })) || []
        for (const m of await fetchAll(client, uids)) out.push(toItem(account, box, m, false))
      } finally {
        l.release()
      }
    }
    return out
  })

  // 受信トレイにあるものに mailhub の ID を付ける（そのまま開いたりアーカイブしたりできるように）
  const inbox = boxes.find((b) => b.role === 'inbox')
  if (inbox) {
    const emailIds = found.filter((f) => f.item.inInbox && f.emailId).map((f) => f.emailId!)
    const uids = found.filter((f) => f.boxId === inbox.id).map((f) => f.item.uid)
    if (emailIds.length + uids.length > 0) {
      const rows = await sql`
        select id, uid, gm_msgid from messages
        where mailbox_id = ${inbox.id} and (gm_msgid = any(${emailIds}::text[]) or uid = any(${uids}::bigint[]))`
      const byEmail = new Map(rows.filter((r) => r.gm_msgid).map((r) => [r.gm_msgid as string, String(r.id)]))
      const byUid = new Map(rows.map((r) => [Number(r.uid), String(r.id)]))
      for (const f of found) {
        f.item.messageId =
          (f.emailId ? byEmail.get(f.emailId) : undefined) ??
          (f.boxId === inbox.id ? byUid.get(f.item.uid) : undefined) ??
          null
      }
    }
  }

  // 同じメールが受信トレイとアーカイブの両方に出ることはないが、念のためフォルダ・UID で重複を除き、古い順に並べる
  const seen = new Set<string>()
  const items = found
    .map((f) => f.item)
    .filter((i) => {
      const k = `${i.mailbox}:${i.uid}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? ''))
  return { items }
}
