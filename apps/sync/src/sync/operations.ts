import type { ImapFlow } from 'imapflow'
import type { Sql } from '@mailhub/db'
import type { Account } from '../accounts.ts'
import { archiveTarget, type MailboxRow } from '../imap/mailboxes.ts'

type Log = (msg: string) => void

type Operation = {
  id: string
  mailboxId: number
  kind: 'archive'
  uids: number[]
  params: { markSeen?: boolean }
}

// 前回の実行中に落ちたものをやり直せるように戻す。MOVE は同じ UID に 2 回かけても害が無い
export async function requeueStale(sql: Sql, accountId: number) {
  await sql`update operations set status = 'queued', started_at = null where account_id = ${accountId} and status = 'running'`
}

// 1 件取り出して running にする。無ければ null
async function claim(sql: Sql, accountId: number): Promise<Operation | null> {
  const [row] = await sql`
    update operations set status = 'running', started_at = now()
    where id = (
      select id from operations
      where account_id = ${accountId} and status = 'queued'
      order by id limit 1
      for update skip locked
    )
    returning id, mailbox_id, kind, uids, params`
  if (!row) return null
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    kind: row.kind,
    uids: (row.uids as string[]).map(Number),
    params: row.params ?? {},
  }
}

// 積まれている操作を全部こなす。呼び出し側で IMAP の直列化（他のコマンドと重ねない）を保証すること
export async function runQueuedOperations(
  sql: Sql,
  client: ImapFlow,
  account: Account,
  mailboxes: MailboxRow[],
  log: Log,
): Promise<boolean> {
  let touched = false
  for (let op = await claim(sql, account.id); op; op = await claim(sql, account.id)) {
    touched = true
    try {
      const result = await execute(sql, client, account, mailboxes, op)
      await sql`update operations set status = 'done', result = ${sql.json(result)}, finished_at = now() where id = ${op.id}`
      log(`操作 #${op.id} ${op.kind}: ${result.moved} 通`)
    } catch (err) {
      const message = (err as Error).message
      await sql`update operations set status = 'failed', error = ${message}, finished_at = now() where id = ${op.id}`
      log(`操作 #${op.id} ${op.kind} 失敗: ${message}`)
    }
  }
  return touched
}

async function execute(sql: Sql, client: ImapFlow, account: Account, mailboxes: MailboxRow[], op: Operation) {
  const source = mailboxes.find((m) => m.id === op.mailboxId)
  if (!source) throw new Error(`mailbox ${op.mailboxId} はこのアカウントのものではありません`)
  if (op.uids.length === 0) return { moved: 0 }

  const target = archiveTarget(mailboxes, account.provider)
  if (!target) throw new Error('アーカイブ先のフォルダが見つかりません')
  if (target.id === source.id) throw new Error('アーカイブ先と移動元が同じです')

  // 段階 1 では INBOX を開きっぱなしにしているので、それ以外が来たら断る
  if (client.mailbox === false || client.mailbox.path !== source.path) {
    throw new Error(`${source.path} は選択中のフォルダではありません`)
  }

  // 既読は移動の前に付ける。移動すると移動先で UID が振り直され、元の UID では指定できなくなる
  if (op.params.markSeen) await client.messageFlagsAdd(op.uids, ['\\Seen'], { uid: true })
  const res = await client.messageMove(op.uids, target.path, { uid: true })
  const moved = res ? (res.uidMap?.size ?? op.uids.length) : 0

  // サーバーで動いたものはすぐ DB からも消す（次の同期を待たずに一覧に反映させる）
  await sql`delete from messages where mailbox_id = ${source.id} and uid = any(${op.uids}::bigint[])`
  return { moved, target: target.path, markedSeen: op.params.markSeen === true }
}
