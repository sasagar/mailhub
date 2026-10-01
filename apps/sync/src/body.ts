// 本文の取得と解析。メールサーバーから原文を取り、postal-mime で解析して message_bodies に一時保存する
import PostalMime, { type Address, type Attachment } from 'postal-mime'
import type { Sql } from '@mailhub/db'
import type { Account } from './accounts.ts'
import { sideConnection } from './imap/side.ts'

const MAX_SOURCE_BYTES = 20 * 1024 * 1024
const INLINE_IMAGE_MAX_BYTES = 1024 * 1024
const KEEP_DAYS = 7

type Addr = { name: string | null; address: string | null }

export type BodyLocator = { mailbox: string; uid: number }

const addr = (a?: Address): Addr[] =>
  !a
    ? []
    : 'group' in a && a.group
      ? a.group.map((g) => ({ name: g.name || null, address: g.address || null }))
      : [{ name: a.name || null, address: ('address' in a && a.address) || null }]
const addrs = (list?: Address[]) => (list ?? []).flatMap(addr)

// HTML しか無いメールのためのテキスト版（MCP で読ませる用。表示は HTML を使う）
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '・')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const toBase64 = (content: Attachment['content']) =>
  Buffer.from(typeof content === 'string' ? content : new Uint8Array(content)).toString('base64')

// 本文中の画像（cid:）を data: URL に埋め込む。外部に取りに行かずに表示できるように。埋め込んだ添付の番号も返す
function inlineCidImages(html: string, attachments: Attachment[]): { html: string; inlined: Set<number> } {
  const byCid = new Map<string, { url: string; index: number }>()
  attachments.forEach((a, index) => {
    const cid = a.contentId?.replace(/^<|>$/g, '')
    const size = typeof a.content === 'string' ? a.content.length : a.content.byteLength
    if (cid && a.mimeType.startsWith('image/') && size <= INLINE_IMAGE_MAX_BYTES) {
      byCid.set(cid, { url: `data:${a.mimeType};base64,${toBase64(a.content)}`, index })
    }
  })
  const inlined = new Set<number>()
  const out = html.replace(/cid:([^"'\s)>]+)/gi, (m, cid: string) => {
    const hit = byCid.get(decodeURIComponent(cid))
    if (!hit) return m
    inlined.add(hit.index)
    return hit.url
  })
  return { html: out, inlined }
}

// メールの原文を補助の接続で取る。大きすぎるものは断る
async function loadSource(account: Account, loc: BodyLocator): Promise<Buffer> {
  return sideConnection(account).run(async (client) => {
    const lock = await client.getMailboxLock(loc.mailbox, { readOnly: true })
    try {
      const meta = await client.fetchOne(String(loc.uid), { size: true }, { uid: true })
      if (!meta) throw new Error('メールが見つかりません（移動・削除された可能性）')
      if ((meta.size ?? 0) > MAX_SOURCE_BYTES)
        throw new Error(`メールが大きすぎます（${Math.round((meta.size ?? 0) / 1048576)}MB）`)
      const full = await client.fetchOne(String(loc.uid), { source: true }, { uid: true })
      if (!full || !full.source) throw new Error('本文を取得できませんでした')
      return full.source
    } finally {
      lock.release()
    }
  })
}

const ATTACHMENT_KEEP_MINUTES = 60

// 添付ファイルを 1 つ取り出して attachment_blobs に置く。番号は本文の取得で返した attachments[].index と同じ
// （postal-mime の attachments の並び順）
export async function fetchAttachment(sql: Sql, account: Account, loc: BodyLocator, index: number): Promise<void> {
  const [cached] = await sql`
    select 1 from attachment_blobs
    where account_id = ${account.id} and mailbox = ${loc.mailbox} and uid = ${loc.uid} and part_index = ${index}`
  if (!cached) {
    const parsed = await PostalMime.parse(await loadSource(account, loc))
    const a = parsed.attachments[index]
    if (!a) throw new Error(`添付ファイル ${index} 番が見つかりません`)
    const content = Buffer.from(typeof a.content === 'string' ? a.content : new Uint8Array(a.content))
    await sql`
      insert into attachment_blobs ${sql({
        account_id: account.id,
        mailbox: loc.mailbox,
        uid: loc.uid,
        part_index: index,
        filename: a.filename ?? `attachment-${index}`,
        mime_type: a.mimeType || 'application/octet-stream',
        content,
      })}
      on conflict do nothing`
  }
  await sql`delete from attachment_blobs where created_at < now() - make_interval(mins => ${ATTACHMENT_KEEP_MINUTES})`
}

export async function fetchBody(sql: Sql, account: Account, loc: BodyLocator): Promise<void> {
  const [cached] = await sql`
    select 1 from message_bodies where account_id = ${account.id} and mailbox = ${loc.mailbox} and uid = ${loc.uid}`
  if (cached) return

  const source = await loadSource(account, loc)

  const parsed = await PostalMime.parse(source)
  const inline = parsed.html ? inlineCidImages(parsed.html, parsed.attachments) : null
  const html = inline?.html ?? null
  const text = parsed.text?.trim() ? parsed.text : html ? htmlToText(html) : ''
  const headers = {
    subject: parsed.subject ?? null,
    from: parsed.from ? (addr(parsed.from)[0] ?? null) : null,
    to: addrs(parsed.to),
    cc: addrs(parsed.cc),
    replyTo: addrs(parsed.replyTo),
    date: parsed.date ?? null,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references ?? null,
  }
  const attachments = parsed.attachments
    .map((a, index) => ({ a, index }))
    // 本文に埋め込んだ画像は一覧に出さない
    .filter(({ index }) => !inline?.inlined.has(index))
    .map(({ a, index }) => ({
      index,
      filename: a.filename ?? '（名前なし）',
      mimeType: a.mimeType,
      size: typeof a.content === 'string' ? a.content.length : a.content.byteLength,
    }))

  await sql`
    insert into message_bodies ${sql({
      account_id: account.id,
      mailbox: loc.mailbox,
      uid: loc.uid,
      headers: sql.json(headers),
      text_body: text,
      html_body: html,
      attachments: sql.json(attachments),
    })}
    on conflict (account_id, mailbox, uid) do nothing`
  await sql`delete from message_bodies where fetched_at < now() - make_interval(days => ${KEEP_DAYS})`
}
