import { describe, expect, it } from 'vite-plus/test'
import { sanitizeEmailHtml } from './sanitize.ts'

describe('sanitizeEmailHtml', () => {
  it('開封が伝わる・ページを動かす要素を取り除く', () => {
    const out = sanitizeEmailHtml(
      '<link rel="preconnect" href="https://x.evil"><meta http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/"><p>本文</p><script>alert(1)</script><iframe src="https://evil"></iframe>',
    )
    expect(out).toBe('<p>本文</p>')
  })

  it('フォームは中身を残して div にし、イベント属性・referrerpolicy・ping を消す', () => {
    expect(sanitizeEmailHtml('<form action="https://evil"><b onclick="x()">a</b></form>')).toBe('<div><b>a</b></div>')
    expect(sanitizeEmailHtml('<img src="x" onerror="y" referrerpolicy="unsafe-url">')).toBe('<img src="x">')
  })

  it('リンクは rel="noopener noreferrer" にそろえる（rel=opener を上書きする）', () => {
    expect(sanitizeEmailHtml('<a href="https://a.example" rel="opener" ping="https://t">x</a>')).toBe(
      '<a rel="noopener noreferrer" href="https://a.example">x</a>',
    )
  })

  it('普通のメールの見た目は変えない', () => {
    const html = '<table style="width:600px"><tr><td><img src="https://a.example/x.png" width="10"></td></tr></table>'
    expect(sanitizeEmailHtml(html)).toBe(html)
  })
})
