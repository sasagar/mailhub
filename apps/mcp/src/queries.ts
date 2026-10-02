import type { Sql } from '@mailhub/db'

// 利用者に見せてよい理由付きの失敗（見つからない・取得に失敗した・時間切れなど）。
// 画面の API はこれを「内部エラー」にまとめず、メッセージをそのまま返す
export class UserError extends Error {}

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
  const aliases = await sql`select account_id, address, from_name from aliases order by address`
  const accounts = await sql`
    select a.id, a.email, a.label, a.from_name, b.synced_at,
      count(m.id)::int as total,
      count(m.id) filter (where not ('\\Seen' = any(m.flags)))::int as unread,
      (select count(*)::int from messages jm join mailboxes jb on jb.id = jm.mailbox_id and jb.role = 'junk'
        where jm.account_id = a.id) as junk
    from accounts a
    left join mailboxes b on b.account_id = a.id and b.role = 'inbox'
    left join messages m on m.mailbox_id = b.id
    where a.enabled
    group by a.id, b.synced_at
    order by a.id`
  return accounts.map((a) => ({
    account: a.email,
    label: a.label,
    fromName: a.from_name,
    // 送信に使えるエイリアス（差出人として選べる）
    aliases: aliases.filter((l) => l.account_id === a.id).map((l) => ({ address: l.address, fromName: l.from_name })),
    total: a.total,
    unread: a.unread,
    // 迷惑メールフォルダの件数
    junk: a.junk,
    syncedAt: a.synced_at?.toISOString() ?? null,
  }))
}

export type ListFilter = {
  // 受信トレイ（既定）か迷惑メールフォルダか
  folder?: 'inbox' | 'junk'
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
  // 受信トレイ（または迷惑メールフォルダ）だけを対象にする。条件はすべて AND
  const where = sql`
    b.role = ${f.folder ?? 'inbox'} and a.enabled
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

// 移動の操作。archive と spam は受信トレイから、not_spam は迷惑メールフォルダ（から受信トレイへ）
export type MoveAction = 'archive' | 'spam' | 'not_spam'
const sourceRole = (action: MoveAction) => (action === 'not_spam' ? 'junk' : 'inbox')

// 一括アーカイブ（や迷惑メールへの移動）を操作キューに積む。実行は同期デーモン（フォルダごとに IMAP の MOVE 1 回）。
// 移動元に無い ID（既に移動済み・存在しない）は積まずに notFound で返す
export async function enqueueArchive(
  sql: Sql,
  opts: { messageIds: string[]; markSeen: boolean; requestedBy: string; action?: MoveAction },
) {
  const action = opts.action ?? 'archive'
  const ids = [...new Set(opts.messageIds)]
  const rows = await sql`
    select m.id, m.account_id, m.mailbox_id, m.uid, a.email
    from messages m
    join mailboxes b on b.id = m.mailbox_id and b.role = ${sourceRole(action)}
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
        values (${first.account_id}, ${first.mailbox_id}, ${action}, ${bigints(
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
  opts: { addresses: string[]; account?: string; markSeen: boolean; requestedBy: string; action?: MoveAction },
) {
  const addresses = [...new Set(opts.addresses.map((a) => a.toLowerCase()))]
  const rows = await sql`
    select m.id
    from messages m
    join mailboxes b on b.id = m.mailbox_id and b.role = ${sourceRole(opts.action ?? 'archive')}
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
    action: opts.action,
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
    if (!a) throw new UserError(`アカウント ${opts.account} はありません`)
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
    if (row?.status === 'failed') throw new UserError(`検索に失敗しました: ${row.error}`)
  }
  throw new UserError('検索が 25 秒以内に終わりませんでした。条件を絞ってもう一度試してください')
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
  junk: boolean
}

async function locate(sql: Sql, ref: MessageRef): Promise<Located> {
  if ('messageId' in ref) {
    const [r] = await sql`
      select m.id, m.account_id, a.email, b.path, b.role, m.uid, m.flags
      from messages m join mailboxes b on b.id = m.mailbox_id join accounts a on a.id = m.account_id
      where m.id = ${ref.messageId} and a.enabled`
    if (!r) throw new UserError('メールが見つかりません（受信トレイから移動した可能性）')
    return {
      accountId: r.account_id,
      account: r.email,
      mailbox: r.path,
      uid: Number(r.uid),
      messageId: String(r.id),
      unread: !(r.flags as string[]).includes('\\Seen'),
      junk: r.role === 'junk',
    }
  }
  const [a] = await sql`
    select a.id, b.role from accounts a
    left join mailboxes b on b.account_id = a.id and b.path = ${ref.mailbox}
    where a.email = ${ref.account} and a.enabled`
  if (!a) throw new UserError(`アカウント ${ref.account} はありません`)
  return {
    accountId: a.id,
    account: ref.account,
    mailbox: ref.mailbox,
    uid: ref.uid,
    messageId: null,
    unread: null,
    junk: a.role === 'junk',
  }
}

export type MessageBody = {
  account: string
  mailbox: string
  uid: number
  messageId: string | null
  unread: boolean | null
  // 迷惑メールフォルダのメール（画面は画像を読み込まない）
  junk: boolean
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
      if (st?.status === 'failed') throw new UserError(`本文を取得できませんでした: ${st.error}`)
      if (st?.status === 'done') body = await read()
    }
    if (!body)
      throw new UserError(
        '本文の取得が 25 秒以内に終わりませんでした。取得は続いているので、少し待ってもう一度開いてください',
      )
  }
  return {
    account: loc.account,
    mailbox: loc.mailbox,
    uid: loc.uid,
    messageId: loc.messageId,
    unread: loc.unread,
    junk: loc.junk,
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

// ---- 下書きと送信 ----

export type Addr = { name: string | null; address: string }

// 区切り（カンマ・読点・改行・セミコロン）で分ける。ただし引用符と <> の中では区切らない（"Sato, Ichiro" <…> のため）
function splitAddressList(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let angle = false
  for (const ch of input) {
    if (ch === '"') quoted = !quoted
    else if (ch === '<' && !quoted) angle = true
    else if (ch === '>' && !quoted) angle = false
    if (!quoted && !angle && /[,、;\n]/.test(ch)) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

// 「名前 <a@b>」や「a@b」の並びを読む
export function parseAddresses(input: string | string[] | undefined): Addr[] {
  const parts = (Array.isArray(input) ? input : splitAddressList(input ?? '')).map((s) => s.trim()).filter(Boolean)
  return parts.map((p) => {
    const m = /^(.*?)\s*<([^>]+)>$/.exec(p)
    const address = (m ? m[2]! : p).trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new UserError(`メールアドレスの形式が正しくありません: ${p}`)
    const name = m?.[1]?.replace(/^"|"$/g, '').trim()
    return { name: name || null, address }
  })
}

export type Draft = {
  id: string
  account: string
  // 差出人のアドレス（アカウント本体かエイリアス）
  from: string
  to: Addr[]
  cc: Addr[]
  bcc: Addr[]
  subject: string
  body: string
  replyToMessageId: string | null
  inReplyTo: string | null
  status: 'draft' | 'sending' | 'sent' | 'failed'
  error: string | null
  createdBy: string
  updatedAt: string
  sentAt: string | null
}

const draftColumns = (sql: Sql) => sql`
  d.id, a.email, d.from_address, d.to_addrs, d.cc_addrs, d.bcc_addrs, d.subject, d.body_text, d.reply_to_message_id,
  d.in_reply_to, d.status, d.error, d.created_by, d.updated_at, d.sent_at`

const toDraft = (r: Record<string, any>): Draft => ({
  id: String(r.id),
  account: r.email,
  from: r.from_address ?? r.email,
  to: r.to_addrs,
  cc: r.cc_addrs,
  bcc: r.bcc_addrs,
  subject: r.subject,
  body: r.body_text,
  replyToMessageId: r.reply_to_message_id == null ? null : String(r.reply_to_message_id),
  inReplyTo: r.in_reply_to,
  status: r.status,
  error: r.error,
  createdBy: r.created_by,
  updatedAt: r.updated_at?.toISOString(),
  sentAt: r.sent_at?.toISOString() ?? null,
})

async function accountIdFor(sql: Sql, email: string | undefined): Promise<number> {
  const rows = email
    ? await sql`select id from accounts where email = ${email} and enabled`
    : await sql`select id from accounts where enabled order by id`
  if (rows.length === 0) throw new UserError(email ? `アカウント ${email} はありません` : 'アカウントがありません')
  if (!email && rows.length > 1) throw new UserError('アカウントが複数あるので account を指定してください')
  return rows[0]!.id
}

// 差出人として指定されたアドレスが、どのアカウントのものかを引く（本体かエイリアス）
async function resolveIdentity(sql: Sql, address: string): Promise<{ accountId: number; fromAddress: string | null }> {
  const addr = address.trim().toLowerCase()
  const [a] = await sql`select id from accounts where email = ${addr} and enabled`
  if (a) return { accountId: a.id, fromAddress: null }
  const [l] = await sql`
    select l.account_id from aliases l join accounts a on a.id = l.account_id where l.address = ${addr} and a.enabled`
  if (l) return { accountId: l.account_id, fromAddress: addr }
  throw new UserError(`${address} は登録されたアカウントでもエイリアスでもありません`)
}

const quote = (text: string) =>
  text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')

// 下書きを作る。reply_to を渡すと、元のメールから宛先・件名・引用・返信ヘッダーを組み立てる（渡した値が優先）
export async function createDraft(
  sql: Sql,
  opts: {
    account?: string
    to?: string | string[]
    cc?: string | string[]
    bcc?: string | string[]
    subject?: string
    body?: string
    // 差出人のアドレス（アカウント本体かエイリアス）。省略時はアカウント本体。返信ではエイリアス宛てなら自動でそのエイリアス
    from?: string
    replyTo?: MessageRef
    replyAll?: boolean
    createdBy: string
  },
): Promise<Draft> {
  let accountId: number
  let fromAddress: string | null = null
  let to = parseAddresses(opts.to)
  let cc = parseAddresses(opts.cc)
  let subject = opts.subject ?? ''
  let body = opts.body ?? ''
  let inReplyTo: string | null = null
  let references: string | null = null
  let replyToMessageId: string | null = null

  if (opts.replyTo) {
    const orig = await getMessageBody(sql, opts.replyTo, opts.createdBy)
    const [a] = await sql`select id, email from accounts where email = ${orig.account}`
    accountId = a!.id
    const h = orig.headers
    const myEmail = String(a!.email).toLowerCase()
    const aliasRows = await sql`select address from aliases where account_id = ${accountId}`
    const myAliases = new Set(aliasRows.map((l) => String(l.address)))
    const isMine = (x: { address: string | null }) =>
      !!x.address && (x.address.toLowerCase() === myEmail || myAliases.has(x.address.toLowerCase()))
    if (opts.from) {
      const id = await resolveIdentity(sql, opts.from)
      if (id.accountId !== accountId) throw new UserError(`${opts.from} は ${orig.account} の差出人として使えません`)
      fromAddress = id.fromAddress
    } else {
      // 元のメールがエイリアス宛てなら、そのエイリアスから返す
      const hit = [...h.to, ...h.cc].find((x) => !!x.address && myAliases.has(x.address.toLowerCase()))
      fromAddress = hit?.address?.toLowerCase() ?? null
    }
    const replyTarget = (h.replyTo.length ? h.replyTo : h.from ? [h.from] : []).filter((x) => x.address) as Addr[]
    if (to.length === 0) to = replyTarget
    if (opts.replyAll && cc.length === 0) {
      cc = [...h.to, ...h.cc].filter((x): x is Addr => !isMine(x) && !to.some((t) => t.address === x.address))
    }
    if (!opts.subject) subject = /^re:/i.test(h.subject ?? '') ? (h.subject ?? '') : `Re: ${h.subject ?? ''}`
    const when = h.date ? new Date(h.date).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : ''
    const who = h.from?.name ? `${h.from.name} <${h.from.address}>` : (h.from?.address ?? '')
    body = `${body}\n\n${when} ${who}:\n${quote(orig.text.trim())}\n`
    inReplyTo = h.messageId
    references = [h.references, h.messageId].filter(Boolean).join(' ') || null
    replyToMessageId = orig.messageId
  } else if (opts.from) {
    const id = await resolveIdentity(sql, opts.from)
    accountId = id.accountId
    fromAddress = id.fromAddress
  } else {
    accountId = await accountIdFor(sql, opts.account)
  }

  const [row] = await sql`
    insert into drafts ${sql({
      account_id: accountId,
      from_address: fromAddress,
      to_addrs: sql.json(to),
      cc_addrs: sql.json(cc),
      bcc_addrs: sql.json(parseAddresses(opts.bcc)),
      subject,
      body_text: body,
      in_reply_to: inReplyTo,
      references_: references,
      reply_to_message_id: replyToMessageId,
      created_by: opts.createdBy,
    })}
    returning id`
  return getDraft(sql, String(row!.id))
}

export async function getDraft(sql: Sql, id: string): Promise<Draft> {
  const [r] =
    await sql`select ${draftColumns(sql)} from drafts d join accounts a on a.id = d.account_id where d.id = ${id}`
  if (!r) throw new UserError('下書きが見つかりません')
  return toDraft(r)
}

export async function listDrafts(sql: Sql, opts: { includeSent: boolean; limit: number }): Promise<Draft[]> {
  const rows = await sql`
    select ${draftColumns(sql)} from drafts d join accounts a on a.id = d.account_id
    ${opts.includeSent ? sql`` : sql`where d.status <> 'sent'`}
    order by d.updated_at desc limit ${opts.limit}`
  return rows.map(toDraft)
}

export async function updateDraft(
  sql: Sql,
  id: string,
  patch: {
    to?: string | string[]
    cc?: string | string[]
    bcc?: string | string[]
    subject?: string
    body?: string
    from?: string
  },
): Promise<Draft> {
  const set: Record<string, unknown> = { updated_at: new Date() }
  if (patch.from !== undefined) {
    const [d] = await sql`select account_id from drafts where id = ${id}`
    if (!d) throw new UserError('下書きが見つかりません')
    const identity = await resolveIdentity(sql, patch.from)
    if (identity.accountId !== d.account_id)
      throw new UserError(`${patch.from} はこの下書きのアカウントの差出人として使えません`)
    set.from_address = identity.fromAddress
  }
  if (patch.to !== undefined) set.to_addrs = sql.json(parseAddresses(patch.to))
  if (patch.cc !== undefined) set.cc_addrs = sql.json(parseAddresses(patch.cc))
  if (patch.bcc !== undefined) set.bcc_addrs = sql.json(parseAddresses(patch.bcc))
  if (patch.subject !== undefined) set.subject = patch.subject
  if (patch.body !== undefined) set.body_text = patch.body
  const rows = await sql`update drafts set ${sql(set)} where id = ${id} and status in ('draft', 'failed') returning id`
  if (rows.length === 0) throw new UserError('編集できる下書きがありません（送信中か送信済み）')
  return getDraft(sql, id)
}

export async function deleteDraft(sql: Sql, id: string): Promise<void> {
  const rows = await sql`delete from drafts where id = ${id} and status in ('draft', 'failed') returning id`
  if (rows.length === 0) throw new UserError('消せる下書きがありません（送信中か送信済み）')
}

// 送信を同期デーモンに頼み、結果を待つ（mail.send の権限は Web 画面だけ）
export async function sendDraftNow(sql: Sql, id: string, requestedBy: string): Promise<Draft> {
  const draft = await getDraft(sql, id)
  if (draft.status !== 'draft' && draft.status !== 'failed') throw new UserError('送れる状態の下書きではありません')
  const [a] = await sql`select account_id from drafts where id = ${id}`
  const [req] = await sql`
    insert into requests (kind, account_id, params, requested_by)
    values ('send', ${a!.account_id}, ${sql.json({ draftId: Number(id) })}, ${requestedBy})
    returning id`
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400))
    const [st] = await sql`select status, error from requests where id = ${req!.id}`
    if (st?.status === 'failed') throw new UserError(`送信できませんでした: ${st.error}`)
    if (st?.status === 'done') return getDraft(sql, id)
  }
  throw new UserError('送信の結果が 25 秒以内に返りませんでした。下書きの状態を確かめてください')
}

// ---- 添付ファイルとスレッド ----

// 同期デーモンに依頼を積み、終わるまで待つ。結果（requests.result）を返す
async function runDaemonRequest(
  sql: Sql,
  opts: {
    kind: 'fetch_attachment' | 'thread'
    accountId: number
    params: Record<string, unknown>
    requestedBy: string
  },
): Promise<unknown> {
  const [req] = await sql`
    insert into requests (kind, account_id, params, requested_by)
    values (${opts.kind}, ${opts.accountId}, ${sql.json(opts.params as never)}, ${opts.requestedBy})
    returning id`
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300))
    const [st] = await sql`select status, error, result from requests where id = ${req!.id}`
    if (st?.status === 'failed') throw new UserError(st.error as string)
    if (st?.status === 'done') return st.result
  }
  throw new UserError('25 秒以内に終わりませんでした。もう一度試してください')
}

export type Attachment = { filename: string; mimeType: string; content: Uint8Array }

// 添付ファイルを 1 つ返す。番号は read_message の attachments[].index
export async function getAttachment(
  sql: Sql,
  ref: MessageRef,
  index: number,
  requestedBy: string,
): Promise<Attachment> {
  const loc = await locate(sql, ref)
  const read = async () => {
    const [b] = await sql`
      select filename, mime_type, content from attachment_blobs
      where account_id = ${loc.accountId} and mailbox = ${loc.mailbox} and uid = ${loc.uid} and part_index = ${index}`
    return b
  }
  let blob = await read()
  if (!blob) {
    try {
      await runDaemonRequest(sql, {
        kind: 'fetch_attachment',
        accountId: loc.accountId,
        params: { mailbox: loc.mailbox, uid: loc.uid, index },
        requestedBy,
      })
    } catch (err) {
      throw new UserError(`添付ファイルを取得できませんでした: ${(err as Error).message}`)
    }
    blob = await read()
    if (!blob) throw new UserError('添付ファイルを取得できませんでした')
  }
  return { filename: blob.filename, mimeType: blob.mime_type, content: new Uint8Array(blob.content) }
}

export type ThreadItem = {
  account: string
  mailbox: string
  uid: number
  messageId: string | null
  subject: string | null
  from: { name: string | null; address: string | null } | null
  receivedAt: string | null
  unread: boolean
  inInbox: boolean
  sent: boolean
}

// スレッドのメールを古い順に返す（アーカイブ済み・送信済みも含む）
export async function getThread(sql: Sql, ref: MessageRef, requestedBy: string): Promise<{ items: ThreadItem[] }> {
  const loc = await locate(sql, ref)
  try {
    return (await runDaemonRequest(sql, {
      kind: 'thread',
      accountId: loc.accountId,
      params: { mailbox: loc.mailbox, uid: loc.uid },
      requestedBy,
    })) as { items: ThreadItem[] }
  } catch (err) {
    throw new UserError(`スレッドを取得できませんでした: ${(err as Error).message}`)
  }
}
