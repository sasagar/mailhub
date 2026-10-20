// Gmail 以外のアカウント向けに、Gmail の検索式のよく使う部分を IMAP の検索条件に直す。
// 直せない書き方（OR・かっこ・除外・has: など）はエラーにする（黙って別の意味で探さないように）
import type { SearchObject } from 'imapflow'

const FIELDS = { from: 'from', to: 'to', cc: 'cc', subject: 'subject' } as const

export function imapCriteria(query: string): SearchObject {
  const parts: SearchObject[] = []
  const dates: SearchObject = {}
  for (const m of query.matchAll(/([a-z]+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/gi)) {
    const [, op, opValue, phrase, word] = m
    if (op) {
      const key = op.toLowerCase()
      const value = unquote(opValue!)
      if (key in FIELDS) parts.push({ [FIELDS[key as keyof typeof FIELDS]]: value })
      else if (key === 'after' || key === 'before') dates[key === 'after' ? 'since' : 'before'] = parseDate(value)
      else throw new Error(`Gmail 以外のアカウントでは ${key}: は使えません`)
      continue
    }
    const text = phrase ?? word!
    if (text === 'OR' || /^[-()]|\)$/.test(text)) {
      throw new Error('Gmail 以外のアカウントでは OR・かっこ・除外（-）は使えません')
    }
    if (text) parts.push({ or: [{ subject: text }, { from: text }, { body: text }] })
  }
  if (parts.length === 0 && Object.keys(dates).length === 0) throw new Error('検索語がありません')
  return { ...dates, ...and(parts) }
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s
}

// 2026/01/31・2026-01-31・2026/1/31 を受け付ける
function parseDate(s: string): Date {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(s)
  if (!m) throw new Error(`日付は 2025/01/31 の形で書いてください: ${s}`)
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
}

// SearchObject は同じキーを 2 つ持てないので、条件が重なるときは「not (not A or not B)」で両方を満たすものにする
function and(parts: SearchObject[]): SearchObject {
  if (parts.length === 0) return {}
  if (parts.length === 1) return parts[0]!
  return { not: { or: parts.map((p) => ({ not: p })) } }
}
