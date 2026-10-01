// Web 画面を、この Worker 自身の OAuth の公開クライアント（PKCE）として動かす。
// 同意画面と Cloudflare Access のログインは MCP と共通で、権限（mail.read / mail.triage）も同じ仕組み
const STORE = 'mailhub.auth'
const PENDING = 'mailhub.auth.pending'
const SCOPE = 'mail.read mail.triage'

type Stored = { clientId?: string; accessToken?: string; refreshToken?: string; expiresAt?: number }
type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number }

// ストレージは使えないこと（プライベートブラウズ等）があるので、失敗しても動くようにする
function read<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function write(storage: Storage, key: string, value: unknown) {
  try {
    if (value == null) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(value))
  } catch {
    // 保存できなくても、このタブの間は動く
  }
}

let memory: Stored = read<Stored>(localStorage, STORE) ?? {}
const save = (next: Stored) => {
  memory = next
  write(localStorage, STORE, next)
}

const redirectUri = () => `${location.origin}/`
const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

async function ensureClient(): Promise<string> {
  if (memory.clientId) return memory.clientId
  const res = await fetch('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'mailhub Web',
      redirect_uris: [redirectUri()],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    }),
  })
  if (!res.ok) throw new Error(`クライアント登録に失敗しました（${res.status}）`)
  const { client_id } = (await res.json()) as { client_id: string }
  save({ clientId: client_id })
  return client_id
}

export async function login(): Promise<never> {
  const clientId = await ensureClient()
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)))
  write(sessionStorage, PENDING, { verifier, state })
  const url = new URL('/authorize', location.origin)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: SCOPE,
    // トークンの宛先。MCP と同じ（画面の API も /mcp の配下にある）
    resource: `${location.origin}/mcp`,
    state,
  }).toString()
  location.assign(url)
  return new Promise<never>(() => {})
}

async function token(body: Record<string, string>): Promise<boolean> {
  const res = await fetch('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  if (!res.ok) return false
  const t = (await res.json()) as TokenResponse
  save({
    clientId: memory.clientId,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? memory.refreshToken,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
  })
  return true
}

// 認可から戻ってきたとき（?code=…）にトークンへ交換する。戻りでなければ何もしない
export async function completeLoginIfReturning(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const code = params.get('code')
  const error = params.get('error')
  if (!code && !error) return
  history.replaceState(null, '', '/')
  if (error) throw new Error(params.get('error_description') ?? error)
  const pending = read<{ verifier: string; state: string }>(sessionStorage, PENDING)
  write(sessionStorage, PENDING, null)
  if (!pending || pending.state !== params.get('state') || !memory.clientId) {
    throw new Error('ログインの途中情報が見つかりません。もう一度ログインしてください')
  }
  const ok = await token({
    grant_type: 'authorization_code',
    code: code!,
    redirect_uri: redirectUri(),
    client_id: memory.clientId,
    code_verifier: pending.verifier,
    resource: `${location.origin}/mcp`,
  })
  if (!ok) throw new Error('トークンを受け取れませんでした。もう一度ログインしてください')
}

async function refresh(): Promise<boolean> {
  if (!memory.refreshToken || !memory.clientId) return false
  return token({
    grant_type: 'refresh_token',
    refresh_token: memory.refreshToken,
    client_id: memory.clientId,
    resource: `${location.origin}/mcp`,
  })
}

export const isLoggedIn = () => Boolean(memory.accessToken || memory.refreshToken)

export function logout() {
  save({ clientId: memory.clientId })
}

// API を呼ぶ。期限切れなら更新し、それでも 401 なら未ログイン扱いにする
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!memory.accessToken || (memory.expiresAt ?? 0) - 60_000 < Date.now()) await refresh()
  const send = () => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${memory.accessToken ?? ''}`)
    headers.set('Content-Type', 'application/json')
    return fetch(path, { ...init, headers })
  }
  let res = await send()
  if (res.status === 401 && (await refresh())) res = await send()
  if (res.status === 401) {
    logout()
    throw new LoggedOut()
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  return body
}

export class LoggedOut extends Error {
  constructor() {
    super('ログインが切れました')
  }
}
