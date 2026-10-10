// 常駐エージェント（mydot）向けの入口 /svc/mcp。
// /mcp は claude.ai などの OAuth クライアント用で、Access for SaaS（OIDC）を上流にして Worker 自身がトークンを出す。
// 常駐エージェントはブラウザでの同意ができないので、こちらは Cloudflare Access の self-hosted アプリ
// （Service Token の non_identity ポリシー）で守り、Worker は Access が付ける Cf-Access-Jwt-Assertion を検証する。
// ヘッダーの有無ではなく、署名・発行元（iss）・宛先（aud）・期限（exp）を確かめる
import { Buffer } from 'node:buffer'
import type { Props, Scope } from './scopes.ts'

export const SVC_ROUTE = '/svc/mcp'

// 読み取りと整理（既読・アーカイブ・迷惑メール・下書き）。送信は無い（MCP に送信のツールは無く、削除も Web 画面だけ）。
// 書き込み系をどこまで自動で使うかは、エージェント側の承認で決める
const SVC_SCOPES: Scope[] = ['mail.read', 'mail.triage']

type AccessClaims = {
  iss: string
  aud: string | string[]
  exp: number
  nbf?: number
  // Service Token のときは Client ID、人のときはメールアドレスが入る
  common_name?: string
  email?: string
  sub: string
}

type Jwk = JsonWebKey & { kid: string }
let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | undefined
const JWKS_TTL_MS = 60 * 60_000

async function signingKey(teamDomain: string, kid: string): Promise<Jwk | undefined> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`
  const fresh = jwksCache?.url === url && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
  let key = fresh ? jwksCache!.keys.find((k) => k.kid === kid) : undefined
  // 鍵の入れ替え直後は手元の一覧に無いので、見つからなければ取り直す
  if (!key) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Access の公開鍵を取得できません: ${res.status}`)
    const { keys } = (await res.json()) as { keys: Jwk[] }
    jwksCache = { url, keys, fetchedAt: Date.now() }
    key = keys.find((k) => k.kid === kid)
  }
  return key
}

export async function verifyAccessJwt(token: string, teamDomain: string, aud: string): Promise<AccessClaims> {
  const [h, p, s] = token.split('.')
  if (!h || !p || !s) throw new Error('JWT の形式が不正です')
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { kid?: string; alg?: string }
  if (header.alg !== 'RS256' || !header.kid) throw new Error(`想定外の署名方式: ${header.alg}`)

  const jwk = await signingKey(teamDomain, header.kid)
  if (!jwk) throw new Error('JWT の鍵が見つかりません')
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'verify',
  ])
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    Buffer.from(s, 'base64url'),
    new TextEncoder().encode(`${h}.${p}`),
  )
  if (!ok) throw new Error('JWT の署名が不正です')

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as AccessClaims
  const now = Date.now() / 1000
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('JWT の期限切れ')
  if (claims.nbf !== undefined && claims.nbf > now + 60) throw new Error('JWT がまだ有効になっていません')
  if (claims.iss !== `https://${teamDomain}`) throw new Error(`JWT の発行元が違います: ${claims.iss}`)
  if (!audiences.includes(aud)) throw new Error('JWT の宛先（aud）が違います')
  return claims
}

// 検証を通ったら MCP に渡す権限情報を返す。設定が無い・検証に落ちたら拒否の応答を返す
export async function authorizeService(request: Request, env: Env): Promise<Props | Response> {
  const teamDomain: string = env.SVC_ACCESS_TEAM_DOMAIN
  const aud: string = env.SVC_ACCESS_AUD
  // 設定が入るまでは閉じておく（Access の外から直接叩かれても通さない）
  if (!teamDomain || !aud) return new Response('この入口はまだ有効になっていません', { status: 503 })
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return new Response('Cf-Access-Jwt-Assertion がありません', { status: 401 })
  try {
    const claims = await verifyAccessJwt(token, teamDomain, aud)
    const who = claims.common_name ?? claims.email ?? claims.sub
    return { email: who, scopes: SVC_SCOPES, clientName: `svc:${who}` }
  } catch (err) {
    console.warn(`/svc/mcp を拒否: ${(err as Error).message}`)
    return new Response('認証できませんでした', { status: 403 })
  }
}
