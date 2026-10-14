import { describe, expect, it } from 'vite-plus/test'
import { sendViaAgenticInbox, usesAgenticInbox, type AgenticInboxConfig } from './agentic-inbox.ts'

const config: AgenticInboxConfig = {
  url: 'https://inbox.example',
  domains: ['love-rox.cc', 'kizami.dev'],
  clientId: 'id',
  clientSecret: 'secret',
}
const payload = { from: { email: 'dev@love-rox.cc', name: 'Dev' }, to: ['a@example.com'], subject: 's', text: 't' }

// 応答を順に返す fetch。呼ばれたときの要求を残す
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Request[] = []
  const fn = (async (url: URL, init: RequestInit) => {
    calls.push(new Request(url, init))
    const next = responses.shift()
    if (!next) throw new Error('想定より多く呼ばれました')
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { fn, calls }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

describe('usesAgenticInbox', () => {
  it('登録したドメインの差出人だけ', () => {
    expect(usesAgenticInbox(config, 'dev@love-rox.cc')).toBe(true)
    expect(usesAgenticInbox(config, 'Support@KIZAMI.dev')).toBe(true)
    expect(usesAgenticInbox(config, 'me@gmail.com')).toBe(false)
    // サブドメインは別の送信ドメイン
    expect(usesAgenticInbox(config, 'x@yorox.love-rox.cc')).toBe(false)
    expect(usesAgenticInbox(null, 'dev@love-rox.cc')).toBe(false)
  })
})

describe('sendViaAgenticInbox', () => {
  it('送れたら Message-ID を <> 付きで返し、鍵と Service Token を付ける', async () => {
    const { fn, calls } = fakeFetch(json(200, { id: 'x', status: 'sent', messageId: 'abc@love-rox.cc' }))
    expect(await sendViaAgenticInbox(config, payload, 'k1', { fetch: fn })).toBe('<abc@love-rox.cc>')
    const req = calls[0]!
    expect(req.url).toBe('https://inbox.example/api/v1/send')
    expect(req.headers.get('Idempotency-Key')).toBe('k1')
    expect(req.headers.get('CF-Access-Client-Id')).toBe('id')
    expect(req.headers.get('Content-Type')).toBe('application/json')
  })

  it('応答が無かったときと送信中（409）は、同じ鍵・同じ本文で送り直す', async () => {
    const { fn, calls } = fakeFetch(
      new Error('timeout'),
      json(409, { error: 'in progress' }),
      json(200, { messageId: '<m@love-rox.cc>' }),
    )
    expect(await sendViaAgenticInbox(config, payload, 'k2', { fetch: fn, retryDelayMs: 0 })).toBe('<m@love-rox.cc>')
    expect(calls).toHaveLength(3)
    const bodies = await Promise.all(calls.map((c) => c.text()))
    expect(new Set(bodies).size).toBe(1)
    expect(new Set(calls.map((c) => c.headers.get('Idempotency-Key')))).toEqual(new Set(['k2']))
  })

  it('送れなかったことが確かな失敗は、送り直さずに理由を返す', async () => {
    const { fn, calls } = fakeFetch(json(502, { error: 'rejected', code: 'E_SENDER' }))
    await expect(sendViaAgenticInbox(config, payload, 'k3', { fetch: fn, retryDelayMs: 0 })).rejects.toThrow(
      /E_SENDER.*rejected/,
    )
    expect(calls).toHaveLength(1)
  })

  it('最後まで応答が無ければ、送れたか分からないと伝える', async () => {
    const { fn } = fakeFetch(new Error('a'), new Error('b'), new Error('c'))
    await expect(sendViaAgenticInbox(config, payload, 'k4', { fetch: fn, retryDelayMs: 0 })).rejects.toThrow(
      /送れたかどうか分からない/,
    )
  })

  it('To が無いと送らない', async () => {
    const { fn, calls } = fakeFetch()
    await expect(sendViaAgenticInbox(config, { ...payload, to: [] }, 'k5', { fetch: fn })).rejects.toThrow(/To/)
    expect(calls).toHaveLength(0)
  })
})
