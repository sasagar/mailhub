// Cloudflare Access（Access for SaaS / OIDC）とのやり取り
import { Buffer } from 'node:buffer'

const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString('base64url')

export async function sha256(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

export async function createPkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: await sha256(verifier) }
}

export function authorizeUrl(env: Env, opts: { redirectUri: string; state: string; codeChallenge: string }): string {
  const url = new URL(env.ACCESS_AUTHORIZATION_URL)
  url.searchParams.set('client_id', env.ACCESS_CLIENT_ID)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', opts.state)
  url.searchParams.set('code_challenge', opts.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.href
}

export async function exchangeCode(env: Env, opts: { code: string; redirectUri: string; codeVerifier: string }) {
  const res = await fetch(env.ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.codeVerifier,
    }),
  })
  if (!res.ok) throw new Error(`Access のトークン交換に失敗: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { id_token?: string }
  if (!body.id_token) throw new Error('Access の応答に id_token がありません')
  return body.id_token
}

type Claims = { iss: string; aud: string | string[]; exp: number; email?: string; name?: string; sub: string }

// 署名・期限に加えて、発行元（iss）と宛先（aud）も確かめる。公式サンプルは後者 2 つを見ていない
export async function verifyIdToken(env: Env, token: string): Promise<Claims> {
  const [h, p, s] = token.split('.')
  if (!h || !p || !s) throw new Error('id_token の形式が不正です')
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { kid: string; alg: string }
  if (header.alg !== 'RS256') throw new Error(`想定外の署名方式: ${header.alg}`)

  const jwks = (await (await fetch(env.ACCESS_JWKS_URL)).json()) as { keys: (JsonWebKey & { kid: string })[] }
  const jwk = jwks.keys.find((k) => k.kid === header.kid)
  if (!jwk) throw new Error('id_token の鍵が見つかりません')
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'verify',
  ])
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    Buffer.from(s, 'base64url'),
    new TextEncoder().encode(`${h}.${p}`),
  )
  if (!ok) throw new Error('id_token の署名が不正です')

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Claims
  // Access の issuer はチームのドメインではなく、アプリごとの URL（.../sso/oidc/<client_id>）。完全一致で比べる
  const expectedIssuer = env.ACCESS_TOKEN_URL.replace(/\/token$/, '')
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.exp < Date.now() / 1000) throw new Error('id_token の期限切れ')
  if (claims.iss !== expectedIssuer) throw new Error(`id_token の発行元が違います: ${claims.iss}`)
  if (!audiences.includes(env.ACCESS_CLIENT_ID)) throw new Error('id_token の宛先が違います')
  return claims
}
