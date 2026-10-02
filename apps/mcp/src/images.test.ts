import { describe, expect, it } from 'vite-plus/test'
import { blockImages, externalUrl, IMAGE_PREFIX, proxyImages, rewriteImages, serveImage } from './images.ts'

const p = (url: string) => `P[${url}]`

describe('rewriteImages', () => {
  it('img の src を置き換える（引用符なし・単引用符・実体参照も）', () => {
    expect(rewriteImages('<img src="https://a.example/x.png?a=1&amp;b=2">', p)).toBe(
      '<img src="P[https://a.example/x.png?a=1&b=2]">',
    )
    expect(rewriteImages("<IMG alt='x' SRC='http://a.example/y.gif'>", p)).toBe(
      `<IMG alt='x' SRC="P[http://a.example/y.gif]">`,
    )
    expect(rewriteImages('<img src=//cdn.example/z.jpg>', p)).toBe('<img src="P[https://cdn.example/z.jpg]">')
  })

  it('data: と cid: と相対 URL はそのまま', () => {
    const html = '<img src="data:image/png;base64,AAA"><img src="cid:logo@x"><img src="/a.png">'
    expect(rewriteImages(html, p)).toBe(html)
  })

  it('srcset、background 属性、style 属性と <style> の url() も置き換える', () => {
    expect(rewriteImages('<img srcset="https://a.example/1x.png 1x, https://a.example/2x.png 2x">', p)).toBe(
      '<img srcset="P[https://a.example/1x.png] 1x, P[https://a.example/2x.png] 2x">',
    )
    expect(rewriteImages('<td background="https://a.example/bg.png">', p)).toBe(
      '<td background="P[https://a.example/bg.png]">',
    )
    expect(rewriteImages('<div style="background:url(&quot;https://a.example/s.png&quot;)">', p)).toBe(
      '<div style="background:url(&quot;P[https://a.example/s.png]&quot;)">',
    )
    expect(rewriteImages("<style>.a{background:url('https://a.example/c.png')}</style>", p)).toBe(
      "<style>.a{background:url('P[https://a.example/c.png]')}</style>",
    )
  })

  it('本文のテキストは触らない', () => {
    const html = '<p>src="https://a.example/x.png" と url(https://a.example/y.png)</p>'
    expect(rewriteImages(html, p)).toBe(html)
  })

  it('1px 以下の画像（開封確認）は消す', () => {
    expect(rewriteImages('<p>a<img src="https://t.example/o.gif" width="1" height="1">b</p>', p)).toBe('<p>ab</p>')
    expect(rewriteImages('<img src="https://t.example/o.gif" style="width:0px;height:0px">', p)).toBe('')
    // 片方だけ小さいもの（区切り線など）は残す
    expect(rewriteImages('<img src="https://a.example/line.png" width="600" height="1">', p)).toBe(
      '<img src="P[https://a.example/line.png]" width="600" height="1">',
    )
  })
})

describe('externalUrl', () => {
  it('http(s) とプロトコル相対だけを返す', () => {
    expect(externalUrl('https://a.example/x')).toBe('https://a.example/x')
    expect(externalUrl('//a.example/x')).toBe('https://a.example/x')
    expect(externalUrl('javascript:alert(1)')).toBeNull()
    expect(externalUrl('cid:x')).toBeNull()
    // 範囲外の文字参照で例外を投げない
    expect(externalUrl('https://a.example/x&#99999999;')).toBe('https://a.example/x&#99999999;')
  })
})

describe('proxyImages と serveImage', () => {
  const secret = 'test-secret'
  it('書き換えた URL は記号を含まず、署名を確かめて通す。改ざんしたものは 403', async () => {
    const html = await proxyImages('<img src="https://a.example/x.png?a=1&amp;b=2">', 'https://m.example', secret)
    const src = /src="([^"]+)"/.exec(html)![1]!
    expect(src.startsWith(`https://m.example${IMAGE_PREFIX}`)).toBe(true)
    expect(src.slice('https://m.example'.length)).toMatch(/^\/img\/[\w-]+\/[\w-]+$/)

    const [, , , sig, enc] = src.split('/')
    const forged = `https://m.example${IMAGE_PREFIX}${sig}/${btoa('https://evil.example/').replace(/=+$/, '')}`
    expect((await serveImage(new Request(forged), secret)).status).toBe(403)
    expect((await serveImage(new Request(src), 'other-secret')).status).toBe(403)
    expect(enc).toBeTruthy()
  })
})

describe('blockImages', () => {
  it('外部画像を data: に差し替え、外へは取りに行かせない', () => {
    const out = blockImages('<img src="https://a.example/x.png"><div style="background:url(https://a.example/y.png)">')
    expect(out).not.toContain('a.example')
    expect(out).toContain('src="data:image/gif;base64,')
  })
})
