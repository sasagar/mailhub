import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vite-plus/test'
import { decryptSecret, encryptSecret, isLegacySecret } from './crypto.ts'

const key = randomBytes(32)

describe('encryptSecret / decryptSecret', () => {
  it('同じアカウントなら復号でき、別のアカウントの行に移すと復号できない', () => {
    const blob = encryptSecret('app-password', key, 'a@example.com')
    expect(isLegacySecret(blob)).toBe(false)
    expect(decryptSecret(blob, key, 'A@example.com')).toBe('app-password')
    expect(() => decryptSecret(blob, key, 'b@example.com')).toThrow()
  })

  it('印の無い古い形式も読める', () => {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([c.update('old', 'utf8'), c.final()])
    const legacy = Buffer.concat([iv, c.getAuthTag(), body])
    expect(isLegacySecret(legacy)).toBe(true)
    expect(decryptSecret(legacy, key, 'any@example.com')).toBe('old')
  })
})
