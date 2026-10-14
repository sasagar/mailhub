// 自分のドメイン（love-rox.cc など）を差出人にするメールを、agentic-inbox（Cloudflare Email Service）から送る。
// Gmail の send-as で送ると DKIM が gmail.com になり、p=reject のドメイン（kizami.dev・bktsk.app）は相手に拒否される。
// agentic-inbox は d=<差出人のドメイン> で署名するので DMARC を通る。
// 送信口は POST /api/v1/send だけを許した Access の Service Token で呼ぶ（このトークンでは受信箱を読めない）
import { existsSync } from 'node:fs'
import { secret } from './config.ts'

// Secret はまだ作られていないこともある（マウントは optional）。ファイルが無ければ未設定として扱う
function optionalSecret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`]
  return file && !existsSync(file) ? undefined : secret(name)
}

export type AgenticInboxConfig = {
  url: string
  domains: string[]
  clientId: string
  clientSecret: string
}

// 送信口を使う設定が揃っていなければ null（その場合は今までどおり SMTP で送る）
export function loadAgenticInbox(): AgenticInboxConfig | null {
  const clientId = optionalSecret('AGENTIC_INBOX_CLIENT_ID')
  const clientSecret = optionalSecret('AGENTIC_INBOX_CLIENT_SECRET')
  const domains = (process.env.AGENTIC_INBOX_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  if (!clientId || !clientSecret || domains.length === 0) return null
  return {
    url: process.env.AGENTIC_INBOX_URL ?? 'https://agentic-inbox.love-rox.cc',
    domains,
    clientId,
    clientSecret,
  }
}

// この差出人のメールを agentic-inbox から送るか。サブドメインは別の送信ドメインになるので、完全一致だけ
export function usesAgenticInbox(config: AgenticInboxConfig | null, from: string): config is AgenticInboxConfig {
  const domain = from.split('@').pop()?.toLowerCase()
  return !!config && !!domain && config.domains.includes(domain)
}

export type SendPayload = {
  from: { email: string; name: string }
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  attachments?: { content: string; filename: string; type: string; disposition: 'attachment' }[]
  // <> なしの Message-ID
  in_reply_to?: string
  references?: string[]
}

// Web 画面は送信の結果を 25 秒待つ。その中に収まるよう、短めに区切って 3 回まで
const TIMEOUT_MS = 15_000
const ATTEMPTS = 3
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 送って、相手（Email Service）が付けた Message-ID（<> 付き）を返す。
// 同じ Idempotency-Key で送り直すと、送り終わっていれば前回の結果が返るだけで二重には送られない。
// なので、応答が来なかったとき（タイムアウト・接続断）と送信中（409）は、同じキーで送り直す
export async function sendViaAgenticInbox(
  config: AgenticInboxConfig,
  payload: SendPayload,
  idempotencyKey: string,
  { fetch: fetchImpl = fetch, retryDelayMs = 1000 }: { fetch?: typeof fetch; retryDelayMs?: number } = {},
): Promise<string> {
  // 受け口は To を 1 件以上必須にしている（Cc・Bcc だけのメールは送れない）
  if (payload.to.length === 0) throw new Error('自分のドメインから送るときは、宛先（To）が 1 件以上必要です')
  // 再送で中身が変わると 422 になるので、本文は一度だけ組み立てる
  const body = JSON.stringify(payload)
  let lastError = ''
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await wait(retryDelayMs * 2 ** (attempt - 2))
    let res: Response
    try {
      res = await fetchImpl(new URL('/api/v1/send', config.url), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'CF-Access-Client-Id': config.clientId,
          'CF-Access-Client-Secret': config.clientSecret,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      lastError = `agentic-inbox に届きませんでした: ${(err as Error).message}`
      continue
    }
    const data = (await res.json().catch(() => ({}))) as { messageId?: string; error?: string; code?: string }
    if (res.ok && data.messageId) return `<${data.messageId.replace(/^<|>$/g, '')}>`
    if (res.status === 409) {
      lastError = 'agentic-inbox で同じ下書きの送信がまだ終わっていません'
      continue
    }
    // ここから先は、送られていないことが確かな失敗（キーは解放されている）か、設定の誤り
    throw new Error(describe(res, data))
  }
  // 送れたかどうか分からない。同じ版のまま送り直せば、送れていた場合は前回の結果が返る
  throw new Error(`${lastError}。送れたかどうか分からないので、内容を変えずにもう一度送ると確かめられます`)
}

function describe(res: Response, data: { error?: string; code?: string }): string {
  const detail = data.error ? `: ${data.error}` : ''
  switch (res.status) {
    case 404:
      return `agentic-inbox に差出人の受信箱がありません${detail}`
    case 429:
      return `agentic-inbox の送信の上限に達しました（1 時間 20 通・1 日 100 通）${detail}`
    case 502:
      return `agentic-inbox から送れませんでした（${data.code ?? 'SEND_FAILED'}）${detail}`
    case 302:
    case 401:
    case 403:
      return `agentic-inbox に認証で断られました（${res.status}）。Service Token と Access の設定を確かめてください`
    default:
      return `agentic-inbox がエラーを返しました（${res.status}）${detail}`
  }
}
