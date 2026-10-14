import { describe, expect, it } from 'vite-plus/test'
import { composeMessage } from './send.ts'

const options = {
  from: { name: '送り主', address: 'me@example.com' },
  to: ['to@example.com'],
  cc: [{ name: 'CC さん', address: 'cc@example.com' }],
  bcc: ['secret@example.com'],
  subject: 'Re: 見積もりの件',
  text: 'ご連絡ありがとうございます。\n',
  messageId: '<abc@example.com>',
  inReplyTo: '<orig@example.org>',
  references: '<root@example.org> <orig@example.org>',
}

describe('composeMessage', () => {
  it('相手に送る原文には Bcc を入れない', async () => {
    const raw = (await composeMessage(options, false)).toString()
    expect(raw).not.toMatch(/^Bcc:/im)
    expect(raw).not.toContain('secret@example.com')
  })

  it('送信済みに保存する原文には Bcc を残す', async () => {
    const raw = (await composeMessage(options, true)).toString()
    expect(raw).toMatch(/^Bcc: secret@example\.com/im)
  })

  it('返信のヘッダーと日本語の件名を付ける', async () => {
    const raw = (await composeMessage(options, false)).toString()
    expect(raw).toMatch(/^In-Reply-To: <orig@example\.org>/im)
    expect(raw).toMatch(/^References: <root@example\.org> <orig@example\.org>/im)
    expect(raw).toMatch(/^Message-ID: <abc@example\.com>/im)
    // 日本語の件名は MIME エンコードされる
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/im)
  })
})

describe('composeMessage の添付', () => {
  it('ファイル名が日本語の添付を付ける', async () => {
    const raw = (
      await composeMessage(
        {
          ...options,
          attachments: [{ filename: '見積書.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4') }],
        },
        false,
      )
    ).toString()
    expect(raw).toMatch(/^Content-Type: multipart\/mixed/im)
    expect(raw).toMatch(/Content-Type: application\/pdf/i)
    expect(raw).toContain(Buffer.from('%PDF-1.4').toString('base64'))
    // 日本語のファイル名は RFC 2231 などでエンコードされる
    expect(raw).toMatch(/^Content-Disposition: attachment;\s+filename/im)
  })
})
