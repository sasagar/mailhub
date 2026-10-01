import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, completeLoginIfReturning, isLoggedIn, LoggedOut, login } from './auth.ts'
import { n, senderName, when } from './format.ts'
import type { Message, MessagePage, Overview, Sender } from './types.ts'
import { useArchive } from './useArchive.ts'

type View = 'senders' | 'timeline'

export function App() {
  const [phase, setPhase] = useState<'starting' | 'out' | 'in'>('starting')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    completeLoginIfReturning()
      .then(() => setPhase(isLoggedIn() ? 'in' : 'out'))
      .catch((err: Error) => {
        setError(err.message)
        setPhase('out')
      })
  }, [])

  if (phase === 'starting') return null
  if (phase === 'out') return <SignIn error={error} />
  return <Inbox onLoggedOut={() => setPhase('out')} />
}

function SignIn({ error }: { error: string | null }) {
  return (
    <main className="signin">
      <h1>mailhub</h1>
      <p>受信トレイを差出人ごとにまとめて片付けます。</p>
      {error && <p className="signin-error">{error}</p>}
      <button className="primary" onClick={() => void login()}>
        ログイン
      </button>
    </main>
  )
}

function Inbox({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [view, setView] = useState<View>('senders')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [senders, setSenders] = useState<Sender[] | null>(null)
  const [account, setAccount] = useState<string>('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  const guard = useCallback(
    (err: unknown) => {
      if (err instanceof LoggedOut) onLoggedOut()
      else setLoadError((err as Error).message)
    },
    [onLoggedOut],
  )

  const reload = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    const q = account ? `&account=${encodeURIComponent(account)}` : ''
    Promise.all([api<Overview>('/mcp/api/overview'), api<Sender[]>(`/mcp/api/senders?limit=200${q}`)])
      .then(([o, s]) => {
        setOverview(o)
        setSenders(s)
        setLoadError(null)
      })
      .catch(guard)
  }, [account, version, guard])

  const { archive, toasts } = useArchive(reload)
  const canTriage = overview?.me.scopes.includes('mail.triage') ?? false
  const accounts = overview?.accounts ?? []
  const scoped = account ? accounts.filter((a) => a.account === account) : accounts
  const total = scoped.reduce((s, a) => s + a.total, 0)
  const unread = scoped.reduce((s, a) => s + a.unread, 0)

  return (
    <div className="app">
      <header className="top">
        <div className="top-line">
          <h1>mailhub</h1>
          <p className="totals" aria-live="polite">
            {overview ? (
              <>
                <b>{n(total)}</b> 通<span className="sep">／</span>未読 <b>{n(unread)}</b>
              </>
            ) : (
              '読み込み中'
            )}
          </p>
        </div>
        {senders && <Composition senders={senders} total={total} />}
        <div className="controls">
          <div className="tabs" role="tablist" aria-label="表示">
            <button role="tab" aria-selected={view === 'senders'} onClick={() => setView('senders')}>
              差出人ごと
            </button>
            <button role="tab" aria-selected={view === 'timeline'} onClick={() => setView('timeline')}>
              新しい順
            </button>
          </div>
          {accounts.length > 1 && (
            <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="アカウント">
              <option value="">すべてのアカウント</option>
              {accounts.map((a) => (
                <option key={a.account} value={a.account}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      {loadError && (
        <p className="notice error">
          読み込めませんでした: {loadError} <button onClick={reload}>もう一度読み込む</button>
        </p>
      )}

      {view === 'senders' ? (
        <Senders senders={senders} account={account} canTriage={canTriage} archive={archive} onError={guard} />
      ) : (
        <Timeline account={account} canTriage={canTriage} archive={archive} version={version} onError={guard} />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <p key={t.id} className={`toast ${t.tone}`}>
            {t.text}
          </p>
        ))}
      </div>
    </div>
  )
}

// 受信トレイの内訳。上位の差出人ほど左に大きく並び、片付けるほど縮む
function Composition({ senders, total }: { senders: Sender[]; total: number }) {
  if (total === 0) return <div className="composition empty" />
  const top = senders.slice(0, 30)
  const rest = Math.max(total - top.reduce((s, x) => s + x.total, 0), 0)
  return (
    <div className="composition" role="img" aria-label={`受信トレイ ${n(total)} 通の差出人ごとの内訳`}>
      {top.map((s, i) => (
        <span
          key={s.address}
          className="seg"
          data-shade={i % 4}
          style={{ flexGrow: s.total }}
          title={`${senderName(s)} ${n(s.total)} 通`}
        />
      ))}
      {rest > 0 && <span className="seg rest" style={{ flexGrow: rest }} title={`その他 ${n(rest)} 通`} />}
    </div>
  )
}

type ArchiveFn = (body: Record<string, unknown>, label: string) => Promise<void>

function Senders(props: {
  senders: Sender[] | null
  account: string
  canTriage: boolean
  archive: ArchiveFn
  onError: (err: unknown) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())

  if (!props.senders) return <p className="notice">読み込み中</p>
  if (props.senders.length === 0) return <p className="notice">受信トレイは空です。</p>

  const run = async (s: Sender, markRead: boolean) => {
    setBusy((b) => new Set(b).add(s.address))
    await props.archive({ sender: s.address, account: props.account || undefined, mark_read: markRead }, senderName(s))
    setBusy((b) => {
      const next = new Set(b)
      next.delete(s.address)
      return next
    })
  }

  return (
    <ol className="senders">
      {props.senders.map((s) => (
        <li key={s.address} className={busy.has(s.address) ? 'busy' : ''}>
          <div className="sender-row">
            <button
              className="sender-main"
              aria-expanded={open === s.address}
              onClick={() => setOpen(open === s.address ? null : s.address)}
            >
              <span className="sender-name">{senderName(s)}</span>
              <span className="sender-address">{s.address}</span>
            </button>
            <span className="count">
              <b>{n(s.total)}</b>
              {s.unread > 0 && <span className="unread">未読 {n(s.unread)}</span>}
            </span>
            {props.canTriage && (
              <ConfirmButton
                label="既読にしてアーカイブ"
                confirmLabel={`${n(s.total)} 通を片付ける`}
                busyLabel="処理中"
                busy={busy.has(s.address)}
                onConfirm={() => void run(s, true)}
              />
            )}
          </div>
          {open === s.address && (
            <SenderDetail
              sender={s}
              account={props.account}
              canTriage={props.canTriage}
              busy={busy.has(s.address)}
              onArchiveKeepUnread={() => void run(s, false)}
              onError={props.onError}
            />
          )}
        </li>
      ))}
    </ol>
  )
}

function SenderDetail(props: {
  sender: Sender
  account: string
  canTriage: boolean
  busy: boolean
  onArchiveKeepUnread: () => void
  onError: (err: unknown) => void
}) {
  const [page, setPage] = useState<MessagePage | null>(null)
  useEffect(() => {
    const q = new URLSearchParams({ from: props.sender.address, limit: '8' })
    if (props.account) q.set('account', props.account)
    api<MessagePage>(`/mcp/api/messages?${q}`).then(setPage).catch(props.onError)
  }, [props.sender.address, props.account, props.onError])

  return (
    <div className="detail">
      {!page ? (
        <p className="muted">読み込み中</p>
      ) : (
        <ul className="subjects">
          {page.messages.map((m) => (
            <li key={m.id} className={m.unread ? 'is-unread' : ''}>
              <span className="subject">{m.subject || '（件名なし）'}</span>
              <time dateTime={m.receivedAt ?? undefined}>{when(m.receivedAt)}</time>
            </li>
          ))}
          {page.total > page.messages.length && (
            <li className="more">ほか {n(page.total - page.messages.length)} 通</li>
          )}
        </ul>
      )}
      {props.canTriage && (
        <button className="quiet" disabled={props.busy} onClick={props.onArchiveKeepUnread}>
          未読のままアーカイブ
        </button>
      )}
    </div>
  )
}

// 1 回目で確認に変わり、3 秒以内にもう一度押すと実行する。大量の誤操作を防ぐ
function ConfirmButton(props: {
  label: string
  confirmLabel: string
  busyLabel: string
  busy: boolean
  onConfirm: () => void
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  if (props.busy) {
    return (
      <button className="primary" disabled>
        {props.busyLabel}
      </button>
    )
  }
  return (
    <button
      className={armed ? 'primary armed' : 'primary'}
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

function Timeline(props: {
  account: string
  canTriage: boolean
  archive: ArchiveFn
  version: number
  onError: (err: unknown) => void
}) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [total, setTotal] = useState(0)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const query = useCallback(
    (offset: number) => {
      const q = new URLSearchParams({ limit: '50', offset: String(offset) })
      if (props.account) q.set('account', props.account)
      if (unreadOnly) q.set('unread', '1')
      return api<MessagePage>(`/mcp/api/messages?${q}`)
    },
    [props.account, unreadOnly],
  )

  useEffect(() => {
    setSelected(new Set())
    query(0)
      .then((p) => {
        setMessages(p.messages)
        setTotal(p.total)
      })
      .catch(props.onError)
  }, [query, props.version, props.onError])

  const more = () =>
    query(messages?.length ?? 0)
      .then((p) => setMessages((m) => [...(m ?? []), ...p.messages]))
      .catch(props.onError)

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const run = async (markRead: boolean) => {
    setBusy(true)
    await props.archive({ message_ids: [...selected], mark_read: markRead }, `選んだ ${selected.size} 通`)
    setBusy(false)
  }

  const allSelected = useMemo(
    () => messages != null && messages.length > 0 && messages.every((m) => selected.has(m.id)),
    [messages, selected],
  )

  if (!messages) return <p className="notice">読み込み中</p>

  return (
    <>
      <div className="timeline-tools">
        <label>
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> 未読だけ
        </label>
        {props.canTriage && messages.length > 0 && (
          <button
            className="quiet"
            onClick={() => setSelected(allSelected ? new Set() : new Set(messages.map((m) => m.id)))}
          >
            {allSelected ? '選択を外す' : `表示中の ${messages.length} 通を選ぶ`}
          </button>
        )}
      </div>
      {messages.length === 0 ? (
        <p className="notice">{unreadOnly ? '未読のメールはありません。' : '受信トレイは空です。'}</p>
      ) : (
        <ol className="timeline">
          {messages.map((m) => (
            <li key={m.id} className={m.unread ? 'is-unread' : ''}>
              <label>
                {props.canTriage && (
                  <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                )}
                <span className="line">
                  <span className="who">{senderName(m.from)}</span>
                  <time dateTime={m.receivedAt ?? undefined}>{when(m.receivedAt)}</time>
                </span>
                <span className="subject">{m.subject || '（件名なし）'}</span>
              </label>
            </li>
          ))}
        </ol>
      )}
      {messages.length < total && (
        <button className="quiet load-more" onClick={() => void more()}>
          続きを読み込む（残り {n(total - messages.length)} 通）
        </button>
      )}
      {selected.size > 0 && (
        <div className="selection-bar">
          <span>
            <b>{n(selected.size)}</b> 通を選択中
          </span>
          <button className="quiet" disabled={busy} onClick={() => void run(false)}>
            アーカイブ
          </button>
          <button className="primary" disabled={busy} onClick={() => void run(true)}>
            {busy ? '処理中' : '既読にしてアーカイブ'}
          </button>
        </div>
      )}
    </>
  )
}
