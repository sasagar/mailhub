import type { Sql, TransactionSql } from '@mailhub/db'
import { ATTACHMENT_LIMIT_SMTP, attachmentLimitFor, fmtMB } from './sending.ts'

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

// アカウント 1 つか、モード（個人・仕事など）で絞る。どちらも無ければ全アカウント
export type AccountScope = { account?: string; mode?: string }
const inScope = (sql: Sql, s: AccountScope) =>
  sql`${s.account ? sql`and a.email = ${s.account}` : sql``} ${s.mode ? sql`and a.mode = ${s.mode}` : sql``}`

// 無いモードを渡されたら、黙って 0 件を返さずに断る（エージェントの綴り違いに気づけるよう、あるモードを並べる）
async function assertMode(sql: Sql, mode: string | undefined) {
  if (!mode) return
  const rows = await sql`select distinct mode from accounts where enabled order by mode`
  const modes = rows.map((r) => r.mode as string)
  if (!modes.includes(mode)) throw new UserError(`モード「${mode}」はありません。あるのは ${modes.join('、')} です`)
}

export async function inboxOverview(sql: Sql, opts: { mode?: string } = {}) {
  await assertMode(sql, opts.mode)
  const aliases = await sql`select account_id, address, from_name from aliases order by address`
  const accounts = await sql`
    select a.id, a.email, a.label, a.from_name, a.mode, b.synced_at,
      count(m.id)::int as total,
      count(m.id) filter (where not ('\\Seen' = any(m.flags)))::int as unread,
      (select count(*)::int from messages jm join mailboxes jb on jb.id = jm.mailbox_id and jb.role = 'junk'
        where jm.account_id = a.id) as junk
    from accounts a
    left join mailboxes b on b.account_id = a.id and b.role = 'inbox'
    left join messages m on m.mailbox_id = b.id
    where a.enabled ${opts.mode ? sql`and a.mode = ${opts.mode}` : sql``}
    group by a.id, b.synced_at
    order by a.id`
  return accounts.map((a) => ({
    account: a.email,
    label: a.label,
    // 個人・仕事など。画面ではモードごとに見渡す
    mode: a.mode,
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
  mode?: string
  from?: string
  subject?: string
  unreadOnly?: boolean
  since?: string
  until?: string
  limit: number
  offset: number
}

export async function listMessages(sql: Sql, f: ListFilter) {
  await assertMode(sql, f.mode)
  // 受信トレイ（または迷惑メールフォルダ）だけを対象にする。条件はすべて AND
  const where = sql`
    b.role = ${f.folder ?? 'inbox'} and a.enabled
    ${inScope(sql, f)}
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

export async function senderSummary(sql: Sql, opts: AccountScope & { limit: number }) {
  await assertMode(sql, opts.mode)
  const rows = await sql`
    select lower(m.from_addr -> 0 ->> 'address') as address,
      max(m.from_addr -> 0 ->> 'name') as name,
      count(*)::int as total,
      count(*) filter (where not ('\\Seen' = any(m.flags)))::int as unread,
      max(m.received_at) as latest
    from messages m join mailboxes b on b.id = m.mailbox_id join accounts a on a.id = m.account_id
    where b.role = 'inbox' and a.enabled ${inScope(sql, opts)}
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

// エージェント（MCP）がメールを動かす・既読にする操作の上限（全エージェント合計、直近 1 時間）。
// 1 回あたりの上限（500 通）だけだと、何度も呼べば受信トレイを丸ごと動かせるため。
// 手で頼む大きめの片付けは通り、乗っ取られて繰り返し呼ばれる使い方は止まる程度にする。Web 画面からの操作は数えない
export const AGENT_HOURLY_LIMIT = 3000

// 呼び出し側のトランザクションの中で使う。advisory lock で順番に確かめるので、同時に何本呼ばれても
// 「まだ上限に届いていない」と全部が通ってしまうことはない（ロックはトランザクションの終わりで外れる）
async function assertAgentBudget(sql: Sql, requestedBy: string, adding: number) {
  if (!requestedBy.startsWith('mcp:') || adding === 0) return
  await sql`select pg_advisory_xact_lock(hashtext('mailhub:agent-budget'))`
  const [{ used }] = (await sql`
    select coalesce(sum(cardinality(uids)), 0)::int as used from operations
    where requested_by like 'mcp:%' and created_at > now() - interval '1 hour'`) as unknown as [{ used: number }]
  if (used + adding > AGENT_HOURLY_LIMIT) {
    throw new UserError(
      `エージェントからの操作は 1 時間に ${AGENT_HOURLY_LIMIT} 通までです（直近 1 時間で ${used} 通、今回 ${adding} 通）。` +
        '時間をおくか、本人が Web 画面で操作してください',
    )
  }
}

// 移動の操作。archive と spam は受信トレイから、not_spam は迷惑メールフォルダ（から受信トレイへ）
// delete は移動ではないが、迷惑メールフォルダから同じ形で積む（Web 画面からだけ）
export type MoveAction = 'archive' | 'spam' | 'not_spam' | 'delete'
const sourceRole = (action: MoveAction) => (action === 'not_spam' || action === 'delete' ? 'junk' : 'inbox')

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
    await assertAgentBudget(tx as unknown as Sql, opts.requestedBy, rows.length)
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
  opts: {
    addresses: string[]
    account?: string
    mode?: string
    markSeen: boolean
    requestedBy: string
    action?: MoveAction
    // 1 回に動かせるメールの上限（エージェントからの指定に付ける）。超えたら何もせずに断る
    maxMessages?: number
  },
) {
  await assertMode(sql, opts.mode)
  const addresses = [...new Set(opts.addresses.map((a) => a.toLowerCase()))]
  const rows = await sql`
    select m.id
    from messages m
    join mailboxes b on b.id = m.mailbox_id and b.role = ${sourceRole(opts.action ?? 'archive')}
    join accounts a on a.id = m.account_id and a.enabled
    where lower(m.from_addr -> 0 ->> 'address') in (
      select jsonb_array_elements_text(${sql.json(addresses)})
    )
      ${inScope(sql, opts)}`
  if (rows.length === 0) return { operations: [], notFound: [] }
  if (opts.maxMessages !== undefined && rows.length > opts.maxMessages) {
    throw new UserError(
      `対象が ${rows.length} 通あり、1 回の上限（${opts.maxMessages} 通）を超えています。差出人やアカウントを絞るか、本人に確認してください`,
    )
  }
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
  opts: AccountScope & { query: string; maxResults: number; requestedBy: string },
): Promise<SearchResult> {
  // 絞るときは対象のアカウントを並べて渡す（null なら全アカウント）
  await assertMode(sql, opts.mode)
  let accountIds: number[] | null = null
  if (opts.account || opts.mode) {
    const rows = await sql`select a.id from accounts a where a.enabled ${inScope(sql, opts)}`
    if (rows.length === 0)
      throw new UserError(
        opts.account ? `アカウント ${opts.account} はありません` : `モード「${opts.mode}」のアカウントはありません`,
      )
    accountIds = rows.map((r) => r.id)
  }
  const [req] = await sql`
    insert into search_requests (account_ids, query, max_results, requested_by)
    values (${accountIds}, ${opts.query}, ${opts.maxResults}, ${opts.requestedBy})
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
  const ids = await sql.begin(async (tx) => {
    await assertAgentBudget(tx as unknown as Sql, opts.requestedBy, rows.length)
    const created: string[] = []
    for (const list of groups.values()) {
      const first = list[0]!
      const [op] = await tx`
        insert into operations (account_id, mailbox_id, kind, uids, requested_by)
        values (${first.account_id}, ${first.mailbox_id}, 'mark_seen', ${bigints(
          tx,
          list.map((r) => r.uid),
        )}, ${opts.requestedBy})
        returning id`
      created.push(String(op!.id))
    }
    return created
  })
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

export type DraftAttachment = { id: string; filename: string; mimeType: string; size: number }

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
  status: 'draft' | 'queued' | 'sending' | 'sent' | 'failed'
  error: string | null
  createdBy: string
  updatedBy: string | null
  // エージェント（MCP）が作った、または一度でも変えた下書き。画面で目立たせる
  agentTouched: boolean
  // 送信のときに渡す版。表示していた版と違えば送らない
  version: number
  // 送る前に本人に確かめてほしいこと（返信元に無い宛先など）
  warnings: string[]
  attachments: DraftAttachment[]
  // この差出人で送れる添付の合計（自分のドメインは Email Service の上限で小さい）
  attachmentLimit: number
  updatedAt: string
  sentAt: string | null
}

const draftColumns = (sql: Sql) => sql`
  d.id, a.email, d.from_address, d.to_addrs, d.cc_addrs, d.bcc_addrs, d.subject, d.body_text, d.reply_to_message_id,
  d.in_reply_to, d.status, d.error, d.created_by, d.updated_by, d.agent_touched, d.version, d.reply_expected,
  d.reply_redirected, d.updated_at, d.sent_at,
  (select coalesce(json_agg(json_build_object(
      'id', x.id::text, 'filename', x.filename, 'mimeType', x.mime_type, 'size', x.size) order by x.id), '[]')
   from draft_attachments x where x.draft_id = d.id) as attachments`

// 返信の下書きで、元のメールに無かった宛先や、返信先がすり替えられている可能性を知らせる。
// エージェントが「返信」に見せかけて別の宛先に送らせる（元のメールを引用して持ち出す）のを、送る前に気付けるようにする
export function draftWarnings(r: Record<string, any>): string[] {
  const warnings: string[] = []
  const expected = r.reply_expected as string[] | null
  if (expected) {
    const extra = [...r.to_addrs, ...r.cc_addrs, ...r.bcc_addrs]
      .map((a: Addr) => a.address)
      .filter((a: string) => !expected.includes(a.toLowerCase()))
    if (extra.length > 0) warnings.push(`返信元のメールに無かった宛先が入っています: ${extra.join(', ')}`)
  }
  if (r.reply_redirected) {
    warnings.push(`返信元のメールの返信先（Reply-To）が、差出人（${r.reply_redirected}）と違います`)
  }
  return warnings
}

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
  updatedBy: r.updated_by ?? null,
  agentTouched: r.agent_touched === true,
  version: Number(r.version),
  warnings: draftWarnings(r),
  attachments: r.attachments ?? [],
  attachmentLimit: attachmentLimitFor(r.from_address ?? r.email),
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

// 引用は長くても 20,000 文字まで（エージェント経由で長い機密メールを丸ごと引用させないため）
const QUOTE_LIMIT = 20_000
const quote = (text: string) =>
  (text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}\n（以下略）` : text)
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
  let replyExpected: string[] | null = null
  let replyRedirected: string | null = null

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
    // 返信として自然な宛先（元のメールの差出人・返信先・宛先・CC）。これ以外が入っていれば画面で警告する
    replyExpected = [...replyTarget, ...(h.from ? [h.from] : []), ...h.to, ...h.cc]
      .map((x) => x.address?.toLowerCase())
      .filter((x): x is string => !!x)
    if (h.from?.address && h.replyTo.length > 0 && !h.replyTo.some((x) => x.address === h.from!.address)) {
      replyRedirected = h.from.address
    }
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
      reply_expected: replyExpected ? sql.json(replyExpected) : null,
      reply_redirected: replyRedirected,
      created_by: opts.createdBy,
      updated_by: opts.createdBy,
      agent_touched: opts.createdBy.startsWith('mcp:'),
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

export async function listDrafts(
  sql: Sql,
  opts: { includeSent: boolean; limit: number; mode?: string },
): Promise<Draft[]> {
  await assertMode(sql, opts.mode)
  const rows = await sql`
    select ${draftColumns(sql)} from drafts d join accounts a on a.id = d.account_id
    where true ${opts.includeSent ? sql`` : sql`and d.status <> 'sent'`} ${opts.mode ? sql`and a.mode = ${opts.mode}` : sql``}
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
  // by: 変更した人（mcp:… / web:…）。エージェントは自分たちが作った下書きしか変えられない
  // （本人が書いた下書きの宛先や Bcc を黙って書き換えさせない）
  by: string,
): Promise<Draft> {
  const agent = by.startsWith('mcp:')
  const set: Record<string, unknown> = { updated_at: new Date(), updated_by: by }
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
  const rows = await sql`
    update drafts set ${sql(set)}, version = version + 1, agent_touched = agent_touched or ${agent}
    where id = ${id} and status in ('draft', 'failed') ${agent ? sql`and created_by like 'mcp:%'` : sql``}
    returning id`
  if (rows.length === 0) {
    throw new UserError(
      agent
        ? '編集できる下書きがありません（送信待ち・送信済みか、本人が作った下書き）'
        : '編集できる下書きがありません（送信待ちか送信済み）',
    )
  }
  return getDraft(sql, id)
}

export async function deleteDraft(sql: Sql, id: string, by: string): Promise<void> {
  const agent = by.startsWith('mcp:')
  const rows = await sql`
    delete from drafts
    where id = ${id} and status in ('draft', 'failed') ${agent ? sql`and created_by like 'mcp:%'` : sql``}
    returning id`
  if (rows.length === 0) {
    throw new UserError(
      agent
        ? '消せる下書きがありません（送信待ち・送信済みか、本人が作った下書き）'
        : '消せる下書きがありません（送信待ちか送信済み）',
    )
  }
}

// ---- 下書きの添付ファイル（Web 画面だけ） ----

// 1 回に受け取る大きさの上限（差出人ごとの上限は attachmentLimitFor。こちらはそのうち大きいほう）
export const ATTACHMENT_MAX_TOTAL = ATTACHMENT_LIMIT_SMTP
export const ATTACHMENT_MAX_COUNT = 20

// ファイル名と種類を整える。パスの区切り・制御文字・bidi の文字は落とす（受け取った側で別の拡張子に見せかけないように）
export function normalizeAttachment(filename: string, mimeType: string | null | undefined) {
  const name =
    filename
      .replace(/[\\/]/g, '_')
      // eslint-disable-next-line no-control-regex -- 制御文字を落とすのが目的
      .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .trim()
      .slice(0, 200) || 'attachment'
  const type = (mimeType ?? '').split(';')[0]!.trim().toLowerCase()
  return { filename: name, mimeType: /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream' }
}

// 添付を付け外しする前に、下書きの版を上げて行を押さえる。エージェントは自分たちが作った下書きだけ
// （本人が書いた下書きに、受信メールの添付などを黙って足させない）
const lockDraftForAttachment = (tx: TransactionSql, draftId: string, by: string) => {
  const agent = by.startsWith('mcp:')
  return tx`
    update drafts set version = version + 1, updated_at = now(), updated_by = ${by},
      agent_touched = agent_touched or ${agent}
    where id = ${draftId} and status in ('draft', 'failed') ${agent ? tx`and created_by like 'mcp:%'` : tx``}
    returning id, coalesce(from_address, (select email from accounts a where a.id = account_id)) as sender`
}
const attachmentDenied = (by: string, verb: string) =>
  by.startsWith('mcp:')
    ? `添付を${verb}下書きがありません（送信待ち・送信済みか、本人が作った下書き）`
    : `添付を${verb}下書きがありません（送信待ちか送信済み）`

// 添付を付けて、下書きの版を上げる。送信待ち・送信済みの下書きには付けられない
export async function addDraftAttachment(
  sql: Sql,
  draftId: string,
  file: { filename: string; mimeType: string; content: Uint8Array },
  by: string,
): Promise<Draft> {
  await sql.begin(async (tx) => {
    // 下書きの行を押さえてから数える（同時に付けて上限を超えないように）
    const [d] = await lockDraftForAttachment(tx, draftId, by)
    if (!d) throw new UserError(attachmentDenied(by, '付けられる'))
    const [t] = await tx`
      select count(*)::int as n, coalesce(sum(size), 0)::bigint as total from draft_attachments where draft_id = ${draftId}`
    if (t!.n >= ATTACHMENT_MAX_COUNT) throw new UserError(`添付は ${ATTACHMENT_MAX_COUNT} 個までです`)
    const limit = attachmentLimitFor(d.sender)
    if (Number(t!.total) + file.content.byteLength > limit) {
      throw new UserError(
        `${d.sender} から送るメールの添付は合計 ${fmtMB(limit)} までです` +
          (limit < ATTACHMENT_LIMIT_SMTP
            ? '（自分のドメインの送信サービスの上限）。大きなファイルは共有リンクを本文に入れてください'
            : ''),
      )
    }
    await tx`
      insert into draft_attachments (draft_id, filename, mime_type, size, content)
      values (${draftId}, ${file.filename}, ${file.mimeType}, ${file.content.byteLength}, ${file.content})`
  })
  return getDraft(sql, draftId)
}

export async function removeDraftAttachment(
  sql: Sql,
  draftId: string,
  attachmentId: string,
  by: string,
): Promise<Draft> {
  await sql.begin(async (tx) => {
    const [d] = await lockDraftForAttachment(tx, draftId, by)
    if (!d) throw new UserError(attachmentDenied(by, '外せる'))
    const rows =
      await tx`delete from draft_attachments where id = ${attachmentId} and draft_id = ${draftId} returning id`
    if (rows.length === 0) throw new UserError('添付ファイルが見つかりません')
  })
  return getDraft(sql, draftId)
}

export async function getDraftAttachment(
  sql: Sql,
  draftId: string,
  attachmentId: string,
): Promise<{ filename: string; mimeType: string; content: Uint8Array }> {
  const [a] = await sql`
    select filename, mime_type, content from draft_attachments where id = ${attachmentId} and draft_id = ${draftId}`
  if (!a) throw new UserError('添付ファイルが見つかりません')
  return { filename: a.filename, mimeType: a.mime_type, content: a.content }
}

// 送信を同期デーモンに頼み、結果を待つ（mail.send の権限は Web 画面だけ）
// version は画面に表示していた版。確認した後に中身が変わっていれば送らない（すり替え対策）。
// 一致したら同じ文で queued にするので、依頼を積んでから送るまでの間も変更・削除できない
export async function sendDraftNow(sql: Sql, id: string, version: number, requestedBy: string): Promise<Draft> {
  const [a] = await sql`
    update drafts set status = 'queued', error = null
    where id = ${id} and status in ('draft', 'failed') and version = ${version}
    returning account_id`
  if (!a) {
    const draft = await getDraft(sql, id)
    if (draft.status !== 'draft' && draft.status !== 'failed') throw new UserError('送れる状態の下書きではありません')
    throw new UserError('表示した後に下書きが変更されました。開き直して宛先と本文を確かめてから送ってください')
  }
  const [req] = await sql`
    insert into requests (kind, account_id, params, requested_by)
    values ('send', ${a.account_id}, ${sql.json({ draftId: Number(id) })}, ${requestedBy})
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

// 迷惑メールフォルダを空にする（アカウントを指定すればそのアカウントだけ）。Web 画面からだけ使う
export async function enqueueEmptyJunk(sql: Sql, opts: AccountScope & { requestedBy: string }) {
  await assertMode(sql, opts.mode)
  const rows = await sql`
    select m.id
    from messages m
    join mailboxes b on b.id = m.mailbox_id and b.role = 'junk'
    join accounts a on a.id = m.account_id and a.enabled
    where true ${inScope(sql, opts)}`
  if (rows.length === 0) return { operations: [], notFound: [] }
  return enqueueArchive(sql, {
    messageIds: rows.map((r) => String(r.id)),
    markSeen: false,
    requestedBy: opts.requestedBy,
    action: 'delete',
  })
}
