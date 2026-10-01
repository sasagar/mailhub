// 下書きを SMTP で送る。原文は一度だけ組み立て、SMTP と送信済みフォルダへの保存の両方で使う
import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import type { Sql } from '@mailhub/db'
import type { Account } from './accounts.ts'
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

async function smtpAuth(account: Account) {
  if (account.authType === 'password') return { user: account.username, pass: account.secret }
  const google = loadGoogleClient()
  if (!google) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です')
  return { type: 'OAuth2' as const, user: account.username, accessToken: await accessTokenFor(google, account.secret) }
}

export async function sendDraft(sql: Sql, account: Account, draftId: number): Promise<{ messageId: string }> {
  // 二重送信を防ぐため、下書き（または失敗したもの）だけを送信中にする
  const [d] = await sql`
    update drafts set status = 'sending', error = null, updated_at = now()
    where id = ${draftId} and account_id = ${account.id} and status in ('draft', 'failed')
    returning *`
  if (!d) throw new Error('送れる状態の下書きがありません（送信中か送信済み）')
  try {
    if (!account.smtpHost || !account.smtpPort) throw new Error(`${account.email} の SMTP の設定がありません`)
    const to = d.to_addrs as Addr[]
    const cc = d.cc_addrs as Addr[]
    const bcc = d.bcc_addrs as Addr[]
    if (to.length + cc.length + bcc.length === 0) throw new Error('宛先がありません')

    const domain = account.email.split('@')[1] ?? 'mailhub.local'
    const messageId = `<${randomUUID()}@${domain}>`
    const options = {
      from: { name: account.label, address: account.email },
      to: fmt(to),
      cc: fmt(cc),
      bcc: fmt(bcc),
      subject: d.subject,
      text: d.body_text,
      messageId,
      date: new Date(),
      inReplyTo: d.in_reply_to ?? undefined,
      references: d.references_ ?? undefined,
    }
    const build = (keepBcc: boolean) => composeMessage(options, keepBcc)
    const raw = await build(false)

    const transport = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpPort === 465,
      auth: await smtpAuth(account),
    })
    await transport.sendMail({
      envelope: { from: account.email, to: [...to, ...cc, ...bcc].map((a) => a.address) },
      raw,
    })

    // Gmail は送ったものを自動で送信済みに入れる。それ以外は自分で保存する
    if (account.provider !== 'gmail') {
      const [sent] = await sql`select path from mailboxes where account_id = ${account.id} and role = 'sent'`
      if (sent) {
        const copy = await build(true)
        await sideConnection(account).run((client) => client.append(sent.path, copy, ['\\Seen']))
      }
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
