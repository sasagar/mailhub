// Gmail を OAuth（IMAP の XOAUTH2）で読むための Google とのやり取り。
// 個人用なので、Google Cloud の OAuth クライアントは「デスクトップ アプリ」・公開ステータス「本番環境」（未検証）で作る。
// 「テスト中」のままだと更新用トークンが 7 日で切れる
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GMAIL_SCOPE = 'https://mail.google.com/'

export type GoogleClient = { clientId: string; clientSecret: string }

export function loadGoogleClient(): GoogleClient | null {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

// 更新用トークンが取り消された・期限切れのとき。再認証（google-auth の CLI）が要る
export class GoogleReauthRequired extends Error {}

export function authorizeUrl(
  client: GoogleClient,
  opts: { redirectUri: string; codeChallenge: string; state: string; loginHint?: string },
): string {
  const url = new URL(AUTH_URL)
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    // 更新用トークンを必ず受け取るため（2 回目以降の同意では省かれることがある）
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    state: opts.state,
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  }).toString()
  return url.href
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string }

async function post(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string }
  if (!res.ok) {
    const detail = `${json.error ?? res.status}${json.error_description ? `: ${json.error_description}` : ''}`
    if (json.error === 'invalid_grant') throw new GoogleReauthRequired(`Google の再認証が必要です（${detail}）`)
    throw new Error(`Google のトークン取得に失敗しました（${detail}）`)
  }
  return json
}

export async function exchangeCode(
  client: GoogleClient,
  opts: { code: string; codeVerifier: string; redirectUri: string },
): Promise<{ refreshToken: string; accessToken: string; scope?: string }> {
  const t = await post({
    grant_type: 'authorization_code',
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
  })
  if (!t.refresh_token) throw new Error('更新用トークンが返ってきませんでした。もう一度やり直してください')
  return { refreshToken: t.refresh_token, accessToken: t.access_token, scope: t.scope }
}

// アクセストークンは 1 時間で切れる。期限の 5 分前までは使い回す
const cache = new Map<string, { token: string; expiresAt: number }>()

export async function accessTokenFor(client: GoogleClient, refreshToken: string): Promise<string> {
  const hit = cache.get(refreshToken)
  if (hit && hit.expiresAt - 5 * 60_000 > Date.now()) return hit.token
  const t = await post({
    grant_type: 'refresh_token',
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
  })
  cache.set(refreshToken, { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 })
  return t.access_token
}
