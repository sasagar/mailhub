// HTML メールの無害化。表示は sandbox の枠（スクリプトなし）と CSP で守っているが、それでは止まらないものを取り除く。
// - <link rel=preconnect / dns-prefetch>: ブラウザによっては CSP が効かず、開いたことが送り主に伝わる
// - <meta>（refresh・referrer）、<base>、<script>、<object>/<embed>/<iframe>、<form>
// - on* 属性、referrerpolicy、ping
// - リンクは rel="noopener noreferrer" にする（開いた先のページから mailhub のタブを偽ページに差し替えさせない）

const DROP_WITH_CONTENT = /<(script|iframe|object|embed|frameset|frame|applet|noscript|template)\b[\s\S]*?<\/\1\s*>/gi
const DROP_TAG =
  /<\/?(?:link|meta|base|script|iframe|object|embed|frameset|frame|applet|param|noscript|template)\b[^>]*>/gi
const FORM_TAG = /<(\/?)form\b[^>]*>/gi
const DANGEROUS_ATTR = /\s(?:on[a-z]+|referrerpolicy|ping|formaction|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi
const REL_ATTR = /\srel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi

export function sanitizeEmailHtml(html: string): string {
  return html
    .replace(DROP_WITH_CONTENT, '')
    .replace(DROP_TAG, '')
    .replace(FORM_TAG, (_, close: string) => `<${close}div>`)
    .replace(/<[a-zA-Z][^>]*>/g, (tag) => {
      const cleaned = tag.replace(DANGEROUS_ATTR, '')
      if (!/^<(a|area)\b/i.test(cleaned)) return cleaned
      return cleaned.replace(REL_ATTR, '').replace(/^<(a|area)\b/i, '<$1 rel="noopener noreferrer"')
    })
}
