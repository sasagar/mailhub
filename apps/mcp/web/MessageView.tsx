import { useEffect, useMemo, useRef, useState } from 'react'
import { api, apiBlob, LoggedOut } from './auth.ts'
import { fmtSize, n, senderName, when } from './format.ts'
import type { Addr, MessageBody, MessageRef, ThreadItem } from './types.ts'
import { AccountTag, Icon } from './ui.tsx'

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('ja-JP', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''
const fmtAddrs = (list: Addr[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')

// HTML メールを隔離した枠で見せるための文書。スクリプトは動かさない（sandbox に allow-scripts を付けない）。
// 外部画像は常に読み込む（2026-10-02 ユーザー判断）。ただし API が画像の URL を mailhub の画像プロキシに
// 書き換えて返すので、読み込むのは mailhub からだけにする（書き換え漏れがあっても相手に IP を渡さない）。
// リンクは別のタブで開く
function frameDocument(html: string, dark: boolean): string {
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", "img-src 'self' data:", "font-src 'none'"].join('; ')
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; }
  body { padding: 14px; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Hiragino Sans', sans-serif; color: #14161a; background: #fff; word-break: break-word; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  ${dark ? 'html { filter: invert(0.88) hue-rotate(180deg); } img { filter: invert(1) hue-rotate(180deg); }' : ''}
</style></head><body>${html}</body></html>`
}

// 返信の下書きを作るときの元のメールの指定（受信トレイなら ID、それ以外は所在）
const replyRef = (b: MessageBody) =>
  b.messageId ? { id: b.messageId } : { account: b.account, mailbox: b.mailbox, uid: b.uid }

// 本文の画面からの片付け。一覧から外して次のメールを開くのは呼び出し側（App）がする
export type MessageAction = 'archive' | 'spam' | 'not_spam'

export function MessageView(props: {
  target: MessageRef
  // pane: PC の 3 列の右側に置く / sheet: スマホとタブレットで全画面に重ねる
  variant: 'pane' | 'sheet'
  canTriage: boolean
  onAction: (action: MessageAction, info: { messageId: string; subject: string }) => void
  onClose: () => void
  onError: (err: unknown) => void
  onMarkedRead: () => void
  onReply: (replyTo: { id: string } | { account: string; mailbox: string; uid: number }, replyAll: boolean) => void
  // スレッドの別のメールを開く
  onOpen: (ref: MessageRef) => void
  // 一覧の前後のメール（無ければ出さない）
  onPrev?: () => void
  onNext?: () => void
}) {
  const [body, setBody] = useState<MessageBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preferText, setPreferText] = useState(false)
  // 迷惑メールの画像を読み込むと本人が選んだ
  const [loadImages, setLoadImages] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const dark = useMemo(() => matchMedia('(prefers-color-scheme: dark)').matches, [])

  useEffect(() => {
    const q =
      'id' in props.target
        ? new URLSearchParams({ id: props.target.id })
        : new URLSearchParams({
            account: props.target.account,
            mailbox: props.target.mailbox,
            uid: String(props.target.uid),
          })
    if (loadImages) q.set('images', '1')
    api<MessageBody>(`/mcp/api/message?${q}`)
      .then((b) => {
        setBody(b)
        // 受信トレイの未読を開いたら既読にする
        if (b.messageId && b.unread) {
          void api('/mcp/api/mark-read', { method: 'POST', body: JSON.stringify({ message_ids: [b.messageId] }) }).then(
            props.onMarkedRead,
            () => {},
          )
        }
      })
      .catch((err: unknown) => {
        if (err instanceof LoggedOut) props.onError(err)
        else setError((err as Error).message)
      })
  }, [props.target, loadImages])
  // 全画面で重ねている間は、後ろの一覧をスクロールさせない
  useEffect(() => {
    if (props.variant !== 'sheet') return
    document.documentElement.classList.add('sheet-open')
    return () => document.documentElement.classList.remove('sheet-open')
  }, [props.variant])
  // 本文が替わったら先頭から見せる（PC の右側は同じ枠のまま中身だけ替わる）
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo(0, 0)
  }, [props.target])

  // スレッドは本文を出してから取りに行く（数秒かかることがあるので、本文の表示を待たせない）
  const [thread, setThread] = useState<ThreadItem[] | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  useEffect(() => {
    if (!body) return
    setThread(null)
    setThreadError(null)
    const q = new URLSearchParams({ account: body.account, mailbox: body.mailbox, uid: String(body.uid) })
    api<{ items: ThreadItem[] }>(`/mcp/api/thread?${q}`)
      .then((t) => setThread(t.items))
      .catch((err: Error) => setThreadError(err.message))
  }, [body])

  // 添付ファイルを取りに行って保存させる。取得中の番号を覚えてその行に表示を出す
  const [downloading, setDownloading] = useState<number | null>(null)
  const download = async (index: number, filename: string) => {
    if (!body) return
    setDownloading(index)
    setError(null)
    try {
      const q = new URLSearchParams({
        account: body.account,
        mailbox: body.mailbox,
        uid: String(body.uid),
        index: String(index),
      })
      const blob = await apiBlob(`/mcp/api/attachment?${q}`)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      if (err instanceof LoggedOut) props.onError(err)
      else setError(`添付ファイルを取得できませんでした: ${(err as Error).message}`)
    } finally {
      setDownloading(null)
    }
  }

  const useHtml = body?.html != null && !preferText

  // 枠の高さを中身に合わせる（スクリプトは動かさないが、同じオリジン扱いにして外から測る）
  // 中身に合わせて枠を整える。横幅 600px 前後で組まれたメールは画面からはみ出す（枠の中は横に動かせない）ので、
  // 画面より広ければ全体を縮小する。そのうえで高さを中身に合わせる
  const fit = () => {
    const f = frame.current
    const doc = f?.contentDocument
    if (!f || !doc?.body) return
    const root = doc.documentElement
    root.style.zoom = '1'
    const available = f.clientWidth
    const needed = Math.max(root.scrollWidth, doc.body.scrollWidth)
    const scale = needed > available ? available / needed : 1
    root.style.zoom = String(scale)
    // 縮小後の高さの返し方はブラウザで違うことがあるので、大きいほうを使う（切れるより余白が出るほうがよい）
    f.style.height = `${Math.ceil(Math.max(root.scrollHeight, root.getBoundingClientRect().height)) + 2}px`
  }

  // 画像やフォントが後から読み込まれて大きさが変わったら合わせ直す
  const watch = () => {
    const doc = frame.current?.contentDocument
    if (!doc?.body) return
    const observer = new ResizeObserver(() => fit())
    observer.observe(doc.body)
    for (const img of Array.from(doc.images)) img.addEventListener('load', fit)
    return observer
  }

  const pane = props.variant === 'pane'
  const subject = body?.headers.subject || '（件名なし）'
  // 片付けられるのは受信トレイか迷惑メールフォルダにあるメール（検索で見つけたアーカイブ済みは対象外）
  const act = (action: MessageAction) =>
    body?.messageId && props.onAction(action, { messageId: body.messageId, subject })
  const canAct = props.canTriage && body?.messageId != null
  const replyAll = body != null && body.headers.to.length + body.headers.cc.length > 1

  const actions = body && (
    <div className="reader-actions" role="toolbar" aria-label="このメールの操作">
      {canAct &&
        (body.junk ? (
          <button className="tool" onClick={() => act('not_spam')} title="迷惑メールではない">
            <Icon name="undo" />
            <span>迷惑メールではない</span>
          </button>
        ) : (
          <button className="tool" onClick={() => act('archive')} title="アーカイブ（e）">
            <Icon name="archive" />
            <span>アーカイブ</span>
          </button>
        ))}
      <button className="tool" onClick={() => props.onReply(replyRef(body), false)} title="返信（r）">
        <Icon name="reply" />
        <span>返信</span>
      </button>
      {replyAll && (
        <button className="tool" onClick={() => props.onReply(replyRef(body), true)} title="全員に返信（a）">
          <Icon name="replyAll" />
          <span>全員に返信</span>
        </button>
      )}
      {canAct && !body.junk && (
        <button className="tool" onClick={() => act('spam')} title="迷惑メールにする">
          <Icon name="junk" />
          <span>迷惑メール</span>
        </button>
      )}
    </div>
  )

  return (
    <div
      className={pane ? 'reader pane' : 'reader sheet'}
      role={pane ? 'region' : 'dialog'}
      aria-modal={pane ? undefined : true}
      aria-label="メール"
    >
      <div className="sheet-bar">
        {pane ? (
          actions
        ) : (
          <button className="back" onClick={props.onClose}>
            <Icon name="back" />
            戻る
          </button>
        )}
        <span className="reader-nav">
          <button className="icon-button" disabled={!props.onPrev} onClick={props.onPrev} aria-label="前のメール（k）">
            <Icon name="up" />
          </button>
          <button className="icon-button" disabled={!props.onNext} onClick={props.onNext} aria-label="次のメール（j）">
            <Icon name="down" />
          </button>
          {pane && (
            <button className="icon-button" onClick={props.onClose} aria-label="閉じる（Esc）">
              <Icon name="close" />
            </button>
          )}
        </span>
      </div>
      <div className="sheet-body" ref={scroller}>
        {error && <p className="notice error">{error}</p>}
        {!body && !error && (
          <p className="notice searching">
            <span className="spinner" aria-hidden="true" />
            本文を読み込み中
          </p>
        )}
        {body && (
          <article className="message">
            <h2 className="message-subject">{body.headers.subject || '（件名なし）'}</h2>
            <div className="message-meta">
              <p className="message-from">
                <b>{senderName(body.headers.from)}</b>
                {body.headers.from?.address && <span>{body.headers.from.address}</span>}
              </p>
              <p className="message-date">
                {fmtDate(body.headers.date)}
                <AccountTag account={body.account} />
              </p>
              <details className="message-rcpt">
                <summary>宛先 {fmtAddrs(body.headers.to).slice(0, 40)}</summary>
                <dl>
                  <dt>宛先</dt>
                  <dd>{fmtAddrs(body.headers.to) || 'なし'}</dd>
                  {body.headers.cc.length > 0 && (
                    <>
                      <dt>CC</dt>
                      <dd>{fmtAddrs(body.headers.cc)}</dd>
                    </>
                  )}
                  <dt>アカウント</dt>
                  <dd>
                    {body.account}（{body.mailbox}）
                  </dd>
                </dl>
              </details>
            </div>

            {body.html != null && (
              <div className="message-tools">
                <button className="quiet" onClick={() => setPreferText((v) => !v)}>
                  {useHtml ? 'テキストで表示' : '元の表示に戻す'}
                </button>
              </div>
            )}

            {body.imagesBlocked && useHtml && (
              <p className="images-blocked">
                迷惑メールなので画像を読み込んでいません
                <button className="quiet" onClick={() => setLoadImages(true)}>
                  画像を表示
                </button>
              </p>
            )}

            {useHtml ? (
              <iframe
                ref={frame}
                className="message-frame"
                title="本文"
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                srcDoc={frameDocument(body.html!, dark)}
                onLoad={() => {
                  fit()
                  watch()
                }}
              />
            ) : (
              <div className="message-text">{body.text || '（本文なし）'}</div>
            )}

            {body.attachments.length > 0 && (
              <section className="attachments">
                <h3>添付 {n(body.attachments.length)} 件</h3>
                <ul>
                  {body.attachments.map((a) => (
                    <li key={a.index}>
                      <button
                        className="att-button"
                        disabled={downloading != null}
                        onClick={() => void download(a.index, a.filename)}
                        aria-label={`${a.filename} をダウンロード`}
                      >
                        <span className="att-name">{a.filename}</span>
                        <span className="att-size">
                          {downloading === a.index ? <span className="spinner" aria-hidden="true" /> : fmtSize(a.size)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {thread && thread.length > 1 && (
              <section className="thread">
                <h3>このスレッドの {n(thread.length)} 通</h3>
                <ol>
                  {thread.map((t) => {
                    const current = t.mailbox === body.mailbox && t.uid === body.uid
                    return (
                      <li key={`${t.mailbox}:${t.uid}`} className={current ? 'current' : t.unread ? 'is-unread' : ''}>
                        <button
                          disabled={current}
                          onClick={() =>
                            props.onOpen(
                              t.messageId
                                ? { id: t.messageId }
                                : { account: t.account, mailbox: t.mailbox, uid: t.uid },
                            )
                          }
                        >
                          <span className="thread-line">
                            <span className="who">
                              {t.sent ? '自分' : senderName(t.from)}
                              {current && <span className="badge">表示中</span>}
                              {t.inInbox && !current && <span className="badge">受信トレイ</span>}
                            </span>
                            <time dateTime={t.receivedAt ?? undefined}>{when(t.receivedAt)}</time>
                          </span>
                          <span className="subject">{t.subject || '（件名なし）'}</span>
                        </button>
                      </li>
                    )
                  })}
                </ol>
              </section>
            )}
            {threadError && <p className="muted thread-error">スレッドを読み込めませんでした: {threadError}</p>}
          </article>
        )}
      </div>
      {/* スマホとタブレットでは、操作を親指の届く画面下に置く */}
      {!pane && actions && <div className="reader-bottom">{actions}</div>}
    </div>
  )
}
