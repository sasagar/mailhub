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
