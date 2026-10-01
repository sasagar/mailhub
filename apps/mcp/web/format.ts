const nf = new Intl.NumberFormat('ja-JP')
export const n = (value: number) => nf.format(value)

// 今日なら時刻、今年なら月日、それより前なら年月日
export function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export const senderName = (s: { name: string | null; address: string | null } | null) =>
  s?.name?.trim() || s?.address || '（差出人なし）'

// 差出人ごとに決まる色。同じ差出人はいつも同じ色になり、一覧で見分けやすくする
export function avatarHue(key: string): number {
  let h = 0
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) % 360
  return h
}

// アイコンに出す 1 文字。記号やカッコは飛ばす（「＠IT通信」なら「I」、「【Ponta】」なら「P」）
export function initial(name: string): string {
  return (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? '?').toUpperCase()
}
