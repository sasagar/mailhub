import { describe, expect, it } from 'vite-plus/test'
import { archiveTarget, type MailboxRow } from './mailboxes.ts'

const box = (path: string, role: MailboxRow['role']): MailboxRow => ({ id: path.length, path, role })

describe('archiveTarget', () => {
  // 実際に見た Gmail の構成（"Archive" というユーザーラベルが \Archive と推測される）
  const gmail = [box('INBOX', 'inbox'), box('Archive', 'archive'), box('[Gmail]/すべてのメール', 'all')]

  it('Gmail は Archive ラベルがあっても All Mail に移す', () => {
    expect(archiveTarget(gmail, 'gmail')?.path).toBe('[Gmail]/すべてのメール')
  })

  it('Gmail 以外は Archive フォルダを使う', () => {
    expect(archiveTarget([box('INBOX', 'inbox'), box('Archive', 'archive')], 'icloud')?.path).toBe('Archive')
  })
})
