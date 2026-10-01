import { describe, expect, it } from 'vite-plus/test'
import { parseAddresses } from './queries.ts'

describe('parseAddresses', () => {
  it('名前付きと素のアドレスを、カンマ・読点・改行で区切って読む', () => {
    expect(parseAddresses('山田 太郎 <taro@example.com>、hanako@example.jp\nichiro@example.org')).toEqual([
      { name: '山田 太郎', address: 'taro@example.com' },
      { name: null, address: 'hanako@example.jp' },
      { name: null, address: 'ichiro@example.org' },
    ])
  })

  it('引用符の中のカンマでは区切らない', () => {
    expect(parseAddresses('"Sato, Ichiro" <ichiro@example.org>, a@example.com')).toEqual([
      { name: 'Sato, Ichiro', address: 'ichiro@example.org' },
      { name: null, address: 'a@example.com' },
    ])
  })

  it('配列でも受け取る', () => {
    expect(parseAddresses(['x@example.com', 'Y <y@example.com>'])).toEqual([
      { name: null, address: 'x@example.com' },
      { name: 'Y', address: 'y@example.com' },
    ])
  })

  it('空なら空の配列', () => {
    expect(parseAddresses('')).toEqual([])
    expect(parseAddresses(undefined)).toEqual([])
  })

  it('形式がおかしいものは、その文字列を添えて弾く', () => {
    expect(() => parseAddresses('not-an-address')).toThrow(/not-an-address/)
  })
})
