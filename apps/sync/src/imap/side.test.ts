import type { ImapFlow } from 'imapflow'
import { describe, expect, it } from 'vite-plus/test'
import { SideConnection } from './side.ts'

// テストに要る分だけの偽のクライアント
function fakeClient() {
  const c = { usable: true, closed: false, on: () => c, close: () => ((c.closed = true), (c.usable = false)) }
  return c
}
type Fake = ReturnType<typeof fakeClient>

function setup() {
  const made: Fake[] = []
  const side = new SideConnection(async () => {
    const c = fakeClient()
    made.push(c)
    return c as unknown as ImapFlow
  })
  return { side, made }
}

const never = () => new Promise<never>(() => {})

describe('SideConnection', () => {
  it('続けて使うときは同じ接続を使い回す', async () => {
    const { side, made } = setup()
    await side.run(async () => 1)
    await side.run(async () => 2)
    expect(made).toHaveLength(1)
  })

  it('時間切れの処理が終わらないまま残っても、次の依頼は新しい接続で進む', async () => {
    const { side, made } = setup()
    const stuck = side.run(never, AbortSignal.timeout(20))
    await expect(stuck).rejects.toThrow()
    expect(made[0]!.closed).toBe(true)

    const result = await side.run(async (client) => client, AbortSignal.timeout(1000))
    expect(result).toBe(made[1])
  })

  it('繋ぐのが終わらないまま時間切れになっても、後ろが詰まらない', async () => {
    let first = true
    const side = new SideConnection(async () => {
      if (first) return ((first = false), never())
      return fakeClient() as unknown as ImapFlow
    })
    await expect(side.run(async () => 1, AbortSignal.timeout(20))).rejects.toThrow()
    await expect(side.run(async () => 2, AbortSignal.timeout(1000))).resolves.toBe(2)
  })

  it('時間切れの後に繋がった接続は、次の依頼で使う', async () => {
    let finish!: () => void
    const late = fakeClient()
    let calls = 0
    const side = new SideConnection(() => {
      calls++
      return new Promise<ImapFlow>((r) => (finish = () => r(late as unknown as ImapFlow)))
    })
    await expect(side.run(async () => 1, AbortSignal.timeout(20))).rejects.toThrow()
    finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(late.closed).toBe(false)
    await expect(side.run(async (client) => client, AbortSignal.timeout(1000))).resolves.toBe(late)
    expect(calls).toBe(1)
  })

  it('順番待ちの間に時間切れになったものは始めない', async () => {
    const { side } = setup()
    let release!: () => void
    let running!: () => void
    const firstStarted = new Promise<void>((r) => (running = r))
    const first = side.run(
      () =>
        new Promise<void>((r) => {
          release = r
          running()
        }),
    )
    let started = false
    const late = side.run(async () => {
      started = true
    }, AbortSignal.abort())
    await firstStarted
    release()
    await first
    await expect(late).rejects.toThrow()
    expect(started).toBe(false)
  })
})
