import type { Sql } from '@mailhub/db'

// Workers では Hyperdrive の推奨どおり fetch_types: false にしている。その状態だと postgres.js は JS の配列を
// Postgres の配列に変換できず "1,2,3" という文字列で送ってしまうので、JSON で渡して SQL 側で bigint[] に組み立てる
const bigints = (
  sql: Pick<Sql, 'json'> & ((...args: Parameters<Sql>) => ReturnType<Sql>),
  values: (string | number)[],
) => sql`array(select v::bigint from jsonb_array_elements_text(${sql.json(values.map(String))}) v)`

// MCP ツールが返す 1 通分。本文はまだ持っていない（段階 2 で追加）
export type MessageSummary = {
  id: string
  account: string
  from: { name: string | null; address: string | null } | null
  subject: string | null
  receivedAt: string | null
  unread: boolean
}

export async function inboxOverview(sql: Sql) {
  const accounts = await sql`
    select a.email, a.label, b.synced_at,
      count(m.id)::int as total,
      count(m.id) filter (where not ('\\Seen' = any(m.flags)))::int as unread
    from accounts a
    left join mailboxes b on b.account_id = a.id and b.role = 'inbox'
    left join messages m on m.mailbox_id = b.id
    where a.enabled
    group by a.id, b.synced_at
    order by a.id`
  return accounts.map((a) => ({
    account: a.email,
    label: a.label,
    total: a.total,
    unread: a.unread,
    syncedAt: a.synced_at?.toISOString() ?? null,
  }))
}

export type ListFilter = {
  account?: string
  from?: string
  subject?: string
  unreadOnly?: boolean
  since?: string
  until?: string
  limit: number
  offset: number
}

export async function listMessages(sql: Sql, f: ListFilter) {
  // 受信トレイだけを対象にする。条件はすべて AND
  const where = sql`
    b.role = 'inbox' and a.enabled
    ${f.account ? sql`and a.email = ${f.account}` : sql``}
    ${f.from ? sql`and (m.from_addr -> 0 ->> 'address') ilike ${'%' + f.from + '%'}` : sql``}
    ${f.subject ? sql`and m.subject ilike ${'%' + f.subject + '%'}` : sql``}
    ${f.unreadOnly ? sql`and not ('\\Seen' = any(m.flags))` : sql``}
    ${f.since ? sql`and m.received_at >= ${f.since}` : sql``}
    ${f.until ? sql`and m.received_at < ${f.until}` : sql``}`
  const [{ total }] = (await sql`
    select count(*)::int as total
    from messages m join mailboxes b on b.id = m.mailbox_id join accounts a on a.id = m.account_id
    where ${where}`) as unknown as [{ total: number }]
  const rows = await sql`
    select m.id, a.email, m.from_addr -> 0 as sender, m.subject, m.received_at, m.flags
    from messages m join mailboxes b on b.id = m.mailbox_id join accounts a on a.id = m.account_id
    where ${where}
    order by m.received_at desc nulls last, m.id desc
    limit ${f.limit} offset ${f.offset}`
  const messages: MessageSummary[] = rows.map((r) => ({
    id: String(r.id),
    account: r.email,
    from: r.sender ?? null,
    subject: r.subject,
    receivedAt: r.received_at?.toISOString() ?? null,
    unread: !(r.flags as string[]).includes('\\Seen'),
  }))
  return { total, offset: f.offset, messages }
}

export async function senderSummary(sql: Sql, opts: { account?: string; limit: number }) {
  const rows = await sql`
    select lower(m.from_addr -> 0 ->> 'address') as address,
      max(m.from_addr -> 0 ->> 'name') as name,
      count(*)::int as total,
      count(*) filter (where not ('\\Seen' = any(m.flags)))::int as unread,
      max(m.received_at) as latest
    from messages m join mailboxes b on b.id = m.mailbox_id join accounts a on a.id = m.account_id
    where b.role = 'inbox' and a.enabled ${opts.account ? sql`and a.email = ${opts.account}` : sql``}
    group by 1
    order by total desc
    limit ${opts.limit}`
  return rows.map((r) => ({
    address: r.address,
    name: r.name,
    total: r.total,
    unread: r.unread,
    latest: r.latest?.toISOString() ?? null,
  }))
}

// 一括アーカイブを操作キューに積む。実行は同期デーモン（フォルダごとに IMAP の MOVE 1 回）。
// 受信トレイに無い ID（既にアーカイブ済み・存在しない）は積まずに notFound で返す
export async function enqueueArchive(sql: Sql, opts: { messageIds: string[]; markSeen: boolean; requestedBy: string }) {
  const ids = [...new Set(opts.messageIds)]
  const rows = await sql`
    select m.id, m.account_id, m.mailbox_id, m.uid, a.email
    from messages m
    join mailboxes b on b.id = m.mailbox_id and b.role = 'inbox'
    join accounts a on a.id = m.account_id and a.enabled
    where m.id = any(${bigints(sql, ids)})`
  const found = new Set(rows.map((r) => String(r.id)))
  const notFound = ids.filter((id) => !found.has(id))

  const groups = Map.groupBy(rows, (r) => `${r.account_id}:${r.mailbox_id}`)
  const operations = await sql.begin(async (tx) => {
    const created: { operationId: string; account: string; count: number }[] = []
    for (const list of groups.values()) {
      const first = list[0]!
      const [op] = await tx`
        insert into operations (account_id, mailbox_id, kind, uids, params, requested_by)
        values (${first.account_id}, ${first.mailbox_id}, 'archive', ${bigints(
          tx,
          list.map((r) => r.uid),
        )},
          ${tx.json({ markSeen: opts.markSeen })}, ${opts.requestedBy})
        returning id`
      created.push({ operationId: String(op!.id), account: first.email, count: list.length })
    }
    return created
  })
  return { operations, notFound }
}

export async function getOperations(sql: Sql, ids: string[]) {
  const rows = await sql`
    select o.id, a.email, o.kind, o.status, cardinality(o.uids) as count, o.params, o.result, o.error,
      o.requested_by, o.created_at, o.finished_at
    from operations o join accounts a on a.id = o.account_id
    where o.id = any(${bigints(sql, ids)})
    order by o.id`
  return rows.map((r) => ({
    operationId: String(r.id),
    account: r.email,
    kind: r.kind,
    status: r.status,
    count: r.count,
    params: r.params,
    result: r.result,
    error: r.error,
    requestedBy: r.requested_by,
    createdAt: r.created_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  }))
}

// 差出人単位でアーカイブを積む（Web 画面の「この差出人をまとめて」や、複数の差出人を選んだとき）。
// ID をブラウザやエージェントから送らずに済む
export async function enqueueArchiveBySenders(
  sql: Sql,
  opts: { addresses: string[]; account?: string; markSeen: boolean; requestedBy: string },
) {
  const addresses = [...new Set(opts.addresses.map((a) => a.toLowerCase()))]
  const rows = await sql`
    select m.id
    from messages m
    join mailboxes b on b.id = m.mailbox_id and b.role = 'inbox'
    join accounts a on a.id = m.account_id and a.enabled
    where lower(m.from_addr -> 0 ->> 'address') in (
      select jsonb_array_elements_text(${sql.json(addresses)})
    )
      ${opts.account ? sql`and a.email = ${opts.account}` : sql``}`
  if (rows.length === 0) return { operations: [], notFound: [] }
  return enqueueArchive(sql, {
    messageIds: rows.map((r) => String(r.id)),
    markSeen: opts.markSeen,
    requestedBy: opts.requestedBy,
  })
}

export type SearchHit = {
  account: string
  mailbox: string
  uid: number
  subject: string | null
  from: { name: string | null; address: string | null } | null
  receivedAt: string | null
  unread: boolean
  inInbox: boolean
  messageId: string | null
  gmThreadId: string | null
}

export type SearchResult = {
  hits: SearchHit[]
  totals: { account: string; matched: number | null; error: string | null }[]
}

// メールサーバー側で検索する。Worker は IMAP に繋がらないので、依頼を積んで同期デーモンの結果を待つ
export async function searchMail(
  sql: Sql,
  opts: { query: string; account?: string; maxResults: number; requestedBy: string },
): Promise<SearchResult> {
  let accountId: number | null = null
  if (opts.account) {
    const [a] = await sql`select id from accounts where email = ${opts.account} and enabled`
    if (!a) throw new Error(`アカウント ${opts.account} はありません`)
    accountId = a.id
  }
  const [req] = await sql`
    insert into search_requests (account_id, query, max_results, requested_by)
    values (${accountId}, ${opts.query}, ${opts.maxResults}, ${opts.requestedBy})
    returning id`
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400))
    const [row] = await sql`select status, results, error from search_requests where id = ${req!.id}`
    if (row?.status === 'done') return row.results as SearchResult
    if (row?.status === 'failed') throw new Error(`検索に失敗しました: ${row.error}`)
  }
  throw new Error('検索が 25 秒以内に終わりませんでした。条件を絞ってもう一度試してください')
}

// 本文を読むときのメールの指定。受信トレイのものは mailhub の ID、それ以外（検索結果）は所在で指定する
export type MessageRef = { messageId: string } | { account: string; mailbox: string; uid: number }

type Located = {
  accountId: number
  account: string
  mailbox: string
  uid: number
  messageId: string | null
  unread: boolean | null
}

async function locate(sql: Sql, ref: MessageRef): Promise<Located> {
  if ('messageId' in ref) {
    const [r] = await sql`
      select m.id, m.account_id, a.email, b.path, m.uid, m.flags
      from messages m join mailboxes b on b.id = m.mailbox_id join accounts a on a.id = m.account_id
      where m.id = ${ref.messageId} and a.enabled`
    if (!r) throw new Error('メールが見つかりません（受信トレイから移動した可能性）')
    return {
      accountId: r.account_id,
      account: r.email,
      mailbox: r.path,
      uid: Number(r.uid),
      messageId: String(r.id),
      unread: !(r.flags as string[]).includes('\\Seen'),
    }
  }
  const [a] = await sql`select id from accounts where email = ${ref.account} and enabled`
  if (!a) throw new Error(`アカウント ${ref.account} はありません`)
  return { accountId: a.id, account: ref.account, mailbox: ref.mailbox, uid: ref.uid, messageId: null, unread: null }
}

export type MessageBody = {
  account: string
  mailbox: string
  uid: number
  messageId: string | null
  unread: boolean | null
  headers: {
    subject: string | null
    from: { name: string | null; address: string | null } | null
    to: { name: string | null; address: string | null }[]
    cc: { name: string | null; address: string | null }[]
    replyTo: { name: string | null; address: string | null }[]
    date: string | null
    messageId: string | null
    inReplyTo: string | null
    references: string | null
  }
  text: string
  html: string | null
  attachments: { index: number; filename: string; mimeType: string; size: number }[]
}

// 本文を返す。一時保存に無ければ同期デーモンに取得を頼んで待つ
export async function getMessageBody(sql: Sql, ref: MessageRef, requestedBy: string): Promise<MessageBody> {
  const loc = await locate(sql, ref)
  const read = async () => {
    const [b] = await sql`
      select headers, text_body, html_body, attachments from message_bodies
      where account_id = ${loc.accountId} and mailbox = ${loc.mailbox} and uid = ${loc.uid}`
    return b
  }
  let body = await read()
  if (!body) {
    const [req] = await sql`
      insert into requests (kind, account_id, params, requested_by)
      values ('fetch_body', ${loc.accountId}, ${sql.json({ mailbox: loc.mailbox, uid: loc.uid })}, ${requestedBy})
      returning id`
    const deadline = Date.now() + 25_000
    while (!body && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      const [st] = await sql`select status, error from requests where id = ${req!.id}`
      if (st?.status === 'failed') throw new Error(`本文を取得できませんでした: ${st.error}`)
      if (st?.status === 'done') body = await read()
    }
    if (!body) throw new Error('本文の取得が 25 秒以内に終わりませんでした')
  }
  return {
    account: loc.account,
    mailbox: loc.mailbox,
    uid: loc.uid,
    messageId: loc.messageId,
    unread: loc.unread,
    headers: body.headers,
    text: body.text_body ?? '',
    html: body.html_body,
    attachments: body.attachments,
  }
}

// 既読にする（受信トレイのメールだけ）。実行は同期デーモン
export async function enqueueMarkSeen(sql: Sql, opts: { messageIds: string[]; requestedBy: string }) {
  const rows = await sql`
    select m.account_id, m.mailbox_id, m.uid
    from messages m join mailboxes b on b.id = m.mailbox_id and b.role = 'inbox'
    where m.id = any(${bigints(sql, opts.messageIds)}) and not ('\\Seen' = any(m.flags))`
  const groups = Map.groupBy(rows, (r) => `${r.account_id}:${r.mailbox_id}`)
  const ids: string[] = []
  for (const list of groups.values()) {
    const first = list[0]!
    const [op] = await sql`
      insert into operations (account_id, mailbox_id, kind, uids, requested_by)
      values (${first.account_id}, ${first.mailbox_id}, 'mark_seen', ${bigints(
        sql,
        list.map((r) => r.uid),
      )}, ${opts.requestedBy})
      returning id`
    ids.push(String(op!.id))
  }
  return { operations: ids, count: rows.length }
}
