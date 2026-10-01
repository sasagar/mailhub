import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { isScope, SCOPES, type Props, type Scope } from '../scopes.ts'
import { renderConsent, securityHeaders } from './html.ts'
import { authorizeUrl, createPkce, exchangeCode, sha256, verifyIdToken } from './upstream.ts'

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers }

const TTL = 600 // 同意からコールバックまでの猶予（秒）
// 本番（https）は __Host- 接頭辞と Secure で縛る。Safari は http://localhost の Secure Cookie を保存しないので、
// ローカル開発（http）のときだけ外す
const isHttps = (request: Request) => new URL(request.url).protocol === 'https:'
const cookieName = (request: Request, base: string) => (isHttps(request) ? `__Host-${base}` : base)
// このブラウザを表す値。同意画面ごとに作り直さない（ブラウザが同じページを 2 回読み込むと、
// 表示中のページと Cookie のトークンが食い違って CSRF 検証に落ちるため）
const BROWSER_COOKIE = 'MAILHUB_BROWSER'
const STATE_COOKIE = 'MAILHUB_STATE'

const cookie = (request: Request, base: string, value: string, maxAge = TTL) =>
  `${cookieName(request, base)}=${value}; HttpOnly;${isHttps(request) ? ' Secure;' : ''} Path=/; SameSite=Lax; Max-Age=${maxAge}`

function readCookie(request: Request, base: string): string | undefined {
  const name = cookieName(request, base)
  return (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

// 同意画面を出した時点で保存するもの。POST ではフォームの csrf_token でこれを引き、同じブラウザからかを確かめる
type Consent = { oauthReqInfo: AuthRequest; browserHash: string }

// 同意画面で選ばれ、Access のログインを挟んでコールバックまで持ち越すもの
type Pending = { oauthReqInfo: AuthRequest; scopes: Scope[]; codeVerifier: string }

// OAuthProvider の defaultHandler。/authorize（同意画面）と /callback（Access からの戻り）を扱う
// Google Search Console の所有確認用ファイル。静的ファイルとして置くと、配信側が .html を省いた URL へ
// 転送（307）してしまい確認に通らないので、Worker がそのままの URL で返す
const SITE_VERIFICATION: Record<string, string> = {
  '/google86918974a41ea5c2.html': 'google-site-verification: google86918974a41ea5c2.html',
}

export const authHandler = {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const url = new URL(request.url)
    const verification = SITE_VERIFICATION[url.pathname]
    if (verification && request.method === 'GET') {
      return new Response(verification, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    try {
      if (url.pathname === '/authorize' && request.method === 'GET') return await showConsent(request, env)
      if (url.pathname === '/authorize' && request.method === 'POST') return await acceptConsent(request, env)
      if (url.pathname === '/callback' && request.method === 'GET') return await callback(request, env)
      return new Response('Not Found', { status: 404 })
    } catch (err) {
      console.error(`${url.pathname}: ${(err as Error).message}`)
      return new Response(`認可に失敗しました: ${(err as Error).message}`, { status: 400 })
    }
  },
}

async function showConsent(request: Request, env: AuthEnv) {
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request)
  if (!oauthReqInfo.clientId) throw new Error('client_id がありません')
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId)

  // 認可リクエストはフォームで往復させず KV に置く（POST で書き換えられないように）
  const browser = readCookie(request, BROWSER_COOKIE) ?? crypto.randomUUID()
  const csrfToken = crypto.randomUUID()
  const consent: Consent = { oauthReqInfo, browserHash: await sha256(browser) }
  await env.OAUTH_KV.put(`consent:${csrfToken}`, JSON.stringify(consent), { expirationTtl: TTL })

  const html = renderConsent({ client, csrfToken, requested: oauthReqInfo.scope.filter(isScope) })
  return new Response(html, {
    headers: securityHeaders([new URL(env.ACCESS_AUTHORIZATION_URL).origin], {
      'Set-Cookie': cookie(request, BROWSER_COOKIE, browser),
    }),
  })
}

async function acceptConsent(request: Request, env: AuthEnv) {
  const form = await request.formData()
  const csrfToken = form.get('csrf_token')
  if (typeof csrfToken !== 'string') throw new Error('csrf_token がありません')
  const saved = await env.OAUTH_KV.get(`consent:${csrfToken}`)
  if (!saved) throw new Error('同意画面の有効期限が切れました。やり直してください')
  const consent = JSON.parse(saved) as Consent
  const browser = readCookie(request, BROWSER_COOKIE)
  if (!browser) throw new Error('Cookie が届いていません（ブラウザが Cookie を保存していない可能性）')
  if ((await sha256(browser)) !== consent.browserHash) throw new Error('同意画面を開いたブラウザと違います')
  await env.OAUTH_KV.delete(`consent:${csrfToken}`)

  // 必須の権限は常に付け、未実装のものは選ばれても付けない
  const chosen = form.getAll('scope').filter((s): s is Scope => typeof s === 'string' && isScope(s))
  const scopes = (Object.keys(SCOPES) as Scope[]).filter(
    (s) => SCOPES[s].required || (SCOPES[s].available && chosen.includes(s)),
  )

  const { verifier, challenge } = await createPkce()
  const state = crypto.randomUUID()
  const pending: Pending = { oauthReqInfo: consent.oauthReqInfo, scopes, codeVerifier: verifier }
  await env.OAUTH_KV.put(`state:${state}`, JSON.stringify(pending), { expirationTtl: TTL })

  const headers = new Headers({
    Location: authorizeUrl(env, {
      redirectUri: new URL('/callback', request.url).href,
      state,
      codeChallenge: challenge,
    }),
  })
  // state をこのブラウザに結び付ける（他人のブラウザでコールバックを踏ませる攻撃を防ぐ）
  headers.append('Set-Cookie', cookie(request, STATE_COOKIE, await sha256(state)))
  return new Response(null, { status: 302, headers })
}

async function callback(request: Request, env: AuthEnv) {
  const url = new URL(request.url)
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  if (!state || !code) throw new Error(url.searchParams.get('error_description') ?? 'state か code がありません')
  if (readCookie(request, STATE_COOKIE) !== (await sha256(state)))
    throw new Error('このブラウザで始めた認可ではありません')
  const saved = await env.OAUTH_KV.get(`state:${state}`)
  if (!saved) throw new Error('認可の有効期限が切れました。やり直してください')
  await env.OAUTH_KV.delete(`state:${state}`)
  const pending = JSON.parse(saved) as Pending

  const idToken = await exchangeCode(env, {
    code,
    redirectUri: new URL('/callback', request.url).href,
    codeVerifier: pending.codeVerifier,
  })
  const claims = await verifyIdToken(env, idToken)

  // Access のポリシーで絞っているが、念のため Worker 側でも許可したアドレスだけ通す
  const allowed = env.ALLOWED_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const email = claims.email?.toLowerCase()
  if (!email || !allowed.includes(email)) throw new Error(`${claims.email ?? '(メール無し)'} は許可されていません`)

  const client = await env.OAUTH_PROVIDER.lookupClient(pending.oauthReqInfo.clientId)
  const props: Props = {
    email,
    scopes: pending.scopes,
    clientName: client?.clientName || pending.oauthReqInfo.clientId,
  }
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.oauthReqInfo,
    userId: claims.sub,
    metadata: { label: props.clientName },
    scope: pending.scopes,
    props,
  })
  const headers = new Headers({ Location: redirectTo })
  headers.append('Set-Cookie', cookie(request, STATE_COOKIE, '', 0))
  return new Response(null, { status: 302, headers })
}
