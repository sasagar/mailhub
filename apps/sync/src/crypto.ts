import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// 形式（v2）: "MH2"(3) | iv(12) | authTag(16) | ciphertext
//   関連データ（AAD）にアカウントのメールアドレスを入れ、別のアカウントの行に暗号文を移しても復号できないようにする。
//   先頭の印で版を見分け、鍵や方式を変えるときに古い形式と並べて読めるようにする
// 形式（v1、印なし）: iv(12) | authTag(16) | ciphertext。読めるが、読んだら v2 に書き直す（accounts.ts）
const V2 = Buffer.from('MH2')

const aadOf = (context: string) => Buffer.from(`mailhub:account:${context.toLowerCase()}`, 'utf8')

export function encryptSecret(plain: string, key: Buffer, context: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aadOf(context))
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([V2, iv, cipher.getAuthTag(), body])
}

export const isLegacySecret = (blob: Buffer) => !blob.subarray(0, V2.length).equals(V2)

export function decryptSecret(blob: Buffer, key: Buffer, context: string): string {
  const legacy = isLegacySecret(blob)
  const data = legacy ? blob : blob.subarray(V2.length)
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
  if (!legacy) decipher.setAAD(aadOf(context))
  decipher.setAuthTag(data.subarray(12, 28))
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
}
