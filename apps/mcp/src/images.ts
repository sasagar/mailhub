// HTML メールの外部画像を mailhub 経由で取得する（画像プロキシ）。
// 画像を直接読み込むと、相手のサーバーに閲覧者の IP と端末の情報が渡る。本文を返すときに画像の URL を
// /img/<署名>/<URL> に書き換え、Worker が代わりに取りに行く。署名の無い URL は扱わない（誰でも使える中継にしない）

export const IMAGE_PREFIX = '/img/'
const MAX_BYTES = 10 * 1024 * 1024

// ---- HTML の書き換え（純粋関数） ----

// 範囲外の文字参照（&#99999999; など）は fromCodePoint が例外を投げるので、そのまま残す
const codePoint = (whole: string, n: number) => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole)
const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (whole, h: string) => codePoint(whole, parseInt(h, 16)))
    .replace(/&#(\d+);/g, (whole, d: string) => codePoint(whole, Number(d)))

// 書き換えの対象になる外部の URL か。プロトコル相対（//host/…）は https として扱う
export function externalUrl(raw: string): string | null {
  const v = decodeEntities(raw.trim())
  const abs = v.startsWith('//') ? `https:${v}` : v
  if (!/^https?:\/\//i.test(abs)) return null
  try {
    return new URL(abs).href
  } catch {
    return null
  }
}

const ATTR = /(\s)(src|background|poster)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/gi
const SRCSET = /(\s)(srcset)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/gi
const STYLE_ATTR = /(\s)(style)(\s*=\s*)("[^"]*"|'[^']*')/gi
const CSS_URL = /url\(\s*(&quot;|&#0*39;|["'])?(.*?)\1\s*\)/gi
const unquote = (v: string) => (v.startsWith('"') || v.startsWith("'") ? v.slice(1, -1) : v)

// 開封の確認に使われる 1px 以下の画像か（width と height の属性、または style の指定で判断する）
function isTrackingPixel(tag: string): boolean {
  const size = (name: string) => {
    const attr = new RegExp(`\\s${name}\\s*=\\s*["']?\\s*(\\d+)`, 'i').exec(tag)
    const style = new RegExp(`[;"'\\s]${name}\\s*:\\s*(\\d+)px`, 'i').exec(tag)
    const v = attr?.[1] ?? style?.[1]
    return v === undefined ? null : Number(v)
  }
  const w = size('width')
  const h = size('height')
  return w !== null && h !== null && w <= 1 && h <= 1
}

// CSS の url(...) の中の外部 URL を置き換える
const rewriteCss = (css: string, proxy: (url: string) => string) =>
  css.replace(CSS_URL, (whole, quote: string | undefined, raw: string) => {
    const url = externalUrl(raw)
    return url ? `url(${quote ?? ''}${proxy(url)}${quote ?? ''})` : whole
  })

// 本文の HTML の画像の URL を proxy(url) の結果に置き換える。対象は src / background / poster、srcset、
// style 属性と <style> の中の url(...)。1px 以下の画像は取りに行かずに消す。
// 取りこぼしがあっても、表示する枠の CSP が外部の画像を止める（IP は漏れない）
export function rewriteImages(html: string, proxy: (url: string) => string): string {
  const out = html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>|<[a-zA-Z][^>]*>/g, (tag) => {
    if (/^<style\b/i.test(tag)) {
      const open = tag.indexOf('>') + 1
      return tag.slice(0, open) + rewriteCss(tag.slice(open), proxy)
    }
    if (/^<img\b/i.test(tag) && isTrackingPixel(tag)) return ''
    return tag
      .replace(ATTR, (whole, sp: string, name: string, eq: string, value: string) => {
        const url = externalUrl(unquote(value))
        return url ? `${sp}${name}${eq}"${proxy(url)}"` : whole
      })
      .replace(SRCSET, (_, sp: string, name: string, eq: string, value: string) => {
        const list = unquote(value)
          .split(/,(?=\s*\S)/)
          .map((item) => {
            const [raw = '', ...desc] = item.trim().split(/\s+/)
            const url = externalUrl(raw)
            return [url ? proxy(url) : raw, ...desc].join(' ')
          })
        return `${sp}${name}${eq}"${list.join(', ')}"`
      })
      .replace(STYLE_ATTR, (_, sp: string, name: string, eq: string, value: string) => {
        const q = value[0]
        return `${sp}${name}${eq}${q}${rewriteCss(value.slice(1, -1), proxy)}${q}`
      })
  })
  return out
}

// ---- 署名 ----

const encoder = new TextEncoder()
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

let cachedKey: { secret: string; key: Promise<CryptoKey> } | undefined
function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) {
    const key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ])
    cachedKey = { secret, key }
  }
  return cachedKey.key
}

async function signUrl(secret: string, url: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(url))
  return b64url(new Uint8Array(sig))
}

// 本文の画像をプロキシ経由にする。URL は記号を含まない形にして、属性・CSS のどちらに置いても壊れないようにする
export async function proxyImages(html: string, origin: string, secret: string): Promise<string> {
  const urls = new Set<string>()
  rewriteImages(html, (url) => (urls.add(url), url))
  const signed = new Map<string, string>()
  await Promise.all(
    [...urls].map(async (url) => {
      signed.set(url, `${origin}${IMAGE_PREFIX}${await signUrl(secret, url)}/${b64url(encoder.encode(url))}`)
    }),
  )
  return rewriteImages(html, (url) => signed.get(url)!)
}

// ---- 取得 ----

// /img/<署名>/<URL> を受けて画像を返す。相手には Cloudflare の IP だけが見え、Cookie・Referer・端末の情報は渡さない
export async function serveImage(request: Request, secret: string): Promise<Response> {
  const fail = (status: number) =>
    new Response(null, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
  if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405)
  const [sig, encoded] = new URL(request.url).pathname.slice(IMAGE_PREFIX.length).split('/')
  if (!sig || !encoded) return fail(404)
  let url: string
  try {
    url = new TextDecoder().decode(fromB64url(encoded))
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), encoder.encode(url))
    if (!ok || !/^https?:\/\//i.test(url)) return fail(403)
  } catch {
    return fail(400)
  }

  let upstream: Response
  try {
    upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mailhub-image-proxy)', Accept: 'image/*' },
      redirect: 'follow',
      // 同じ画像を開き直しても、元のサーバーには何度も取りに行かない
      cf: { cacheEverything: true, cacheTtl: 86400 },
    })
  } catch {
    return fail(502)
  }
  const type = upstream.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!upstream.ok || !type.startsWith('image/')) return fail(upstream.ok ? 415 : 502)
  if (Number(upstream.headers.get('Content-Length') ?? 0) > MAX_BYTES) return fail(413)
  const body = await upstream.arrayBuffer()
  if (body.byteLength > MAX_BYTES) return fail(413)
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'Content-Type': type,
      // 署名付きの URL は中身が変わらないので長めに持たせる
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      // SVG を直接開かれても中のスクリプトを動かさない
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Referrer-Policy': 'no-referrer',
    },
  })
}
