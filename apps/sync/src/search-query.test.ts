import { describe, expect, it } from 'vite-plus/test'
import { imapCriteria } from './search-query.ts'

describe('imapCriteria', () => {
  it('語句 1 つは件名・差出人・本文のどれか', () => {
    expect(imapCriteria('OBSBOT')).toEqual({ or: [{ subject: 'OBSBOT' }, { from: 'OBSBOT' }, { body: 'OBSBOT' }] })
  })

  it('from: と期間を IMAP の条件に直す', () => {
    expect(imapCriteria('from:kizaiya.jp after:2025/09/28 before:2025-11-30')).toEqual({
      since: new Date(Date.UTC(2025, 8, 28)),
      before: new Date(Date.UTC(2025, 10, 30)),
      from: 'kizaiya.jp',
    })
  })

  it('条件が 2 つ以上なら両方を満たすもの', () => {
    expect(imapCriteria('subject:"ご注文 確認" from:obsbot.com')).toEqual({
      not: { or: [{ not: { subject: 'ご注文 確認' } }, { not: { from: 'obsbot.com' } }] },
    })
  })

  it('直せない書き方はエラーにする', () => {
    expect(() => imapCriteria('(機材屋 OR RODECaster)')).toThrow(/OR/)
    expect(() => imapCriteria('has:attachment')).toThrow(/has:/)
    expect(() => imapCriteria('-spam')).toThrow(/除外/)
    expect(() => imapCriteria('after:2025年')).toThrow(/日付/)
  })
})
