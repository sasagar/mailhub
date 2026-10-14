import type { ClientInfo } from '@cloudflare/workers-oauth-provider'
import { SCOPES, type Scope } from '../scopes.ts'
import { isAllowedRedirect, redirectLabel } from './redirects.ts'

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// formActionOrigins: 同意フォームの送信後にリダイレクトする先。Chrome は form-action をリダイレクト先にも
// 適用するので、Access のログイン画面を入れないと送信後に画面が止まる（送信自体はサーバーで処理済みになる）
export function securityHeaders(formActionOrigins: string[], extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra)
  headers.set(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formActionOrigins.join(' ')}; frame-ancestors 'none'; base-uri 'none'`,
  )
  headers.set('X-Frame-Options', 'DENY')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Content-Type', 'text/html; charset=utf-8')
  return headers
}

// MCP クライアントにどの権限を渡すかを選ぶ画面。送信先（redirect URI）も見せて、見覚えのないクライアントに気付けるようにする
export function renderConsent(opts: {
  client: ClientInfo | null
  csrfToken: string
  requested: Scope[]
  // 送信の権限を与えてよいクライアントか（mailhub の Web 画面だけ）
  canSend: boolean
  // 今回、認可コードを返す先。登録済みの一覧ではなく、実際に使う 1 件を見せる
  redirectUri: string
  origin: string
}): string {
  const name = escapeHtml(opts.client?.clientName || opts.client?.clientId || '不明なクライアント')
  const trusted = isAllowedRedirect(opts.redirectUri, opts.origin)
  const destination = `<p class="dest${trusted ? '' : ' warn'}">許可すると <b>${escapeHtml(
    redirectLabel(opts.redirectUri, opts.origin),
  )}</b> にアクセス権が渡ります<br><code>${escapeHtml(opts.redirectUri)}</code></p>${
    trusted ? '' : '<p class="warn">見覚えのない戻り先です。心当たりが無ければ許可しないでください。</p>'
  }`
  const items = (Object.entries(SCOPES) as [Scope, (typeof SCOPES)[Scope]][])
    .map(([scope, s]) => {
      const allowed = s.available && (scope !== 'mail.send' || opts.canSend)
      // 書き込みの権限は、クライアントが求めたときだけ最初から選んでおく（何も求めていなければ読み取りだけ）
      const checked = s.required || (allowed && opts.requested.includes(scope))
      const disabled = s.required || !allowed
      return `<label class="${disabled ? 'off' : ''}">
        <input type="checkbox" name="scope" value="${scope}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <b>${escapeHtml(s.label)}</b> <span>${escapeHtml(s.description)}</span>
      </label>`
    })
    .join('')
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mailhub へのアクセス許可</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 34rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.6; }
  label { display: block; padding: .6rem .8rem; border: 1px solid #8884; border-radius: .5rem; margin: .5rem 0; }
  label.off { opacity: .6; } label span { opacity: .75; font-size: .9em; }
  button { font-size: 1rem; padding: .6rem 1.4rem; border-radius: .5rem; border: 0; background: #2563eb; color: #fff; }
  code { font-size: .85em; word-break: break-all; }
  .dest { font-size: 1.1em; padding: .6rem .8rem; border-radius: .5rem; background: #2563eb18; }
  .dest b { font-size: 1.15em; } .warn { color: #dc2626; font-weight: 600; } .dest.warn { background: #dc262618; }
</style></head><body>
<h1>mailhub へのアクセス許可</h1>
<p><b>${name}</b> が、あなたのメールへのアクセスを求めています。</p>
${destination}
<form method="post" action="/authorize">
  <input type="hidden" name="csrf_token" value="${opts.csrfToken}">
  ${items}
  <p>次へ進むと Cloudflare Access でログインします。</p>
  <button type="submit">許可してログイン</button>
</form>
</body></html>`
}
