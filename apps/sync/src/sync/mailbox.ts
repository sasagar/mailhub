import type { FetchMessageObject, ImapFlow, MessageAddressObject } from 'imapflow'
import type { Sql } from '@mailhub/db'
import type { MailboxRow } from '../imap/mailboxes.ts'
import { planMailboxSync, type ServerState, type StoredState } from './plan.ts'

const BATCH = 500

type Log = (msg: string) => void

// 1 フォルダを DB と揃える。呼び出し側でそのフォルダを選択しておくこと
export async function syncMailbox(sql: Sql, client: ImapFlow, accountId: number, box: MailboxRow, log: Log) {
  const mailbox = client.mailbox
  if (!mailbox || mailbox.path !== box.path) throw new Error(`${box.path} が選択されていません`)

  // client.mailbox の uidNext / highestModseq は SELECT した時点の値のままで、IDLE 中は更新されない。
  // それを使うと新着もフラグ変更も「変化なし」と判断されるので、毎回 STATUS で取り直す
  const status = await client.status(box.path, { uidNext: true, uidValidity: true, highestModseq: true })
  if (!status || status.uidNext == null || status.uidValidity == null) {
    throw new Error(`${box.path} の STATUS が取れませんでした`)
  }
  const server: ServerState = {
    uidValidity: status.uidValidity,
    uidNext: status.uidNext,
    highestModseq: status.highestModseq ?? null,
    condstore: status.highestModseq != null,
  }
  const stored = await loadStoredState(sql, box.id)
  const plan = planMailboxSync(stored, server)

  if (plan.kind === 'full') {
    log(`${box.path}: 全件取り込み (uidValidity=${server.uidValidity})`)
    await sql`delete from messages where mailbox_id = ${box.id}`
    const n = await fetchMessages(sql, client, accountId, box.id, '1:*')
    log(`${box.path}: ${n} 通`)
  } else {
    if (plan.fetchNewFrom != null) {
      const n = await fetchMessages(sql, client, accountId, box.id, `${plan.fetchNewFrom}:*`, plan.fetchNewFrom)
      if (n > 0) log(`${box.path}: 新着 ${n} 通`)
    }
    if (plan.flags.mode !== 'none') {
      const n = await syncFlags(sql, client, box.id, plan.flags.mode === 'changedSince' ? plan.flags.modseq : undefined)
      if (n > 0) log(`${box.path}: フラグ更新 ${n} 通`)
    }
    const { removed, missing } = await reconcile(sql, client, box.id)
    if (removed > 0) log(`${box.path}: 削除/移動 ${removed} 通`)
    if (missing.length > 0) {
      const n = await fetchMessages(sql, client, accountId, box.id, missing)
      log(`${box.path}: DB に無かった ${n} 通を取り直し`)
    }
  }

  await sql`
    update mailboxes set
      uid_validity = ${server.uidValidity.toString()},
      uid_next = ${server.uidNext},
      highest_modseq = ${server.highestModseq?.toString() ?? null},
      synced_at = now()
    where id = ${box.id}`
}

async function loadStoredState(sql: Sql, mailboxId: number): Promise<StoredState | null> {
  const [row] = await sql`select uid_validity, uid_next, highest_modseq from mailboxes where id = ${mailboxId}`
  if (!row || row.uid_validity == null) return null
  return {
    uidValidity: BigInt(row.uid_validity),
    uidNext: Number(row.uid_next),
    highestModseq: row.highest_modseq == null ? null : BigInt(row.highest_modseq),
  }
}

// range は UID の範囲（"N:*"）か UID の配列。minUid を渡すとそれ未満を捨てる
async function fetchMessages(
  sql: Sql,
  client: ImapFlow,
  accountId: number,
  mailboxId: number,
  range: string | number[],
  minUid = 0,
) {
  let batch: ReturnType<typeof toRow>[] = []
  let count = 0
  const flush = async () => {
    if (batch.length === 0) return
    await sql`
      insert into messages ${sql(batch)}
      on conflict (mailbox_id, uid) do update set flags = excluded.flags, labels = excluded.labels`
    count += batch.length
    batch = []
  }
  // fetch の反復中に別の IMAP コマンドを送るとデッドロックするので、DB 書き込みだけ挟む
  const query = { uid: true, flags: true, envelope: true, size: true, internalDate: true, threadId: true, labels: true }
  for await (const msg of client.fetch(range, query, { uid: true })) {
    // "N:*" は N より大きい UID が無くても最後の 1 通を返すので除外する
    if (msg.uid < minUid) continue
    batch.push(toRow(sql, accountId, mailboxId, msg))
    if (batch.length >= BATCH) await flush()
  }
  await flush()
  return count
}

function toRow(sql: Sql, accountId: number, mailboxId: number, msg: FetchMessageObject) {
  const env = msg.envelope
  // JSON.stringify した文字列を渡すと jsonb に「文字列」として二重に入るので sql.json で包む
  const addrs = (list?: MessageAddressObject[]) =>
    list ? sql.json(list.map((a) => ({ name: a.name ?? null, address: a.address ?? null }))) : null
  return {
    account_id: accountId,
    mailbox_id: mailboxId,
    uid: msg.uid,
    message_id: env?.messageId ?? null,
    in_reply_to: env?.inReplyTo ?? null,
    gm_msgid: msg.emailId ?? null,
    gm_thrid: msg.threadId ?? null,
    subject: env?.subject ?? null,
    from_addr: addrs(env?.from),
    to_addrs: addrs(env?.to),
    cc_addrs: addrs(env?.cc),
    sent_at: env?.date ?? null,
    received_at: msg.internalDate ? new Date(msg.internalDate) : null,
    flags: [...(msg.flags ?? [])],
    labels: [...(msg.labels ?? [])],
    size: msg.size ?? null,
  }
}

async function syncFlags(sql: Sql, client: ImapFlow, mailboxId: number, changedSince?: bigint) {
  const rows: { uid: number; flags: string[]; labels: string[] }[] = []
  const options = changedSince != null ? { uid: true, changedSince } : { uid: true }
  for await (const msg of client.fetch('1:*', { uid: true, flags: true, labels: true }, options)) {
    rows.push({ uid: msg.uid, flags: [...(msg.flags ?? [])], labels: [...(msg.labels ?? [])] })
  }
  if (rows.length === 0) return 0
  const result = await sql`
    update messages m set
      flags = array(select jsonb_array_elements_text(v.value -> 'flags')),
      labels = array(select jsonb_array_elements_text(v.value -> 'labels'))
    from jsonb_array_elements(${sql.json(rows)}) v
    where m.mailbox_id = ${mailboxId} and m.uid = (v.value ->> 'uid')::bigint`
  return result.count
}

// サーバーの UID 一覧と DB を両方向に突き合わせる。
// - サーバーから消えた（別端末でアーカイブ・削除された）ものは DB からも消す
// - サーバーにあるのに DB に無いものを返す。新着は UIDNEXT 以降しか取らないので、
//   一度 DB から消えたもの（アーカイブ直後の先回り削除が外れた等）はここでしか戻らない
async function reconcile(sql: Sql, client: ImapFlow, mailboxId: number) {
  const uids = (await client.search({ all: true }, { uid: true })) || []
  const deleted = await sql`
    delete from messages
    where mailbox_id = ${mailboxId} and not (uid = any(${uids}::bigint[]))`
  const rows = await sql`
    select u from unnest(${uids}::bigint[]) u
    where not exists (select 1 from messages m where m.mailbox_id = ${mailboxId} and m.uid = u)`
  return { removed: deleted.count, missing: rows.map((r) => Number(r.u)) }
}
