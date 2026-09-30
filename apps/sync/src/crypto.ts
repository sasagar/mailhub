import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// 形式: iv(12) | authTag(16) | ciphertext
export function encryptSecret(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

export function decryptSecret(blob: Buffer, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12))
  decipher.setAuthTag(blob.subarray(12, 28))
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8')
}
