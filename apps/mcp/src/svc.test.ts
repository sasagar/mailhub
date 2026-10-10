import { Buffer } from 'node:buffer'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { verifyAccessJwt } from './svc.ts'

const TEAM = 'team.cloudflareaccess.com'
const AUD = 'aud-123'
let keys: CryptoKeyPair
let jwk: JsonWebKey

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
async function sign(claims: Record<string, unknown>, kid = 'k1', key = keys.privateKey) {
  const head = `${b64({ alg: 'RS256', kid })}.${b64(claims)}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head))
  return `${head}.${Buffer.from(sig).toString('base64url')}`
}
const now = () => Math.floor(Date.now() / 1000)
const good = () => ({ iss: `https://${TEAM}`, aud: [AUD], exp: now() + 60, sub: '', common_name: 'client.access' })

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey
})

describe('verifyAccessJwt', () => {
  afterEach(() => vi.unstubAllGlobals())
  const stubCerts = () =>
    vi.stubGlobal('fetch', async () => Response.json({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256' }] }))

  it('署名・発行元・宛先・期限が合えば通す', async () => {
    stubCerts()
    const claims = await verifyAccessJwt(await sign(good()), TEAM, AUD)
    expect(claims.common_name).toBe('client.access')
  })

  it('宛先・発行元・期限が違えば落とす', async () => {
    stubCerts()
    await expect(verifyAccessJwt(await sign({ ...good(), aud: ['other'] }), TEAM, AUD)).rejects.toThrow('aud')
    await expect(verifyAccessJwt(await sign({ ...good(), iss: 'https://evil.example' }), TEAM, AUD)).rejects.toThrow(
      '発行元',
    )
    await expect(verifyAccessJwt(await sign({ ...good(), exp: now() - 1 }), TEAM, AUD)).rejects.toThrow('期限')
  })

  it('別の鍵で署名したものや、中身を書き換えたものは落とす', async () => {
    stubCerts()
    const other = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    await expect(verifyAccessJwt(await sign(good(), 'k1', other.privateKey), TEAM, AUD)).rejects.toThrow('署名')
    const [h, , s] = (await sign(good())).split('.')
    await expect(verifyAccessJwt(`${h}.${b64({ ...good(), aud: [AUD, 'x'] })}.${s}`, TEAM, AUD)).rejects.toThrow('署名')
  })
})
