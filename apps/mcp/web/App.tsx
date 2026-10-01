import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { api, completeLoginIfReturning, isLoggedIn, LoggedOut, login } from './auth.ts'
import { avatarHue, initial, n, senderName, when } from './format.ts'
import type {
  Account,
  ComposeTarget,
  Draft,
  Message,
  MessagePage,
  MessageRef,
  Overview,
  SearchResult,
  Sender,
} from './types.ts'
import { PHASE_LABEL, useArchive, type Job } from './useArchive.ts'
import { Compose } from './Compose.tsx'
import { MessageView } from './MessageView.tsx'
import { useFreshness } from './useFreshness.ts'
import { usePullToRefresh } from './usePullToRefresh.ts'

type View = 'senders' | 'timeline' | 'search' | 'drafts'

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
      <p>
        複数のメールアカウントを 1
        か所で整理する、作者個人用のツールです。受信トレイを差出人ごとにまとめて片付け、メールを検索・閲覧できます。
      </p>
      <p className="signin-links">
        <a href="/about">mailhub について（About）</a>
        <a href="/privacy">プライバシーポリシー（Privacy）</a>
      </p>
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

  const { archive, jobs, now, dismiss } = useArchive(reload)
  const { refresh, updateReady, applyUpdate } = useFreshness(reload)
  const [refreshing, setRefreshing] = useState(false)
  const pullState = usePullToRefresh(refresh)
  // 開いているメール。iPhone の左端からのスワイプや「戻る」で閉じられるよう、履歴に積む
  const [opened, setOpened] = useState<MessageRef | null>(null)
  const openMessage = useCallback((ref: MessageRef) => {
    history.pushState({ message: true }, '')
    setOpened(ref)
  }, [])
  // 開いている作成画面。メールと同じく履歴に積む
  const [composing, setComposing] = useState<ComposeTarget | null>(null)
  const [sentNotice, setSentNotice] = useState<string | null>(null)
  const openCompose = useCallback((target: ComposeTarget) => {
    history.pushState({ compose: true }, '')
    setComposing(target)
  }, [])
  // エージェントが作った下書きのリンク（/app/#draft=ID）から開く
  useEffect(() => {
    const m = /^#draft=(\d+)$/.exec(location.hash)
    if (m) {
      history.replaceState(null, '', '/app/')
      openCompose({ draftId: m[1]! })
    }
  }, [openCompose])
  useEffect(() => {
    const onPop = () => {
      setOpened(null)
      setComposing(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const canTriage = overview?.me.scopes.includes('mail.triage') ?? false
  const accounts = overview?.accounts ?? []
  const scoped = account ? accounts.filter((a) => a.account === account) : accounts
  const total = scoped.reduce((s, a) => s + a.total, 0)
  const unread = scoped.reduce((s, a) => s + a.unread, 0)

  return (
    <div className="app">
      <PullIndicator {...pullState} />
      <header className="top">
        {updateReady && (
          <p className="update-banner">
            新しい版があります
            <button className="primary" onClick={applyUpdate}>
              更新
            </button>
          </p>
        )}
        <div className="top-line">
          <div className="brand">
            <h1>mailhub</h1>
            <button
              className={refreshing ? 'refresh spinning' : 'refresh'}
              aria-label="最新の状態に更新"
              onClick={() => {
                setRefreshing(true)
                refresh()
                setTimeout(() => setRefreshing(false), 900)
              }}
            >
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path
                  d="M16 10a6 6 0 1 1-1.76-4.24M16 3.5v3.5h-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {canTriage && (
              <button className="refresh" aria-label="新しいメールを書く" onClick={() => openCompose({ blank: true })}>
                <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                  <path
                    d="M4 16h3l8.5-8.5a2.1 2.1 0 0 0-3-3L4 13v3zM11.5 5.5l3 3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
          <p className="totals" aria-live="polite">
            {overview ? (
              <>
                <span className="total-line">
                  <b>{n(total)}</b> 通
                </span>
                <span className="unread-total">未読 {n(unread)}</span>
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
            <button role="tab" aria-selected={view === 'search'} onClick={() => setView('search')}>
              検索
            </button>
            <button role="tab" aria-selected={view === 'drafts'} onClick={() => setView('drafts')}>
              下書き
            </button>
          </div>
          {accounts.length > 1 && (
            <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="アカウント">
              <option value="">すべてのアカウント</option>
              {accounts.map((a) => (
                <option key={a.account} value={a.account}>
                  {accountName(a, accounts)}
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

      {view === 'senders' && (
        <Senders
          senders={senders}
          account={account}
          canTriage={canTriage}
          archive={archive}
          onError={guard}
          onOpen={openMessage}
        />
      )}
      {view === 'timeline' && (
        <Timeline
          account={account}
          canTriage={canTriage}
          archive={archive}
          version={version}
          onError={guard}
          onOpen={openMessage}
        />
      )}
      {view === 'drafts' && <Drafts version={version} onOpen={(id) => openCompose({ draftId: id })} onError={guard} />}
      {view === 'search' && (
        <Search account={account} canTriage={canTriage} archive={archive} onError={guard} onOpen={openMessage} />
      )}

      <Activity jobs={jobs} now={now} onDismiss={dismiss} />
      {opened && (
        <MessageView
          target={opened}
          onClose={() => history.back()}
          onError={guard}
          onMarkedRead={reload}
          onReply={(replyTo, replyAll) => openCompose({ replyTo, replyAll })}
        />
      )}
      {composing && (
        <Compose
          target={composing}
          accounts={accounts}
          canSend={overview?.me.scopes.includes('mail.send') ?? false}
          onClose={() => history.back()}
          onError={guard}
          onSent={(d) => {
            history.back()
            setSentNotice(`「${d.subject || '（件名なし）'}」を送信しました`)
            setTimeout(() => setSentNotice(null), 6000)
            reload()
          }}
        />
      )}
      {sentNotice && (
        <div className="activity">
          <div className="job done">
            <div className="job-line">
              <span className="job-label">{sentNotice}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// 選択肢に出す名前。表示名が同じアカウントがあるときだけアドレスを添えて見分けられるようにする
function accountName(a: Account, all: Account[]): string {
  const dup = all.some((b) => b !== a && b.label === a.label)
  return dup || a.label === a.account ? `${a.label} <${a.account}>` : a.label
}

// 1 通分の行。アイコンを押すと選択、本文側を押すと開く
function MessageRow(props: {
  from: { name: string | null; address: string | null } | null
  subject: string | null
  receivedAt: string | null
  badge?: string
  selectable: boolean
  selected: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const name = senderName(props.from)
  return (
    <div className="msg-row">
      {props.selectable ? (
        <button
          className="avatar-button"
          aria-pressed={props.selected}
          aria-label={`${name}「${props.subject ?? ''}」を${props.selected ? '選択から外す' : '選ぶ'}`}
          onClick={props.onToggle}
        >
          <Avatar name={name} seed={props.from?.address ?? ''} checked={props.selected} />
        </button>
      ) : (
        <Avatar name={name} seed={props.from?.address ?? ''} />
      )}
      <button className="msg-open" onClick={props.onOpen}>
        <span className="line">
          <span className="who">{name}</span>
          <time dateTime={props.receivedAt ?? undefined}>{when(props.receivedAt)}</time>
        </span>
        <span className="subject">
          {props.badge && <span className="badge">{props.badge}</span>}
          {props.subject || '（件名なし）'}
        </span>
      </button>
    </div>
  )
}

// 差出人の頭文字の丸いアイコン。checked のときはチェックに変わる（新しい順で選んだとき）
function Avatar({ name, seed, checked }: { name: string; seed: string; checked?: boolean }) {
  return (
    <span
      className={checked ? 'avatar checked' : 'avatar'}
      style={{ '--hue': avatarHue(seed) } as CSSProperties}
      aria-hidden="true"
    >
      {checked ? '✓' : initial(name)}
    </span>
  )
}

// 引っ張って更新の表示。引いた分だけ矢印が回り、離せば更新されるところで向きが変わる
function PullIndicator({ pull, ready, refreshing }: { pull: number; ready: boolean; refreshing: boolean }) {
  if (pull === 0 && !refreshing) return null
  return (
    <div className="pull" style={{ transform: `translate(-50%, ${pull - 44}px)` }} aria-hidden="true">
      {refreshing ? (
        <span className="spinner" />
      ) : (
        <svg viewBox="0 0 20 20" width="18" height="18" style={{ transform: `rotate(${ready ? 180 : pull * 2}deg)` }}>
          <path d="M10 4v12M5 11l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
    </div>
  )
}

// 画面下の進行状況。PWA では押した後に何が起きているか見えにくいので、段階と経過秒数を出し続ける
function Activity({ jobs, now, onDismiss }: { jobs: Job[]; now: number; onDismiss: (id: number) => void }) {
  if (jobs.length === 0) return null
  return (
    <div className="activity" aria-live="polite">
      {jobs.map((j) => {
        const finished = j.phase === 'done' || j.phase === 'failed'
        const seconds = Math.max(0, Math.round((now - j.startedAt) / 1000))
        return (
          <div key={j.id} className={`job ${j.phase}`}>
            <div className="job-line">
              {!finished && <span className="spinner" aria-hidden="true" />}
              <span className="job-label">{j.label}</span>
              <span className="job-phase">
                {j.phase === 'done'
                  ? `${n(j.count ?? 0)} 通をアーカイブしました`
                  : j.phase === 'failed'
                    ? '失敗しました'
                    : `${PHASE_LABEL[j.phase]}${j.count ? `（${n(j.count)} 通）` : ''}・${seconds} 秒`}
              </span>
              {j.phase === 'failed' && (
                <button className="job-close" onClick={() => onDismiss(j.id)} aria-label="閉じる">
                  閉じる
                </button>
              )}
            </div>
            {j.phase === 'failed' && <p className="job-error">{j.error}</p>}
            {!finished && <span className="progress" aria-hidden="true" />}
          </div>
        )
      })}
    </div>
  )
}

// 受信トレイの内訳。上位の差出人ほど左に大きく並び、片付けるほど縮む
function Composition({ senders, total }: { senders: Sender[]; total: number }) {
  if (total === 0) return <div className="composition empty" />
  const top = senders.slice(0, 30)
  const topSum = top.reduce((s, x) => s + x.total, 0)
  const rest = Math.max(total - topSum, 0)
  const share = Math.round((topSum / total) * 100)
  return (
    <figure className="composition-wrap">
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
      <figcaption>
        上位 {top.length} 件の差出人で {n(topSum)} 通（全体の {share}%）
      </figcaption>
    </figure>
  )
}

type ArchiveFn = (body: Record<string, unknown>, label: string) => Promise<void>

function Senders(props: {
  senders: Sender[] | null
  account: string
  canTriage: boolean
  archive: ArchiveFn
  onError: (err: unknown) => void
  onOpen: (ref: MessageRef) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())

  if (!props.senders) return <p className="notice">読み込み中</p>
  if (props.senders.length === 0) return <p className="notice">受信トレイは空です。</p>

  const setBusyFor = (addresses: string[], on: boolean) =>
    setBusy((b) => {
      const next = new Set(b)
      for (const a of addresses) {
        if (on) next.add(a)
        else next.delete(a)
      }
      return next
    })

  // 1 件でも複数でも、差出人のアドレスを渡して積む
  const run = async (targets: Sender[], markRead: boolean) => {
    const addresses = targets.map((s) => s.address)
    const label = targets.length === 1 ? senderName(targets[0]!) : `${targets.length} 件の差出人`
    setSelected(new Set())
    setBusyFor(addresses, true)
    await props.archive({ senders: addresses, account: props.account || undefined, mark_read: markRead }, label)
    setBusyFor(addresses, false)
  }

  const toggle = (address: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(address)) next.delete(address)
      else next.add(address)
      return next
    })

  const chosen = props.senders.filter((s) => selected.has(s.address))
  const chosenTotal = chosen.reduce((sum, s) => sum + s.total, 0)

  return (
    <>
      {props.canTriage && (
        <div className="list-tools">
          <span className="hint">アイコンを押すと複数選べます</span>
          {selected.size > 0 && (
            <button className="quiet" onClick={() => setSelected(new Set())}>
              選択を外す
            </button>
          )}
        </div>
      )}
      <ol className="senders">
        {props.senders.map((s) => {
          const isSelected = selected.has(s.address)
          return (
            <li
              key={s.address}
              className={[busy.has(s.address) ? 'busy' : '', isSelected ? 'selected' : ''].join(' ').trim()}
            >
              <div className="sender-row">
                {props.canTriage ? (
                  <button
                    className="avatar-button"
                    aria-pressed={isSelected}
                    aria-label={`${senderName(s)}を${isSelected ? '選択から外す' : '選ぶ'}`}
                    disabled={busy.has(s.address)}
                    onClick={() => toggle(s.address)}
                  >
                    <Avatar name={senderName(s)} seed={s.address} checked={isSelected} />
                  </button>
                ) : (
                  <Avatar name={senderName(s)} seed={s.address} />
                )}
                <button
                  className="sender-main"
                  aria-expanded={open === s.address}
                  onClick={() => setOpen(open === s.address ? null : s.address)}
                >
                  <span className="sender-name">{senderName(s)}</span>
                  <span className="sender-sub">
                    <span className="sender-address">{s.address}</span>
                    {s.unread > 0 && <span className="unread">未読 {n(s.unread)}</span>}
                  </span>
                </button>
                <b className="count">{n(s.total)}</b>
                {/* 選んでいる間は、行ごとのボタンを隠して下のバーに操作をまとめる */}
                {props.canTriage && (selected.size === 0 || busy.has(s.address)) && (
                  <ConfirmButton
                    label="片付ける"
                    confirmLabel={`${n(s.total)} 通を既読にしてアーカイブ`}
                    busyLabel="片付け中"
                    busy={busy.has(s.address)}
                    onConfirm={() => void run([s], true)}
                  />
                )}
              </div>
              {open === s.address && (
                <SenderDetail
                  sender={s}
                  account={props.account}
                  canTriage={props.canTriage}
                  busy={busy.has(s.address)}
                  onArchiveKeepUnread={() => void run([s], false)}
                  onError={props.onError}
                  onOpen={props.onOpen}
                />
              )}
            </li>
          )
        })}
      </ol>
      {chosen.length > 0 && (
        <div className="selection-bar">
          <span>
            <b>{n(chosen.length)}</b> 件（{n(chosenTotal)} 通）
          </span>
          <button className="quiet" onClick={() => void run(chosen, false)}>
            アーカイブ
          </button>
          <button className="primary" onClick={() => void run(chosen, true)}>
            既読にしてアーカイブ
          </button>
        </div>
      )}
    </>
  )
}

function SenderDetail(props: {
  sender: Sender
  account: string
  canTriage: boolean
  busy: boolean
  onArchiveKeepUnread: () => void
  onError: (err: unknown) => void
  onOpen: (ref: MessageRef) => void
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
              <button className="subject-open" onClick={() => props.onOpen({ id: m.id })}>
                <span className="subject">{m.subject || '（件名なし）'}</span>
                <time dateTime={m.receivedAt ?? undefined}>{when(m.receivedAt)}</time>
              </button>
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
      <button className="primary is-busy" disabled>
        <span className="spinner" aria-hidden="true" />
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
  onOpen: (ref: MessageRef) => void
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
    const ids = [...selected]
    // 操作バーと進行状況の欄が重ならないよう、積んだらすぐ選択を外す
    setSelected(new Set())
    setBusy(true)
    await props.archive({ message_ids: ids, mark_read: markRead }, `選んだ ${ids.length} 通`)
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
        <label className="switch">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
          未読だけ
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
            <li
              key={m.id}
              className={[m.unread ? 'is-unread' : '', selected.has(m.id) ? 'selected' : ''].join(' ').trim()}
            >
              <MessageRow
                from={m.from}
                subject={m.subject}
                receivedAt={m.receivedAt}
                selectable={props.canTriage}
                selected={selected.has(m.id)}
                onToggle={() => toggle(m.id)}
                onOpen={() => props.onOpen({ id: m.id })}
              />
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

// すべてのメールをメールサーバー側で検索する（Gmail は Gmail の検索式、本文も対象）
function Search(props: {
  account: string
  canTriage: boolean
  archive: ArchiveFn
  onError: (err: unknown) => void
  onOpen: (ref: MessageRef) => void
}) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState<{ query: string; started: number } | null>(null)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!searching) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [searching])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    setSearching({ query: q, started: Date.now() })
    setNow(Date.now())
    setError(null)
    setSelected(new Set())
    try {
      const params = new URLSearchParams({ q, limit: '50' })
      if (props.account) params.set('account', props.account)
      setResult(await api<SearchResult>(`/mcp/api/search?${params}`))
    } catch (err) {
      if (err instanceof LoggedOut) props.onError(err)
      else setError((err as Error).message)
    } finally {
      setSearching(null)
    }
  }

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const run = async (markRead: boolean) => {
    const ids = [...selected]
    setSelected(new Set())
    await props.archive({ message_ids: ids, mark_read: markRead }, `検索結果の ${ids.length} 通`)
    // 受信トレイから外れたことを結果にも反映する
    setResult((r) =>
      r
        ? {
            ...r,
            hits: r.hits.map((h) =>
              h.messageId && ids.includes(h.messageId) ? { ...h, inInbox: false, messageId: null } : h,
            ),
          }
        : r,
    )
  }

  const matched = result?.totals.reduce((sum, t) => sum + (t.matched ?? 0), 0) ?? 0
  const failed = result?.totals.filter((t) => t.error) ?? []

  return (
    <>
      <form className="search-form" onSubmit={(e) => void submit(e)} role="search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="from:amazon.co.jp after:2024/01/01 など"
          aria-label="検索語"
          enterKeyHint="search"
        />
        <button className="primary" disabled={!query.trim() || searching != null}>
          検索
        </button>
      </form>
      <p className="hint search-hint">
        アーカイブ済みも含むすべてのメールを、本文まで探します。Gmail は Gmail と同じ検索式が使えます。
      </p>

      {searching && (
        <p className="notice searching">
          <span className="spinner" aria-hidden="true" />「{searching.query}」をメールサーバーで検索中・
          {Math.round((now - searching.started) / 1000)} 秒
        </p>
      )}
      {error && <p className="notice error">{error}</p>}
      {!searching && result && (
        <>
          <p className="result-summary">
            {n(matched)} 件見つかりました
            {matched > result.hits.length && `（新しい ${n(result.hits.length)} 件を表示）`}
            {failed.length > 0 && (
              <span className="error">。{failed.map((f) => f.account).join('、')} は検索できませんでした</span>
            )}
          </p>
          {result.hits.length > 0 && (
            <ol className="timeline">
              {result.hits.map((h, i) => (
                <li
                  key={`${h.account}:${h.mailbox}:${h.uid}:${i}`}
                  className={[h.unread ? 'is-unread' : '', h.messageId && selected.has(h.messageId) ? 'selected' : '']
                    .join(' ')
                    .trim()}
                >
                  <MessageRow
                    from={h.from}
                    subject={h.subject}
                    receivedAt={h.receivedAt}
                    badge={h.inInbox ? '受信トレイ' : undefined}
                    selectable={props.canTriage && h.messageId != null}
                    selected={h.messageId != null && selected.has(h.messageId)}
                    onToggle={() => h.messageId && toggle(h.messageId)}
                    onOpen={() =>
                      props.onOpen(
                        h.messageId ? { id: h.messageId } : { account: h.account, mailbox: h.mailbox, uid: h.uid },
                      )
                    }
                  />
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {selected.size > 0 && (
        <div className="selection-bar">
          <span>
            <b>{n(selected.size)}</b> 通を選択中
          </span>
          <button className="quiet" onClick={() => void run(false)}>
            アーカイブ
          </button>
          <button className="primary" onClick={() => void run(true)}>
            既読にしてアーカイブ
          </button>
        </div>
      )}
    </>
  )
}

// 下書きの一覧（エージェントが作ったものも並ぶ）。押すと作成画面で開く
function Drafts(props: { version: number; onOpen: (id: string) => void; onError: (err: unknown) => void }) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  useEffect(() => {
    api<Draft[]>('/mcp/api/drafts').then(setDrafts).catch(props.onError)
  }, [props.version, props.onError])

  if (!drafts) return <p className="notice">読み込み中</p>
  if (drafts.length === 0)
    return (
      <p className="notice">下書きはありません。右上の ✎ から書けます。Claude に返信の下書きを頼むこともできます。</p>
    )
  return (
    <ol className="timeline">
      {drafts.map((d) => {
        const to = d.to.map((a) => a.name || a.address).join(', ')
        const byAgent = d.createdBy.startsWith('mcp:')
        return (
          <li key={d.id}>
            <div className="msg-row">
              <Avatar name={to || '?'} seed={d.to[0]?.address ?? d.id} />
              <button className="msg-open" onClick={() => props.onOpen(d.id)}>
                <span className="line">
                  <span className="who">{to || '（宛先なし）'}</span>
                  <time dateTime={d.updatedAt}>{when(d.updatedAt)}</time>
                </span>
                <span className="subject">
                  {d.status === 'failed' && <span className="badge failed">送信失敗</span>}
                  {byAgent && <span className="badge">{d.createdBy.slice(4)} が作成</span>}
                  {d.subject || '（件名なし）'}
                </span>
              </button>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
