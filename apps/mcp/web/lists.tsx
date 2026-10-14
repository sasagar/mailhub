// 一覧の画面: 新しい順（受信トレイ・迷惑メール）、差出人ごと、検索、下書き
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, LoggedOut } from './auth.ts'
import { n, senderName, when } from './format.ts'
import type { Draft, Message, MessagePage, MessageRef, SearchResult, Sender } from './types.ts'
import { AccountTag, Avatar, ConfirmButton, Icon } from './ui.tsx'

export type ArchiveFn = (body: Record<string, unknown>, label: string, path?: string) => Promise<boolean>

// 開いているメールと一覧の行を突き合わせるための鍵
export const refKey = (ref: MessageRef) =>
  'id' in ref ? `id:${ref.id}` : `at:${ref.account}|${ref.mailbox}|${ref.uid}`

// 一覧に共通で渡すもの
type ListProps = {
  account: string
  canTriage: boolean
  archive: ArchiveFn
  // 開いているメール（行を目立たせる）
  activeKey: string | null
  // アーカイブなどを頼んで、結果を待たずに一覧から外したメール
  removed: Set<string>
  // 表示している順の一覧（本文の画面で「次のメール」を開くのに使う）
  onItems: (refs: MessageRef[]) => void
  onError: (err: unknown) => void
  onOpen: (ref: MessageRef) => void
}

const toggleIn = (set: Set<string>, key: string) => {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

// 1 通分の行。アイコンを押すと選択、本文側を押すと開く
function MessageRow(props: {
  from: { name: string | null; address: string | null } | null
  subject: string | null
  receivedAt: string | null
  account?: string
  unread: boolean
  badge?: string
  active: boolean
  selectable: boolean
  selected: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const name = senderName(props.from)
  return (
    <li
      className={[
        'msg',
        props.unread ? 'is-unread' : '',
        props.selected ? 'selected' : '',
        props.active ? 'active' : '',
      ]
        .join(' ')
        .trim()}
    >
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
      <button className="msg-open" aria-current={props.active ? 'true' : undefined} onClick={props.onOpen}>
        <span className="msg-line">
          <span className="who">{name}</span>
          <time dateTime={props.receivedAt ?? undefined}>{when(props.receivedAt)}</time>
        </span>
        <span className="msg-line">
          <span className="subject">
            {props.badge && <span className="badge">{props.badge}</span>}
            {props.subject || '（件名なし）'}
          </span>
          {props.account && <AccountTag account={props.account} />}
        </span>
      </button>
    </li>
  )
}

// 選んだメールへの操作。スマホでは画面下、PC では一覧の下に出す
function SelectionBar(props: { label: React.ReactNode; onClear: () => void; children: React.ReactNode }) {
  return (
    <div className="selection-bar" role="toolbar" aria-label="選んだメールの操作">
      <button className="icon-button" onClick={props.onClear} aria-label="選択を外す">
        <Icon name="close" size={16} />
      </button>
      <span className="selection-count">{props.label}</span>
      <span className="selection-actions">{props.children}</span>
    </div>
  )
}

// ---- 新しい順（受信トレイ・迷惑メール） ----

export function Timeline(props: ListProps & { folder: 'inbox' | 'junk'; canDelete: boolean; version: number }) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [total, setTotal] = useState(0)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const { onItems, onError } = props

  const query = useCallback(
    (offset: number) => {
      const q = new URLSearchParams({ limit: '50', offset: String(offset), folder: props.folder })
      if (props.account) q.set('account', props.account)
      if (unreadOnly) q.set('unread', '1')
      return api<MessagePage>(`/mcp/api/messages?${q}`)
    },
    [props.account, props.folder, unreadOnly],
  )

  useEffect(() => {
    setSelected(new Set())
    query(0)
      .then((p) => {
        setMessages(p.messages)
        setTotal(p.total)
      })
      .catch(onError)
  }, [query, props.version, onError])

  const visible = useMemo(() => messages?.filter((m) => !props.removed.has(m.id)) ?? null, [messages, props.removed])
  useEffect(() => {
    onItems(visible?.map((m) => ({ id: m.id })) ?? [])
  }, [visible, onItems])

  const more = () =>
    query(messages?.length ?? 0)
      .then((p) => setMessages((m) => [...(m ?? []), ...p.messages]))
      .catch(onError)

  const run = async (action: 'archive' | 'spam' | 'not_spam', markRead: boolean) => {
    const ids = [...selected]
    setSelected(new Set())
    setBusy(true)
    const label = { archive: '', spam: '迷惑メールへ: ', not_spam: '受信トレイに戻す: ' }[action]
    await props.archive({ message_ids: ids, mark_read: markRead, action }, `${label}選んだ ${ids.length} 通`)
    setBusy(false)
  }
  const junk = props.folder === 'junk'
  const DELETE = '/mcp/api/delete-junk'
  const deleteSelected = async () => {
    const ids = [...selected]
    setSelected(new Set())
    setBusy(true)
    await props.archive({ message_ids: ids }, `迷惑メールを削除: ${ids.length} 通`, DELETE)
    setBusy(false)
  }
  const emptyJunk = async () => {
    setBusy(true)
    await props.archive(
      { all: true, account: props.account || undefined },
      `迷惑メールフォルダを空にする: ${total} 通`,
      DELETE,
    )
    setBusy(false)
  }

  const allSelected = visible != null && visible.length > 0 && visible.every((m) => selected.has(m.id))

  if (!visible) return <Loading />

  return (
    <>
      <div className="list-tools">
        <label className="switch">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
          未読だけ
        </label>
        {props.canTriage && visible.length > 0 && (
          <button
            className="text-button"
            onClick={() => setSelected(allSelected ? new Set() : new Set(visible.map((m) => m.id)))}
          >
            {allSelected ? '選択を外す' : `${visible.length} 通をすべて選ぶ`}
          </button>
        )}
      </div>
      {junk && (
        <div className="junk-tools">
          <p className="hint">迷惑メールフォルダのメールです。開いても画像は読み込みません。</p>
          {props.canDelete && total > 0 && (
            <ConfirmButton
              label="迷惑メールフォルダを空にする"
              confirmLabel={`${n(total)} 通を完全に削除`}
              busyLabel="削除中"
              busy={busy}
              onConfirm={() => void emptyJunk()}
            />
          )}
        </div>
      )}
      {visible.length === 0 ? (
        <Empty
          icon={junk ? 'junk' : 'inbox'}
          text={unreadOnly ? '未読のメールはありません' : junk ? '迷惑メールはありません' : '受信トレイは空です'}
        />
      ) : (
        <ol className="list">
          {visible.map((m) => (
            <MessageRow
              key={m.id}
              from={m.from}
              subject={m.subject}
              receivedAt={m.receivedAt}
              account={props.account ? undefined : m.account}
              unread={m.unread}
              active={props.activeKey === `id:${m.id}`}
              selectable={props.canTriage}
              selected={selected.has(m.id)}
              onToggle={() => setSelected((s) => toggleIn(s, m.id))}
              onOpen={() => props.onOpen({ id: m.id })}
            />
          ))}
        </ol>
      )}
      {messages && messages.length < total && (
        <button className="quiet load-more" onClick={() => void more()}>
          続きを読み込む（残り {n(total - messages.length)} 通）
        </button>
      )}
      {selected.size > 0 && (
        <SelectionBar label={<>{n(selected.size)} 通</>} onClear={() => setSelected(new Set())}>
          {junk ? (
            <>
              {props.canDelete && (
                <ConfirmButton
                  label="削除"
                  confirmLabel={`${n(selected.size)} 通を完全に削除`}
                  busyLabel="削除中"
                  busy={busy}
                  onConfirm={() => void deleteSelected()}
                />
              )}
              <button className="primary" disabled={busy} onClick={() => void run('not_spam', false)}>
                迷惑メールではない
              </button>
            </>
          ) : (
            <>
              <button className="quiet" disabled={busy} onClick={() => void run('spam', true)}>
                迷惑メール
              </button>
              <button className="quiet" disabled={busy} onClick={() => void run('archive', false)}>
                アーカイブ
              </button>
              <button className="primary" disabled={busy} onClick={() => void run('archive', true)}>
                既読にしてアーカイブ
              </button>
            </>
          )}
        </SelectionBar>
      )}
    </>
  )
}

// ---- 差出人ごと ----

// 受信トレイの内訳。上位の差出人ほど左に大きく並び、片付けるほど縮む
function Composition({ senders, total }: { senders: Sender[]; total: number }) {
  if (total === 0) return null
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
        上位 {top.length} 件の差出人で {n(topSum)} 通（受信トレイの {share}%）
      </figcaption>
    </figure>
  )
}

export function Senders(props: ListProps & { version: number; total: number }) {
  const [senders, setSenders] = useState<Sender[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const { onItems, onError } = props

  useEffect(() => {
    const q = props.account ? `&account=${encodeURIComponent(props.account)}` : ''
    api<Sender[]>(`/mcp/api/senders?limit=200${q}`).then(setSenders).catch(onError)
  }, [props.account, props.version, onError])
  // 差出人ごとの画面では「次のメール」はたどらない
  useEffect(() => {
    onItems([])
  }, [onItems])

  if (!senders) return <Loading />
  if (senders.length === 0) return <Empty icon="inbox" text="受信トレイは空です" />

  const setBusyFor = (addresses: string[], on: boolean) =>
    setBusy((b) => {
      const next = new Set(b)
      for (const a of addresses) {
        if (on) next.add(a)
        else next.delete(a)
      }
      return next
    })

  // 1 件でも複数でも、差出人のアドレスを渡して積む。spam なら迷惑メールフォルダへ（既読にしてから）
  const run = async (targets: Sender[], markRead: boolean, spam = false) => {
    const addresses = targets.map((s) => s.address)
    const who = targets.length === 1 ? senderName(targets[0]!) : `${targets.length} 件の差出人`
    setSelected(new Set())
    setBusyFor(addresses, true)
    await props.archive(
      {
        senders: addresses,
        account: props.account || undefined,
        mark_read: spam || markRead,
        action: spam ? 'spam' : 'archive',
      },
      spam ? `迷惑メールへ: ${who}` : who,
    )
    setBusyFor(addresses, false)
  }

  const chosen = senders.filter((s) => selected.has(s.address))
  const chosenTotal = chosen.reduce((sum, s) => sum + s.total, 0)

  return (
    <>
      <Composition senders={senders} total={props.total} />
      {props.canTriage && (
        <p className="hint list-hint">アイコンを押すと複数選べます。名前を押すと最近のメールが出ます。</p>
      )}
      <ol className="list senders">
        {senders.map((s) => {
          const isSelected = selected.has(s.address)
          const isBusy = busy.has(s.address)
          return (
            <li
              key={s.address}
              className={['sender', isBusy ? 'busy' : '', isSelected ? 'selected' : ''].join(' ').trim()}
            >
              <div className="sender-row">
                {props.canTriage ? (
                  <button
                    className="avatar-button"
                    aria-pressed={isSelected}
                    aria-label={`${senderName(s)}を${isSelected ? '選択から外す' : '選ぶ'}`}
                    disabled={isBusy}
                    onClick={() => setSelected((cur) => toggleIn(cur, s.address))}
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
                  </span>
                </button>
                <span className="sender-count">
                  <b>{n(s.total)}</b>
                  {s.unread > 0 && <span className="unread">未読 {n(s.unread)}</span>}
                </span>
                {props.canTriage && (selected.size === 0 || isBusy) && (
                  <ConfirmButton
                    className="sender-action"
                    label="片付ける"
                    confirmLabel={`${n(s.total)} 通を既読にしてアーカイブ`}
                    busyLabel="片付け中"
                    busy={isBusy}
                    onConfirm={() => void run([s], true)}
                  />
                )}
              </div>
              {open === s.address && (
                <SenderDetail
                  sender={s}
                  account={props.account}
                  canTriage={props.canTriage}
                  busy={isBusy}
                  activeKey={props.activeKey}
                  onArchiveKeepUnread={() => void run([s], false)}
                  onSpam={() => void run([s], true, true)}
                  onError={onError}
                  onOpen={props.onOpen}
                />
              )}
            </li>
          )
        })}
      </ol>
      {chosen.length > 0 && (
        <SelectionBar
          label={
            <>
              {n(chosen.length)} 件・{n(chosenTotal)} 通
            </>
          }
          onClear={() => setSelected(new Set())}
        >
          <button className="quiet" onClick={() => void run(chosen, false, true)}>
            迷惑メール
          </button>
          <button className="quiet" onClick={() => void run(chosen, false)}>
            アーカイブ
          </button>
          <button className="primary" onClick={() => void run(chosen, true)}>
            既読にしてアーカイブ
          </button>
        </SelectionBar>
      )}
    </>
  )
}

function SenderDetail(props: {
  sender: Sender
  account: string
  canTriage: boolean
  busy: boolean
  activeKey: string | null
  onArchiveKeepUnread: () => void
  onSpam: () => void
  onError: (err: unknown) => void
  onOpen: (ref: MessageRef) => void
}) {
  const [page, setPage] = useState<MessagePage | null>(null)
  const { onError } = props
  useEffect(() => {
    const q = new URLSearchParams({ from: props.sender.address, limit: '8' })
    if (props.account) q.set('account', props.account)
    api<MessagePage>(`/mcp/api/messages?${q}`).then(setPage).catch(onError)
  }, [props.sender.address, props.account, onError])

  return (
    <div className="detail">
      {!page ? (
        <p className="muted">読み込み中</p>
      ) : (
        <ul className="subjects">
          {page.messages.map((m) => (
            <li
              key={m.id}
              className={[m.unread ? 'is-unread' : '', props.activeKey === `id:${m.id}` ? 'active' : '']
                .join(' ')
                .trim()}
            >
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
        <div className="detail-actions">
          <button className="quiet" disabled={props.busy} onClick={props.onArchiveKeepUnread}>
            未読のままアーカイブ
          </button>
          <button className="quiet" disabled={props.busy} onClick={props.onSpam}>
            迷惑メールにする
          </button>
        </div>
      )}
    </div>
  )
}

// ---- 検索 ----

// すべてのメールをメールサーバー側で検索する（Gmail は Gmail の検索式、本文も対象）
export function Search(props: ListProps & { autoFocus: boolean }) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState<{ query: string; started: number } | null>(null)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const { onItems } = props

  useEffect(() => {
    if (!searching) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [searching])

  const hits = useMemo(
    () => result?.hits.filter((h) => !(h.messageId && props.removed.has(h.messageId))) ?? [],
    [result, props.removed],
  )
  useEffect(() => {
    onItems(
      hits.map((h) => (h.messageId ? { id: h.messageId } : { account: h.account, mailbox: h.mailbox, uid: h.uid })),
    )
  }, [hits, onItems])

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
        <span className="search-field">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="from:amazon.co.jp 請求書 など"
            aria-label="検索語"
            enterKeyHint="search"
            autoFocus={props.autoFocus}
          />
        </span>
        <button className="primary" disabled={!query.trim() || searching != null}>
          検索
        </button>
      </form>
      <p className="hint list-hint">
        アーカイブ済みも含め、本文まで探します。Gmail のアカウントは Gmail と同じ検索式が使えます。
      </p>

      {searching && (
        <p className="notice searching">
          <span className="spinner" aria-hidden="true" />「{searching.query}」を検索中・
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
          {hits.length > 0 && (
            <ol className="list">
              {hits.map((h, i) => {
                const ref = h.messageId ? { id: h.messageId } : { account: h.account, mailbox: h.mailbox, uid: h.uid }
                return (
                  <MessageRow
                    key={`${h.account}:${h.mailbox}:${h.uid}:${i}`}
                    from={h.from}
                    subject={h.subject}
                    receivedAt={h.receivedAt}
                    account={props.account ? undefined : h.account}
                    unread={h.unread}
                    badge={h.inInbox ? '受信トレイ' : undefined}
                    active={props.activeKey === refKey(ref)}
                    selectable={props.canTriage && h.messageId != null}
                    selected={h.messageId != null && selected.has(h.messageId)}
                    onToggle={() => h.messageId && setSelected((s) => toggleIn(s, h.messageId!))}
                    onOpen={() => props.onOpen(ref)}
                  />
                )
              })}
            </ol>
          )}
        </>
      )}
      {selected.size > 0 && (
        <SelectionBar label={<>{n(selected.size)} 通</>} onClear={() => setSelected(new Set())}>
          <button className="quiet" onClick={() => void run(false)}>
            アーカイブ
          </button>
          <button className="primary" onClick={() => void run(true)}>
            既読にしてアーカイブ
          </button>
        </SelectionBar>
      )}
    </>
  )
}

// ---- 下書き ----

// 下書きの一覧（エージェントが作ったものも並ぶ）。押すと作成画面で開く
export function Drafts(props: {
  drafts: Draft[] | null
  onOpen: (id: string) => void
  onItems: (refs: MessageRef[]) => void
}) {
  const { onItems } = props
  useEffect(() => {
    onItems([])
  }, [onItems])
  if (!props.drafts) return <Loading />
  if (props.drafts.length === 0)
    return <Empty icon="draft" text="下書きはありません。Claude に返信の下書きを頼むこともできます" />
  return (
    <ol className="list">
      {props.drafts.map((d) => {
        // 宛先は表示名ではなくアドレスで見せる（表示名は相手やエージェントが自由に付けられ、偽装に使える）
        const to = d.to.map((a) => a.address).join(', ')
        return (
          <li key={d.id} className="msg">
            <Avatar name={to || '?'} seed={d.to[0]?.address ?? d.id} />
            <button className="msg-open" onClick={() => props.onOpen(d.id)}>
              <span className="msg-line">
                <span className="who">{to || '（宛先なし）'}</span>
                <time dateTime={d.updatedAt}>{when(d.updatedAt)}</time>
              </span>
              <span className="msg-line">
                <span className="subject">
                  {d.status === 'failed' && <span className="badge failed">送信失敗</span>}
                  {d.status === 'queued' && <span className="badge">送信待ち</span>}
                  {d.agentTouched && (
                    <span className="badge">{(d.updatedBy ?? d.createdBy).replace(/^mcp:/, '')} が作成・変更</span>
                  )}
                  {d.warnings.length > 0 && <span className="badge failed">宛先を確認</span>}
                  {d.attachments.length > 0 && <span className="badge">添付 {d.attachments.length}</span>}
                  {d.subject || '（件名なし）'}
                </span>
                <AccountTag account={d.account} />
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function Loading() {
  return (
    <p className="notice searching">
      <span className="spinner" aria-hidden="true" />
      読み込み中
    </p>
  )
}

function Empty({ icon, text }: { icon: 'inbox' | 'junk' | 'draft'; text: string }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <p>{text}</p>
    </div>
  )
}
