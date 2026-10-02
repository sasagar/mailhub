import type { ImapFlow } from 'imapflow'
import type { Sql } from '@mailhub/db'
import type { Account } from '../accounts.ts'
import { lastImapError } from '../imap/client.ts'
import { moveTarget, type MailboxRow } from '../imap/mailboxes.ts'

type Log = (msg: string) => void

type Operation = {
  id: string
  mailboxId: number
  kind: 'archive' | 'mark_seen' | 'spam' | 'not_spam' | 'delete'
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

// 積まれている操作を全部こなす。呼び出し側で IMAP の直列化（他のコマンドと重ねない）を保証すること。
// 移動元のフォルダを選択し直すことがある（迷惑メールではない: 迷惑メールフォルダから動かす）ので、
// 終わったら呼び出し側で受信トレイを選択し直す
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
      const count = 'moved' in result ? result.moved : 'deleted' in result ? result.deleted : result.marked
      log(`操作 #${op.id} ${op.kind}: ${count} 通`)
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
  if (client.mailbox === false || client.mailbox.path !== source.path) await client.mailboxOpen(source.path)

  if (op.kind === 'mark_seen') {
    await client.messageFlagsAdd(op.uids, ['\\Seen'], { uid: true })
    // 次の同期を待たずに一覧へ反映する
    await sql`
      update messages set flags = array_append(flags, '\\Seen')
      where mailbox_id = ${source.id} and uid = any(${op.uids}::bigint[]) and not ('\\Seen' = any(flags))`
    return { marked: op.uids.length }
  }

  if (op.kind === 'delete') {
    // 迷惑メールフォルダのものだけ（Worker 側でも絞っている）。\Deleted を付けて EXPUNGE する。
    // 容量がいっぱいで移動できないアカウント（SoftBank）でも、削除なら空けられる
    if (source.role !== 'junk') throw new Error('削除できるのは迷惑メールフォルダのメールだけです')
    const ok = await client.messageDelete(op.uids, { uid: true })
    if (!ok) throw new Error(`削除できませんでした: ${lastImapError(client) ?? 'サーバーが理由を返しませんでした'}`)
    await sql`delete from messages where mailbox_id = ${source.id} and uid = any(${op.uids}::bigint[])`
    return { deleted: op.uids.length }
  }

  const target = moveTarget(op.kind, mailboxes, account.provider)
  if (!target)
    throw new Error(
      op.kind === 'archive' ? 'アーカイブ先のフォルダが見つかりません' : '移動先のフォルダが見つかりません',
    )
  if (target.id === source.id) throw new Error('移動先と移動元が同じです')

  // 既読は移動の前に付ける。移動すると移動先で UID が振り直され、元の UID では指定できなくなる
  if (op.params.markSeen) await client.messageFlagsAdd(op.uids, ['\\Seen'], { uid: true })
  const res = await client.messageMove(op.uids, target.path, { uid: true })
  // 失敗しても imapflow は例外にしない。そのまま DB から消すと、メールは動いていないのに一覧から消え、
  // 次の同期で ID を振り直して戻ってくる（2026-10-02 SoftBank の迷惑メールで起きた）ので、失敗として残す
  if (!res) {
    throw new Error(
      `${target.path} へ移動できませんでした: ${lastImapError(client) ?? 'サーバーが理由を返しませんでした'}`,
    )
  }
  const moved = res.uidMap?.size ?? op.uids.length

  // サーバーで動いたものはすぐ DB からも消す（次の同期を待たずに一覧に反映させる）
  await sql`delete from messages where mailbox_id = ${source.id} and uid = any(${op.uids}::bigint[])`
  return { moved, target: target.path, markedSeen: op.params.markSeen === true }
}
