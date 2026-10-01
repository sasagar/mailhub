// メールサーバー側での検索。Worker が search_requests に積み、ここで実行して結果を書き戻す。
// 同期に使っている接続（INBOX を IDLE で見張っている）は止めたくないので、検索ごとに別の接続を使う
import type { SearchObject } from 'imapflow'
import type { Sql } from '@mailhub/db'
import type { Account } from './accounts.ts'
import { imapClientFor } from './imap/client.ts'

export type SearchHit = {
  account: string
  mailbox: string
  subject: string | null
  from: { name: string | null; address: string | null } | null
  receivedAt: string | null
  unread: boolean
  inInbox: boolean
  // 受信トレイにあるメールなら mailhub の ID（archive_messages に渡せる）
  messageId: string | null
  gmThreadId: string | null
}

type Log = (msg: string) => void

// 古い依頼は消す（結果は一時的なもの）
const KEEP_HOURS = 24

export async function runSearchRequest(sql: Sql, accounts: Account[], id: string, log: Log): Promise<void> {
  const [req] = await sql`
    update search_requests set status = 'running'
    where id = ${id} and status = 'queued'
    returning account_id, query, max_results`
  if (!req) return // 別の誰かが拾った、または既に終わっている

  const targets = req.account_id == null ? accounts : accounts.filter((a) => a.id === req.account_id)
  const started = Date.now()
  try {
    if (targets.length === 0) throw new Error('検索できるアカウントがありません')
    const perAccount = await Promise.allSettled(targets.map((a) => searchAccount(sql, a, req.query, req.max_results)))
    const hits = perAccount
      .flatMap((r) => (r.status === 'fulfilled' ? r.value.hits : []))
      .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))
      .slice(0, req.max_results)
    const totals = perAccount.map((r, i) => ({
      account: targets[i]!.email,
      matched: r.status === 'fulfilled' ? r.value.matched : null,
      error: r.status === 'rejected' ? (r.reason as Error).message : null,
    }))
    if (perAccount.every((r) => r.status === 'rejected')) throw new Error(totals.map((t) => t.error).join(' / '))
    await sql`
      update search_requests set status = 'done', results = ${sql.json({ hits, totals })}, finished_at = now()
      where id = ${id}`
    log(`検索 #${id}「${req.query}」: ${hits.length} 件（${Date.now() - started} ms）`)
  } catch (err) {
    await sql`update search_requests set status = 'failed', error = ${(err as Error).message}, finished_at = now() where id = ${id}`
    log(`検索 #${id} 失敗: ${(err as Error).message}`)
  }
  await sql`delete from search_requests where created_at < now() - make_interval(hours => ${KEEP_HOURS})`
}

async function searchAccount(sql: Sql, account: Account, query: string, max: number) {
  const boxes = await sql`
    select id, path, role from mailboxes
    where account_id = ${account.id} and role in ('inbox', 'archive', 'all')`
  // Gmail は「すべてのメール」1 つに全部入っている（受信トレイのものも）。それ以外は受信トレイとアーカイブ
  const gmail = account.provider === 'gmail'
  const targets = gmail ? boxes.filter((b) => b.role === 'all') : boxes.filter((b) => b.role !== 'all')
  if (targets.length === 0) throw new Error(`${account.email}: 検索するフォルダが見つかりません`)
  const inboxId: number | undefined = boxes.find((b) => b.role === 'inbox')?.id

  // Gmail は Gmail の検索式（本文も対象）。ほかは件名・差出人・本文のどれかに含むもの
  const criteria: SearchObject = gmail
    ? { gmraw: query }
    : { or: [{ subject: query }, { from: query }, { body: query }] }

  const client = await imapClientFor(account)
  client.on('error', () => {})
  await client.connect()
  try {
    const found: Found[] = []
    let matched = 0
    for (const box of targets) {
      const lock = await client.getMailboxLock(box.path, { readOnly: true })
      try {
        const uids = (await client.search(criteria, { uid: true })) || []
        matched += uids.length
        // UID は概ね届いた順なので、大きいほうから取れば新しい順に近い
        const pick = uids.sort((a, b) => b - a).slice(0, max)
        if (pick.length === 0) continue
        const query = {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          labels: true,
          threadId: true,
          emailId: true,
        }
        for await (const m of client.fetch(pick, query, { uid: true })) {
          const from = m.envelope?.from?.[0]
          found.push({
            uid: m.uid,
            emailId: m.emailId ?? null,
            boxId: box.id,
            hit: {
              account: account.email,
              mailbox: box.path,
              subject: m.envelope?.subject ?? null,
              from: from ? { name: from.name ?? null, address: from.address ?? null } : null,
              receivedAt: m.internalDate ? new Date(m.internalDate).toISOString() : null,
              unread: !m.flags?.has('\\Seen'),
              inInbox: gmail ? (m.labels?.has('\\Inbox') ?? false) : box.role === 'inbox',
              messageId: null,
              gmThreadId: m.threadId ?? null,
            },
          })
        }
      } finally {
        lock.release()
      }
    }
    await attachInboxIds(sql, inboxId, found)
    return { hits: found.map((f) => f.hit), matched }
  } finally {
    await client.logout().catch(() => {})
  }
}

// 結果 1 件と、受信トレイの ID を引くための手掛かり
type Found = { hit: SearchHit; uid: number; emailId: string | null; boxId: number }

// 受信トレイにある結果に mailhub の ID を付ける（そのまま archive_messages に渡せるように）
async function attachInboxIds(sql: Sql, inboxId: number | undefined, found: Found[]) {
  if (inboxId == null) return
  // Gmail は「すべてのメール」側の UID しか分からないので、メッセージ ID（X-GM-MSGID）で受信トレイの行を引く
  const emailIds = found.filter((f) => f.hit.inInbox && f.emailId).map((f) => f.emailId!)
  const uids = found.filter((f) => f.boxId === inboxId).map((f) => f.uid)
  if (emailIds.length + uids.length === 0) return
  const rows = await sql`
    select id, uid, gm_msgid from messages
    where mailbox_id = ${inboxId}
      and (gm_msgid = any(${emailIds}::text[]) or uid = any(${uids}::bigint[]))`
  const byEmail = new Map(rows.filter((r) => r.gm_msgid).map((r) => [r.gm_msgid as string, String(r.id)]))
  const byUid = new Map(rows.map((r) => [Number(r.uid), String(r.id)]))
  for (const f of found) {
    f.hit.messageId =
      (f.emailId ? byEmail.get(f.emailId) : undefined) ?? (f.boxId === inboxId ? byUid.get(f.uid) : undefined) ?? null
  }
}
