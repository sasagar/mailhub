// 画面のあちこちで使う小さな部品（アイコン・差出人の丸・アカウントの印・2 回押しのボタン）
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties } from 'react'
import { avatarHue, initial } from './format.ts'
import type { Account } from './types.ts'

const PATHS = {
  inbox:
    'M3 11.5 5.2 4.8A1.5 1.5 0 0 1 6.6 3.8h6.8a1.5 1.5 0 0 1 1.4 1L17 11.5V15a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15v-3.5Zm0 0h4l1 2h4l1-2h4',
  people:
    'M7.5 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 7c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5M13.5 9.2a2.6 2.6 0 1 0-.6-5.1M15 12.3c1.6.5 2.6 1.9 2.6 4.2',
  search: 'M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm4.3-1.7L17 17',
  draft: 'M4 16h3l8.5-8.5a2.1 2.1 0 0 0-3-3L4 13v3ZM11.5 5.5l3 3',
  junk: 'M10 3.5 3 6v4.2c0 3.6 3 6 7 7.3 4-1.3 7-3.7 7-7.3V6l-7-2.5ZM7.5 8l5 5m0-5-5 5',
  refresh: 'M16 10a6 6 0 1 1-1.76-4.24M16 3.5v3.5h-3.5',
  archive: 'M3 4.5h14v3H3zM4.5 7.5V15A1.5 1.5 0 0 0 6 16.5h8a1.5 1.5 0 0 0 1.5-1.5V7.5M8 10.5h4',
  reply: 'M8 5 3.5 9.5 8 14M3.5 9.5H12a4.5 4.5 0 0 1 4.5 4.5v1',
  replyAll: 'M10 5 5.5 9.5 10 14M6.5 5 2 9.5 6.5 14M5.5 9.5H13a4.5 4.5 0 0 1 4.5 4.5v1',
  up: 'M5 12.5 10 7.5l5 5',
  down: 'M5 7.5 10 12.5l5-5',
  back: 'M12.5 4.5 7 10l5.5 5.5',
  close: 'M5 5l10 10M15 5 5 15',
  check: 'M4.5 10.5 8 14l7.5-8',
  undo: 'M7 5 3.5 8.5 7 12M3.5 8.5H12a4.5 4.5 0 0 1 0 9H9',
} as const
export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true" className="icon">
      <path
        d={PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// 差出人の頭文字の丸いアイコン。checked のときはチェックに変わる（選んだとき）
export function Avatar({ name, seed, checked }: { name: string; seed: string; checked?: boolean }) {
  return (
    <span
      className={checked ? 'avatar checked' : 'avatar'}
      style={{ '--hue': avatarHue(seed) } as CSSProperties}
      aria-hidden="true"
    >
      {checked ? <Icon name="check" size={16} /> : initial(name)}
    </span>
  )
}

// ---- アカウントの印 ----
// 11 のアカウントを 1 つの一覧に混ぜて出すので、行ごとにどのアカウントのメールかを色と名前で見せる。
// 色はアカウントの並び順で決める（黄金角で回して、隣どうしが似た色にならないようにする）

export type AccountInfo = { label: string; hue: number }
const AccountsContext = createContext<Map<string, AccountInfo>>(new Map())
export const AccountsProvider = AccountsContext.Provider

export function accountInfos(accounts: Account[]): Map<string, AccountInfo> {
  return new Map(
    accounts.map((a, i) => [a.account, { label: shortLabel(a, accounts), hue: Math.round((i * 137.5 + 220) % 360) }]),
  )
}

// 一覧に出す短い名前。「Gmail（吉田健徒）」なら「吉田健徒」、同じ表示名が並ぶときはアドレスを使う
function shortLabel(a: Account, all: Account[]): string {
  const inner = /（(.+)）$/.exec(a.label)?.[1]
  if (inner) return inner
  const dup = all.some((b) => b !== a && b.label === a.label)
  return dup ? a.account : a.label
}

export function AccountDot({ account }: { account: string }) {
  const info = useContext(AccountsContext).get(account)
  return <span className="account-dot" style={{ '--hue': info?.hue ?? 0 } as CSSProperties} aria-hidden="true" />
}

export function AccountTag({ account }: { account: string }) {
  const all = useContext(AccountsContext)
  const info = all.get(account)
  // アカウントが 1 つなら見分ける必要がない
  if (!info || all.size < 2) return null
  return (
    <span className="account-tag" style={{ '--hue': info.hue } as CSSProperties}>
      {info.label}
    </span>
  )
}

// 1 回目で確認に変わり、3 秒以内にもう一度押すと実行する。大量の誤操作を防ぐ
export function ConfirmButton(props: {
  label: string
  confirmLabel: string
  busyLabel: string
  busy: boolean
  onConfirm: () => void
  className?: string
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  if (props.busy) {
    return (
      <button className={`primary is-busy ${props.className ?? ''}`} disabled>
        <span className="spinner" aria-hidden="true" />
        {props.busyLabel}
      </button>
    )
  }
  return (
    <button
      className={`${armed ? 'primary armed' : 'primary'} ${props.className ?? ''}`}
      onClick={() => {
        if (armed) {
          setArmed(false)
          props.onConfirm()
          return
        }
        setArmed(true)
        timer.current = setTimeout(() => setArmed(false), 3000)
      }}
    >
      {armed ? props.confirmLabel : props.label}
    </button>
  )
}

// 画面の幅で配置を変える（PC は 3 列、タブレットは 2 列、スマホは 1 列）
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const m = matchMedia(query)
    const on = () => setMatch(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return match
}

// モード（個人・仕事など）の切り替え。並びはアカウントの登録順で、最後に「すべて」。
// 未読の数はメニューの受信トレイに出るので、ここには出さない（並べると窮屈で読みにくい）
export function ModeSwitch(props: { modes: string[]; value: string; onChange: (mode: string) => void }) {
  return (
    <div className="mode-switch" role="group" aria-label="モード">
      {[...props.modes, ''].map((m) => (
        <button key={m} aria-pressed={props.value === m} onClick={() => props.onChange(m)}>
          {m || 'すべて'}
        </button>
      ))}
    </div>
  )
}
