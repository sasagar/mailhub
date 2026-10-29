import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { api, completeLoginIfReturning, isLoggedIn, LoggedOut, login } from './auth.ts'
import { n, when } from './format.ts'
import type { ComposeTarget, Draft, MessageRef, Overview } from './types.ts'
import { PHASE_LABEL, useArchive, type Job } from './useArchive.ts'
import { Compose } from './Compose.tsx'
import { MessageView, type MessageAction } from './MessageView.tsx'
import { Drafts, refKey, Search, Senders, Timeline } from './lists.tsx'
import { AccountDot, accountInfos, AccountsProvider, Icon, ModeSwitch, useMedia, type IconName } from './ui.tsx'
import { useFreshness } from './useFreshness.ts'
import { usePullToRefresh } from './usePullToRefresh.ts'

type View = 'timeline' | 'senders' | 'search' | 'drafts' | 'junk'

const VIEWS: { id: View; label: string; short: string; icon: IconName }[] = [
  { id: 'timeline', label: '受信トレイ', short: '受信', icon: 'inbox' },
  { id: 'senders', label: '差出人ごと', short: '差出人', icon: 'people' },
  { id: 'search', label: '検索', short: '検索', icon: 'search' },
  { id: 'drafts', label: '下書き', short: '下書き', icon: 'draft' },
  { id: 'junk', label: '迷惑メール', short: '迷惑', icon: 'junk' },
]

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

// 入力中（検索欄・作成画面）はキー操作を横取りしない
// 選んだモード（個人・仕事など）は端末ごとに覚えておく。仕事の端末では仕事、のように使い分けられる
const MODE_KEY = 'mailhub:mode'
const storedMode = () => {
  try {
    return localStorage.getItem(MODE_KEY) ?? ''
  } catch {
    return ''
  }
}

const typing = (e: KeyboardEvent) => {
  const t = e.target
  return t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]') != null
}

function Inbox({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [view, setView] = useState<View>('timeline')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [account, setAccount] = useState<string>('')
  const [mode, setMode] = useState<string>(storedMode)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  // PC は 3 列（一覧の横に本文）、タブレットは 2 列、スマホは 1 列で下にタブ
  const wide = useMedia('(min-width: 1100px)')
  const roomy = useMedia('(min-width: 760px)')

  const guard = useCallback(
    (err: unknown) => {
      if (err instanceof LoggedOut) onLoggedOut()
      else setLoadError((err as Error).message)
    },
    [onLoggedOut],
  )
  const reload = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    Promise.all([api<Overview>('/mcp/api/overview'), api<Draft[]>('/mcp/api/drafts')])
      .then(([o, d]) => {
        setOverview(o)
        setDrafts(d)
        setLoadError(null)
      })
      .catch(guard)
  }, [version, guard])

  const { archive, jobs, now, dismiss } = useArchive(reload)
  const { refresh, updateReady, applyUpdate } = useFreshness(reload)
  const [refreshing, setRefreshing] = useState(false)
  const pullState = usePullToRefresh(refresh)

  // ---- 開いているメールと作成画面 ----
  // スマホでは iPhone の左端からのスワイプや「戻る」で閉じられるよう、履歴に積む。
  // PC の右側は開き替えるだけなので積まない（戻るで 1 通ずつさかのぼると煩わしい）
  const [opened, setOpened] = useState<MessageRef | null>(null)
  const openMessage = useCallback(
    (ref: MessageRef) => {
      if (!wide && !opened) history.pushState({ message: true }, '')
      setOpened(ref)
    },
    [wide, opened],
  )
  const closeMessage = useCallback(() => {
    if (wide) setOpened(null)
    else history.back()
  }, [wide])

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
  const composingRef = useRef(composing)
  composingRef.current = composing
  useEffect(() => {
    const onPop = () => {
      // 作成画面が開いていれば、それだけを閉じる（返信を書き終えても、元のメールは開いたまま）
      if (composingRef.current) setComposing(null)
      else setOpened(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // ---- 一覧の並びと、先に一覧から外したメール ----
  const items = useRef<MessageRef[]>([])
  const [itemsVersion, setItemsVersion] = useState(0)
  const onItems = useCallback((refs: MessageRef[]) => {
    items.current = refs
    setItemsVersion((v) => v + 1)
  }, [])
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const activeKey = opened ? refKey(opened) : null

  const neighbor = useCallback(
    (step: 1 | -1): MessageRef | null => {
      if (!activeKey) return null
      const list = items.current
      const i = list.findIndex((r) => refKey(r) === activeKey)
      if (i < 0) return null
      return list[i + step] ?? null
    },
    // itemsVersion: 一覧が変わったら前後も変わる
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeKey, itemsVersion],
  )
  const prev = neighbor(-1)
  const next = neighbor(1)
  const go = useCallback((ref: MessageRef | null) => ref && setOpened(ref), [])

  // 本文の画面からの片付け。結果を待たずに一覧から外し、PC なら次のメールを開く（失敗したら一覧に戻す）
  const onAction = useCallback(
    (action: MessageAction, info: { messageId: string; subject: string }) => {
      const following = neighbor(1) ?? neighbor(-1)
      setRemoved((r) => new Set(r).add(info.messageId))
      const label = { archive: '', spam: '迷惑メールへ: ', not_spam: '受信トレイに戻す: ' }[action]
      void archive(
        { message_ids: [info.messageId], action, mark_read: action !== 'not_spam' },
        `${label}${info.subject}`,
      ).then((ok) => {
        if (ok) return
        setRemoved((r) => {
          const nextSet = new Set(r)
          nextSet.delete(info.messageId)
          return nextSet
        })
      })
      if (wide && following) setOpened(following)
      else closeMessage()
    },
    [archive, neighbor, wide, closeMessage],
  )

  // ---- キー操作（PC） ----
  const searchFocus = useRef(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (composing || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return
      const first = () => items.current[0] ?? null
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          if (!opened && !wide) return
          e.preventDefault()
          go(opened ? next : first())
          break
        case 'k':
        case 'ArrowUp':
          if (!opened) return
          e.preventDefault()
          go(prev)
          break
        case 'Escape':
          if (opened) closeMessage()
          break
        case 'c':
          if (overview?.me.scopes.includes('mail.triage')) openCompose({ blank: true })
          break
        case '/':
          e.preventDefault()
          searchFocus.current = true
          setView('search')
          break
        default:
          // e・r・a は本文の画面のボタンに任せる（開いているメールの状態を知っているのはそちら）
          if (!opened) return
          if (e.key === 'e') document.querySelector<HTMLButtonElement>('.reader [title^="アーカイブ"]')?.click()
          if (e.key === 'r') document.querySelector<HTMLButtonElement>('.reader [title^="返信"]')?.click()
          if (e.key === 'a') document.querySelector<HTMLButtonElement>('.reader [title^="全員に返信"]')?.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [composing, opened, wide, next, prev, go, closeMessage, openCompose, overview])

  const changeView = (v: View) => {
    setView(v)
    if (wide) setOpened(null)
    window.scrollTo(0, 0)
  }

  const canTriage = overview?.me.scopes.includes('mail.triage') ?? false
  const canSend = overview?.me.scopes.includes('mail.send') ?? false
  const accounts = overview?.accounts ?? []
  const infos = useMemo(() => accountInfos(accounts), [accounts])
  // モードはアカウントの登録順に並べる。1 つしか無ければ切り替えは出さない
  const modes = useMemo(() => [...new Set(accounts.map((a) => a.mode))], [accounts])
  // 覚えていたモードが今は無い（名前を変えた・アカウントを外した）ときは「すべて」に戻す
  const activeMode = modes.length > 1 && modes.includes(mode) ? mode : ''
  const changeMode = (m: string) => {
    setMode(m)
    setAccount('')
    if (wide) setOpened(null)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      // 保存できなくても、このタブの間は動く
    }
  }
  const inMode = activeMode ? accounts.filter((a) => a.mode === activeMode) : accounts
  const scoped = account ? accounts.filter((a) => a.account === account) : inMode
  const total = scoped.reduce((s, a) => s + a.total, 0)
  const unread = scoped.reduce((s, a) => s + a.unread, 0)
  const junk = scoped.reduce((s, a) => s + (a.junk ?? 0), 0)
  const openDrafts = drafts?.filter((d) => d.status !== 'sent').length ?? 0
  const counts: Partial<Record<View, number>> = { timeline: unread, drafts: openDrafts, junk }
  const current = VIEWS.find((v) => v.id === view)!
  const allLabel = activeMode ? `${activeMode}のアカウントすべて` : 'すべてのアカウント'
  const accountLabel = account ? (infos.get(account)?.label ?? account) : allLabel
  const lastSync = accounts
    .map((a) => a.syncedAt)
    .filter((s): s is string => s != null)
    .sort()
    .at(-1)

  const listProps = {
    account,
    mode: activeMode,
    canTriage,
    archive,
    activeKey,
    removed,
    onItems,
    onError: guard,
    onOpen: openMessage,
  }

  const doRefresh = () => {
    setRefreshing(true)
    refresh()
    setTimeout(() => setRefreshing(false), 900)
  }

  return (
    <AccountsProvider value={infos}>
      <div
        className={['shell', wide ? 'wide' : '', roomy ? 'roomy' : 'compact', opened && wide ? 'reading' : ''].join(
          ' ',
        )}
      >
        <PullIndicator {...pullState} />

        {roomy && (
          <aside className="sidebar" aria-label="メニュー">
            <div className="brand">
              <h1>mailhub</h1>
              <button className="icon-button" aria-label="最新の状態に更新" onClick={doRefresh}>
                <span className={refreshing ? 'spinning' : ''}>
                  <Icon name="refresh" size={16} />
                </span>
              </button>
            </div>
            {modes.length > 1 && <ModeSwitch modes={modes} value={activeMode} onChange={changeMode} />}
            {canTriage && (
              <button className="compose-button" onClick={() => openCompose({ blank: true })} title="新しいメール（c）">
                <Icon name="draft" />
                新しいメール
              </button>
            )}
            <nav className="nav">
              {VIEWS.map((v) => (
                <button key={v.id} aria-current={view === v.id ? 'page' : undefined} onClick={() => changeView(v.id)}>
                  <Icon name={v.icon} />
                  <span className="nav-label">{v.label}</span>
                  {(counts[v.id] ?? 0) > 0 && <span className="nav-count">{n(counts[v.id]!)}</span>}
                </button>
              ))}
            </nav>
            {inMode.length > 1 && (
              <nav className="accounts" aria-label="アカウント">
                <h2>アカウント</h2>
                <button aria-current={account === '' ? 'true' : undefined} onClick={() => setAccount('')}>
                  <span className="account-dot all" aria-hidden="true" />
                  <span className="nav-label">すべて</span>
                  <span className="nav-count quiet-count">{n(inMode.reduce((s, a) => s + a.unread, 0))}</span>
                </button>
                {inMode.map((a) => (
                  <button
                    key={a.account}
                    aria-current={account === a.account ? 'true' : undefined}
                    onClick={() => setAccount(account === a.account ? '' : a.account)}
                    title={a.account}
                  >
                    <AccountDot account={a.account} />
                    <span className="nav-label">{infos.get(a.account)?.label}</span>
                    {a.unread > 0 && <span className="nav-count quiet-count">{n(a.unread)}</span>}
                  </button>
                ))}
              </nav>
            )}
            <p className="sync-note">
              {overview ? (
                <>
                  受信トレイ {n(total)} 通{lastSync && <> ・ {when(lastSync)} に同期</>}
                </>
              ) : (
                '読み込み中'
              )}
            </p>
          </aside>
        )}

        <main className="list-pane">
          <header className="list-head">
            {updateReady && (
              <p className="update-banner">
                新しい版があります
                <button className="primary" onClick={applyUpdate}>
                  更新
                </button>
              </p>
            )}
            <div className="list-title">
              <h2>{current.label}</h2>
              {/* アカウントの絞り込み。スマホではサイドバーが無いので、ここで選ぶ */}
              {!roomy && inMode.length > 1 && (
                <label className="account-picker">
                  {account && <AccountDot account={account} />}
                  <span>{accountLabel}</span>
                  <svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true">
                    <path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="アカウント">
                    <option value="">{allLabel}</option>
                    {inMode.map((a) => (
                      <option key={a.account} value={a.account}>
                        {infos.get(a.account)?.label}（未読 {a.unread}）
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {roomy && account && (
                <button className="filter-chip" onClick={() => setAccount('')} aria-label="アカウントの絞り込みを外す">
                  <AccountDot account={account} />
                  {accountLabel}
                  <Icon name="close" size={12} />
                </button>
              )}
              {!roomy && (
                <button className="icon-button" aria-label="最新の状態に更新" onClick={doRefresh}>
                  <span className={refreshing ? 'spinning' : ''}>
                    <Icon name="refresh" size={16} />
                  </span>
                </button>
              )}
            </div>
            {/* スマホではサイドバーが無いので、モードは一覧の上で切り替える */}
            {!roomy && modes.length > 1 && <ModeSwitch modes={modes} value={activeMode} onChange={changeMode} />}
          </header>

          {loadError && (
            <p className="notice error">
              読み込めませんでした: {loadError} <button onClick={reload}>もう一度読み込む</button>
            </p>
          )}

          <div className="list-body">
            {(view === 'timeline' || view === 'junk') && (
              <Timeline
                key={view}
                {...listProps}
                folder={view === 'junk' ? 'junk' : 'inbox'}
                // 削除は取り消せないので Web 画面のトークン（mail.send を持つ）だけに出す
                canDelete={canSend}
                version={version}
              />
            )}
            {view === 'senders' && <Senders {...listProps} version={version} total={total} />}
            {view === 'search' && <Search {...listProps} autoFocus={roomy || searchFocus.current} />}
            {view === 'drafts' && (
              <Drafts drafts={drafts} onItems={onItems} onOpen={(id) => openCompose({ draftId: id })} />
            )}
          </div>
        </main>

        {wide && (
          <section className="reader-pane">
            {opened ? (
              <MessageView
                key={JSON.stringify(opened)}
                variant="pane"
                target={opened}
                canTriage={canTriage}
                onAction={onAction}
                onClose={closeMessage}
                onError={guard}
                onMarkedRead={reload}
                onReply={(replyTo, all) => openCompose({ replyTo, replyAll: all })}
                onOpen={openMessage}
                onPrev={prev ? () => go(prev) : undefined}
                onNext={next ? () => go(next) : undefined}
              />
            ) : (
              <div className="reader-empty">
                <Icon name="inbox" size={32} />
                <p>メールを選ぶと、ここに本文が出ます</p>
                <dl className="shortcuts">
                  <dt>j / k</dt>
                  <dd>次 / 前のメール</dd>
                  <dt>e</dt>
                  <dd>アーカイブ（次のメールが開きます）</dd>
                  <dt>r / a</dt>
                  <dd>返信 / 全員に返信</dd>
                  <dt>c</dt>
                  <dd>新しいメール</dd>
                  <dt>/</dt>
                  <dd>検索</dd>
                </dl>
              </div>
            )}
          </section>
        )}

        {!wide && opened && (
          <MessageView
            key={JSON.stringify(opened)}
            variant="sheet"
            target={opened}
            canTriage={canTriage}
            onAction={onAction}
            onClose={closeMessage}
            onError={guard}
            onMarkedRead={reload}
            onReply={(replyTo, all) => openCompose({ replyTo, replyAll: all })}
            onOpen={(ref) => setOpened(ref)}
            onPrev={prev ? () => go(prev) : undefined}
            onNext={next ? () => go(next) : undefined}
          />
        )}

        {!roomy && (
          <>
            {canTriage && (
              <button className="fab" onClick={() => openCompose({ blank: true })} aria-label="新しいメール">
                <Icon name="draft" size={22} />
              </button>
            )}
            <nav className="tabbar" aria-label="表示">
              {VIEWS.map((v) => (
                <button key={v.id} aria-current={view === v.id ? 'page' : undefined} onClick={() => changeView(v.id)}>
                  <span className="tab-icon">
                    <Icon name={v.icon} size={22} />
                    {(counts[v.id] ?? 0) > 0 && (
                      <span className="tab-badge">{counts[v.id]! > 999 ? '999+' : counts[v.id]}</span>
                    )}
                  </span>
                  {v.short}
                </button>
              ))}
            </nav>
          </>
        )}

        <Activity jobs={jobs} now={now} onDismiss={dismiss} />
        {sentNotice && (
          <div className="activity">
            <div className="job done">
              <div className="job-line">
                <span className="job-label">{sentNotice}</span>
              </div>
            </div>
          </div>
        )}

        {composing && (
          <Compose
            target={composing}
            accounts={accounts}
            canSend={canSend}
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
      </div>
    </AccountsProvider>
  )
}

// 引っ張って更新の表示。引いた分だけ矢印が回り、離せば更新されるところで向きが変わる
function PullIndicator({ pull, ready, refreshing }: { pull: number; ready: boolean; refreshing: boolean }) {
  if (pull === 0 && !refreshing) return null
  return (
    <div className="pull" style={{ transform: `translate(-50%, ${pull - 44}px)` } as CSSProperties} aria-hidden="true">
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

// 画面下の進行状況。連続で片付けても積み上がらないよう、動いているものと終わったものは 1 枚にまとめる。
// 失敗だけは閉じるまで 1 件ずつ残す（理由を読んでもらう必要があるため）
function Activity({ jobs, now, onDismiss }: { jobs: Job[]; now: number; onDismiss: (id: number) => void }) {
  const active = jobs.filter((j) => j.phase !== 'done' && j.phase !== 'failed')
  const done = jobs.filter((j) => j.phase === 'done')
  const failed = jobs.filter((j) => j.phase === 'failed')
  if (jobs.length === 0) return null

  const latest = active.at(-1)
  const seconds = latest ? Math.max(0, Math.round((now - active[0]!.startedAt) / 1000)) : 0
  const waiting = active.reduce((s, j) => s + (j.count ?? 0), 0)
  const finished = done.reduce((s, j) => s + (j.count ?? 0), 0)

  return (
    <div className="activity" aria-live="polite">
      {failed.map((j) => (
        <div key={j.id} className="job failed">
          <div className="job-line">
            <span className="job-label">{j.label}</span>
            <span className="job-phase">失敗しました（一覧に戻しました）</span>
            <button className="job-close" onClick={() => onDismiss(j.id)} aria-label="閉じる">
              閉じる
            </button>
          </div>
          <p className="job-error">{j.error}</p>
        </div>
      ))}
      {latest ? (
        <div className="job">
          <div className="job-line">
            <span className="spinner" aria-hidden="true" />
            <span className="job-label">{active.length > 1 ? `${active.length} 件を処理中` : latest.label}</span>
            <span className="job-phase">
              {active.length > 1 ? `最後: ${latest.label}` : PHASE_LABEL[latest.phase]}
              {waiting > 0 && `（${n(waiting)} 通）`}・{seconds} 秒{done.length > 0 && `・完了 ${n(done.length)} 件`}
            </span>
          </div>
          <span className="progress" aria-hidden="true" />
        </div>
      ) : (
        done.length > 0 && (
          <div className="job done">
            <div className="job-line">
              <span className="job-label">{done.length > 1 ? `${done.length} 件の片付けが完了` : done[0]!.label}</span>
              <span className="job-phase">完了（{n(finished)} 通）</span>
            </div>
          </div>
        )
      )}
    </div>
  )
}
