import { describe, expect, it } from 'vite-plus/test'
import { archiveTarget, moveTarget, type MailboxRow } from './mailboxes.ts'

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

describe('moveTarget', () => {
  it('迷惑メールは \\Junk のフォルダへ、迷惑メールではないものは受信トレイへ', () => {
    const boxes = [box('INBOX', 'inbox'), box('[Gmail]/迷惑メール', 'junk'), box('[Gmail]/すべてのメール', 'all')]
    expect(moveTarget('spam', boxes, 'gmail')?.path).toBe('[Gmail]/迷惑メール')
    expect(moveTarget('not_spam', boxes, 'gmail')?.path).toBe('INBOX')
    expect(moveTarget('archive', boxes, 'gmail')?.path).toBe('[Gmail]/すべてのメール')
  })

  it('\\Junk の印が無ければ名前で探す', () => {
    expect(moveTarget('spam', [box('INBOX', null), box('INBOX.Junk', null)], 'generic')?.path).toBe('INBOX.Junk')
    expect(moveTarget('spam', [box('INBOX', null), box('Junkyard', null)], 'generic')).toBeUndefined()
  })
})
