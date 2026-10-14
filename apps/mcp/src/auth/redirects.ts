// OAuth の戻り先（redirect URI）として受け付ける先。
// クライアント登録（/register）は誰でもできるので、戻り先を絞らないと、本人が「許可」を押しただけで
// 認可コードが第三者のサーバーに届く（同意画面を使ったフィッシング）。個人用なので、使うクライアントだけに限る
const TRUSTED_HOSTS = new Set(['claude.ai', 'claude.com'])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

// 戻り先として登録・使用してよいか。claude.ai などの https、自分の端末（loopback の http）、mailhub 自身
export function isAllowedRedirect(uri: string, origin: string): boolean {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === 'https:' && TRUSTED_HOSTS.has(url.hostname)) return true
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return true
  return uri === `${origin}/app/`
}

// 同意画面で、戻り先が見慣れたものかを示すための短い名前
export function redirectLabel(uri: string, origin: string): string {
  try {
    const url = new URL(uri)
    if (uri === `${origin}/app/`) return 'mailhub の Web 画面'
    if (LOOPBACK.has(url.hostname)) return 'この端末（ローカルのアプリ）'
    return url.hostname
  } catch {
    return uri
  }
}
