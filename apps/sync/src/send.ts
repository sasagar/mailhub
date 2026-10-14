// 下書きを SMTP で送る。原文は一度だけ組み立て、SMTP と送信済みフォルダへの保存の両方で使う
import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import type { Sql } from '@mailhub/db'
import type { Account } from './accounts.ts'
import { loadAgenticInbox, sendViaAgenticInbox, usesAgenticInbox, type AgenticInboxConfig } from './agentic-inbox.ts'
import { accessTokenFor, loadGoogleClient } from './google.ts'
import { sideConnection } from './imap/side.ts'

type Addr = { name: string | null; address: string }

const fmt = (list: Addr[]) => list.map((a) => (a.name ? { name: a.name, address: a.address } : a.address))

type ComposeOptions = ConstructorParameters<typeof MailComposer>[0]

// 原文を組み立てる。相手に送る原文には Bcc を入れない（入れると Bcc の宛先が全員に見える）。
// 送信済みフォルダに保存する原文にだけ Bcc を残す（keepBcc）
export function composeMessage(options: ComposeOptions, keepBcc: boolean): Promise<Buffer> {
  const node = new MailComposer(options).compile()
  node.keepBcc = keepBcc
  return node.build()
}

// 差出人のドメインによっては agentic-inbox から送る（起動時に一度だけ設定を読む）
let agenticInbox: AgenticInboxConfig | null | undefined
const agenticInboxConfig = () => (agenticInbox === undefined ? (agenticInbox = loadAgenticInbox()) : agenticInbox)

// apps/mcp/src/sending.ts の ATTACHMENT_LIMIT_AGENTIC と同じ
const AGENTIC_INBOX_ATTACHMENT_LIMIT = 3.5 * 1024 * 1024

const bare = (id: string) => id.replace(/^<|>$/g, '')

async function smtpAuth(account: Account) {
  if (account.authType === 'password') return { user: account.username, pass: account.secret }
  const google = loadGoogleClient()
  if (!google) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です')
  return { type: 'OAuth2' as const, user: account.username, accessToken: await accessTokenFor(google, account.secret) }
}

export async function sendDraft(sql: Sql, account: Account, draftId: number): Promise<{ messageId: string }> {
  // Worker が版を確かめて queued にした下書きだけを送る（二重送信も、確認後のすり替えも防ぐ）
  const [d] = await sql`
    update drafts set status = 'sending', error = null, updated_at = now()
    where id = ${draftId} and account_id = ${account.id} and status = 'queued'
    returning *`
  if (!d) throw new Error('送信待ちの下書きがありません（送信中か送信済み）')
  try {
    const to = d.to_addrs as Addr[]
    const cc = d.cc_addrs as Addr[]
    const bcc = d.bcc_addrs as Addr[]
    if (to.length + cc.length + bcc.length === 0) throw new Error('宛先がありません')

    // 差出人はアカウント本体か、登録済みのエイリアス。SMTP の認証と envelope はアカウント本体で行う
    let from = { name: account.fromName, address: account.email }
    if (d.from_address && d.from_address !== account.email) {
      const [alias] =
        await sql`select from_name from aliases where account_id = ${account.id} and address = ${d.from_address}`
      if (!alias) throw new Error(`${d.from_address} は ${account.email} のエイリアスに登録されていません`)
      from = { name: alias.from_name, address: d.from_address }
    }
    // 添付は Web 画面か MCP で付けたもの（付け外しのたびに版が上がるので、確かめた版の添付だけがここに来る）
    const files = await sql`
      select filename, mime_type, content from draft_attachments where draft_id = ${d.id} order by id`
    const attachments = files.map((f) => ({
      filename: f.filename as string,
      contentType: f.mime_type as string,
      content: Buffer.from(f.content as Uint8Array),
    }))
    const options = {
      from,
      to: fmt(to),
      cc: fmt(cc),
      bcc: fmt(bcc),
      subject: d.subject,
      text: d.body_text,
      date: new Date(),
      inReplyTo: d.in_reply_to ?? undefined,
      references: d.references_ ?? undefined,
      attachments,
    }

    let messageId: string
    const config = agenticInboxConfig()
    if (usesAgenticInbox(config, from.address)) {
      // Email Service は 1 通 5 MiB まで（base64 にした添付込み）。送って拒否される前に、分かる言葉で止める
      const total = attachments.reduce((sum, a) => sum + a.content.byteLength, 0)
      if (total > AGENTIC_INBOX_ATTACHMENT_LIMIT) {
        throw new Error(
          `${from.address} から送るメールの添付は合計 3.5MB までです（今は ${(total / 1024 / 1024).toFixed(1)}MB）。添付を減らしてください`,
        )
      }
      // 下書きと版で鍵を作る。同じ版を送り直しても、送れていれば二重には送られない
      messageId = await sendViaAgenticInbox(
        config,
        {
          from: { email: from.address, name: from.name },
          to: to.map((a) => a.address),
          ...(cc.length ? { cc: cc.map((a) => a.address) } : {}),
          ...(bcc.length ? { bcc: bcc.map((a) => a.address) } : {}),
          subject: d.subject,
          text: d.body_text,
          ...(attachments.length
            ? {
                attachments: attachments.map((a) => ({
                  content: a.content.toString('base64'),
                  filename: a.filename,
                  type: a.contentType,
                  disposition: 'attachment' as const,
                })),
              }
            : {}),
          ...(d.in_reply_to ? { in_reply_to: bare(d.in_reply_to) } : {}),
          ...(d.references_ ? { references: (d.references_ as string).split(/\s+/).filter(Boolean).map(bare) } : {}),
        },
        `mailhub-draft-${d.id}-v${d.version}`,
      )
      // アカウントの送信済みにも控えを残す（Gmail の SMTP を通らないので、Gmail でも自動では入らない）。
      // 送れた後なので、控えの保存に失敗しても送信は成功として扱う
      await saveSentCopy(sql, account, await composeMessage({ ...options, messageId }, true)).catch((err: Error) =>
        console.warn(`下書き #${d.id} の控えを送信済みに保存できませんでした: ${err.message}`),
      )
    } else {
      if (!account.smtpHost || !account.smtpPort) throw new Error(`${account.email} の SMTP の設定がありません`)
      const domain = account.email.split('@')[1] ?? 'mailhub.local'
      messageId = `<${randomUUID()}@${domain}>`
      const build = (keepBcc: boolean) => composeMessage({ ...options, messageId }, keepBcc)
      const raw = await build(false)

      const transport = nodemailer.createTransport({
        host: account.smtpHost,
        port: account.smtpPort,
        secure: account.smtpPort === 465,
        // 465 以外（587 など）は STARTTLS を必須にする。経路上で STARTTLS を消されると、
        // nodemailer は平文のまま AUTH に進み、アプリパスワードが平文で流れるため
        requireTLS: account.smtpPort !== 465,
        auth: await smtpAuth(account),
      })
      await transport.sendMail({
        envelope: { from: account.email, to: [...to, ...cc, ...bcc].map((a) => a.address) },
        raw,
      })

      // Gmail は送ったものを自動で送信済みに入れる。それ以外は自分で保存する
      if (account.provider !== 'gmail') await saveSentCopy(sql, account, await build(true))
    }

    await sql`
      update drafts set status = 'sent', sent_message_id = ${messageId}, sent_at = now(), updated_at = now()
      where id = ${draftId}`
    return { messageId }
  } catch (err) {
    await sql`update drafts set status = 'failed', error = ${(err as Error).message}, updated_at = now() where id = ${draftId}`
    throw err
  }
}

async function saveSentCopy(sql: Sql, account: Account, copy: Buffer): Promise<void> {
  const [sent] = await sql`select path from mailboxes where account_id = ${account.id} and role = 'sent'`
  if (sent) await sideConnection(account).run((client) => client.append(sent.path, copy, ['\\Seen']))
}
