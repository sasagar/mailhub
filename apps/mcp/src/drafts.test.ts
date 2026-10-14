import { describe, expect, it } from 'vite-plus/test'
import { draftWarnings } from './queries.ts'

const addr = (address: string) => ({ name: null, address })
const row = (o: Record<string, unknown>) => ({ to_addrs: [], cc_addrs: [], bcc_addrs: [], ...o })

describe('draftWarnings', () => {
  it('返信元のメールにあった宛先だけなら警告しない（大文字小文字は区別しない）', () => {
    expect(draftWarnings(row({ to_addrs: [addr('Boss@corp.com')], reply_expected: ['boss@corp.com'] }))).toEqual([])
  })

  it('返信元に無い宛先（BCC を含む）が入っていれば警告する', () => {
    const w = draftWarnings(
      row({
        to_addrs: [addr('boss@corp.com')],
        bcc_addrs: [addr('attacker@evil.example')],
        reply_expected: ['boss@corp.com'],
      }),
    )
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('attacker@evil.example')
  })

  it('返信先が差出人と違うメールへの返信は警告する', () => {
    expect(draftWarnings(row({ reply_redirected: 'bank@example.com' }))[0]).toContain('bank@example.com')
  })

  it('返信でない下書きは警告しない', () => {
    expect(draftWarnings(row({ to_addrs: [addr('a@example.com')], reply_expected: null }))).toEqual([])
  })
})
