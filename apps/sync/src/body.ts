// 本文の取得と解析。メールサーバーから原文を取り、postal-mime で解析して message_bodies に一時保存する
import PostalMime, { type Address, type Attachment } from 'postal-mime'
import type { Sql } from '@mailhub/db'
import type { Account } from './accounts.ts'
import { sideConnection } from './imap/side.ts'

const MAX_SOURCE_BYTES = 20 * 1024 * 1024
const INLINE_IMAGE_MAX_BYTES = 1024 * 1024

type Addr = { name: string | null; address: string | null }

export type BodyLocator = { mailbox: string; uid: number }

const addr = (a?: Address): Addr[] =>
  !a
    ? []
    : 'group' in a && a.group
      ? a.group.map((g) => ({ name: g.name || null, address: g.address || null }))
      : [{ name: a.name || null, address: ('address' in a && a.address) || null }]
const addrs = (list?: Address[]) => (list ?? []).flatMap(addr)

// 画面に出ない要素（hidden 属性・display:none・visibility:hidden・文字の大きさ 0・透明）。
// 本人には見えずエージェントにだけ読ませる指示を仕込めるので、テキストにするときに落とす。
// 同じタグが入れ子だと途中までしか落ちないが、そのときは残す側（見せすぎる側）に倒れるだけ
const HIDDEN_ELEMENT =
  /<([a-z][a-z0-9]*)\b[^>]*(?:\shidden(?=[\s=>/])|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|%)?\s*[;"']|opacity\s*:\s*0(?:\.0+)?\s*[;"']|max-height\s*:\s*0(?:px)?\s*[;"']))[^>]*>[\s\S]*?<\/\1\s*>/gi
// ゼロ幅の文字と、表示の向きを変える制御文字（見た目と中身を食い違わせるのに使われる）
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g
export const stripInvisible = (text: string) => text.replace(INVISIBLE_CHARS, '')

// HTML メールのテキスト版（MCP で読ませる用。表示は HTML を使う）
export function htmlToText(html: string): string {
  return stripInvisible(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(HIDDEN_ELEMENT, '')
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
}

export async function fetchBody(sql: Sql, account: Account, loc: BodyLocator): Promise<void> {
  const [cached] = await sql`
    select 1 from message_bodies where account_id = ${account.id} and mailbox = ${loc.mailbox} and uid = ${loc.uid}`
  if (cached) return

  const source = await loadSource(account, loc)

  const parsed = await PostalMime.parse(source)
  const inline = parsed.html ? inlineCidImages(parsed.html, parsed.attachments) : null
  const html = inline?.html ?? null
  // HTML があれば、画面に出ている HTML から作ったテキストをエージェントに読ませる。text/plain を優先すると、
  // 本人が見る HTML とエージェントが読むテキストを別の内容にでき、見えない指示を仕込めるため
  const text = html ? htmlToText(html) : stripInvisible(parsed.text ?? '')
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
}
