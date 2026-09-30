import { describe, expect, it } from 'vite-plus/test'
import { planMailboxSync, type ServerState } from './plan.ts'

const server = (over: Partial<ServerState> = {}): ServerState => ({
  uidValidity: 1n,
  uidNext: 100,
  highestModseq: 500n,
  condstore: true,
  ...over,
})

describe('planMailboxSync', () => {
  it('初回は全件取り込み', () => {
    expect(planMailboxSync(null, server())).toEqual({ kind: 'full' })
  })

  it('UIDVALIDITY が変わったら全件取り込み（UID が別物になっている）', () => {
    const stored = { uidValidity: 1n, uidNext: 100, highestModseq: 500n }
    expect(planMailboxSync(stored, server({ uidValidity: 2n }))).toEqual({ kind: 'full' })
  })

  it('何も変わっていなければ新着もフラグ取得もしない', () => {
    const stored = { uidValidity: 1n, uidNext: 100, highestModseq: 500n }
    expect(planMailboxSync(stored, server())).toEqual({
      kind: 'incremental',
      fetchNewFrom: null,
      flags: { mode: 'none' },
    })
  })

  it('UIDNEXT が進んでいたら前回の UIDNEXT から取る', () => {
    const stored = { uidValidity: 1n, uidNext: 100, highestModseq: 500n }
    const plan = planMailboxSync(stored, server({ uidNext: 120, highestModseq: 510n }))
    expect(plan).toMatchObject({ kind: 'incremental', fetchNewFrom: 100 })
  })

  it('MODSEQ が進んでいたら前回の MODSEQ 以降の変更だけ取る', () => {
    const stored = { uidValidity: 1n, uidNext: 100, highestModseq: 500n }
    const plan = planMailboxSync(stored, server({ highestModseq: 510n }))
    expect(plan).toMatchObject({ flags: { mode: 'changedSince', modseq: 500n } })
  })

  it('CONDSTORE 非対応なら毎回全件のフラグを取り直す', () => {
    const stored = { uidValidity: 1n, uidNext: 100, highestModseq: null }
    const plan = planMailboxSync(stored, server({ highestModseq: null, condstore: false }))
    expect(plan).toMatchObject({ flags: { mode: 'all' } })
  })

  it('前回 MODSEQ が無いのに今は CONDSTORE がある: 1 回だけ全件のフラグを取る', () => {
    const stored = { uidValidity: 1n, uidNext: 100, highestModseq: null }
    expect(planMailboxSync(stored, server())).toMatchObject({ flags: { mode: 'all' } })
  })

  it('MODSEQ が戻った: 差分の起点が信用できないので全件のフラグを取る', () => {
    const stored = { uidValidity: 1n, uidNext: 100, highestModseq: 500n }
    expect(planMailboxSync(stored, server({ highestModseq: 400n }))).toMatchObject({ flags: { mode: 'all' } })
  })

  it('UIDNEXT が戻った: 全件取り込み', () => {
    const stored = { uidValidity: 1n, uidNext: 100, highestModseq: 500n }
    expect(planMailboxSync(stored, server({ uidNext: 90 }))).toEqual({ kind: 'full' })
  })
})
