// Worker から積まれた汎用の依頼（requests）を実行する。本文の取得（fetch_body）と送信（send）
import type { Sql } from '@mailhub/db'
import type { Account } from './accounts.ts'
import { fetchBody } from './body.ts'
import { sendDraft } from './send.ts'

type Log = (msg: string) => void

const KEEP_HOURS = 24

export async function runRequest(sql: Sql, accounts: Account[], id: string, log: Log): Promise<void> {
  const [req] = await sql`
    update requests set status = 'running'
    where id = ${id} and status = 'queued'
    returning kind, account_id, params`
  if (!req) return
  const started = Date.now()
  try {
    const account = accounts.find((a) => a.id === req.account_id)
    if (!account) throw new Error('アカウントが見つかりません（無効になっている可能性）')
    if (req.kind === 'fetch_body') {
      const { mailbox, uid } = req.params as { mailbox: string; uid: number }
      await fetchBody(sql, account, { mailbox, uid: Number(uid) })
    } else if (req.kind === 'send') {
      const { draftId } = req.params as { draftId: number }
      const sent = await sendDraft(sql, account, Number(draftId))
      await sql`update requests set result = ${sql.json(sent)} where id = ${id}`
    } else {
      throw new Error(`未対応の依頼です: ${req.kind}`)
    }
    await sql`update requests set status = 'done', finished_at = now() where id = ${id}`
    log(`依頼 #${id} ${req.kind}: ${Date.now() - started} ms`)
  } catch (err) {
    await sql`update requests set status = 'failed', error = ${(err as Error).message}, finished_at = now() where id = ${id}`
    log(`依頼 #${id} ${req.kind} 失敗: ${(err as Error).message}`)
  }
  await sql`delete from requests where created_at < now() - make_interval(hours => ${KEEP_HOURS})`
}
