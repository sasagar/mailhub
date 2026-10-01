import { useEffect, useMemo, useRef, useState } from 'react'
import { api, LoggedOut } from './auth.ts'
import { n, senderName } from './format.ts'
import type { Addr, MessageBody, MessageRef } from './types.ts'

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
const fmtSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`

// HTML メールを隔離した枠で見せるための文書。スクリプトは動かさず（sandbox に allow-scripts を付けない）、
// 外部画像は既定で読み込まない（追跡に使われやすい）。リンクは別のタブで開く
function frameDocument(html: string, showImages: boolean, dark: boolean): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data:${showImages ? ' https: http:' : ''}`,
    "font-src 'none'",
  ].join('; ')
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

export function MessageView(props: {
  target: MessageRef
  onClose: () => void
  onError: (err: unknown) => void
  onMarkedRead: () => void
}) {
  const [body, setBody] = useState<MessageBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showImages, setShowImages] = useState(false)
  const [preferText, setPreferText] = useState(false)
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
    // 開いている間は後ろの一覧をスクロールさせない
    document.documentElement.classList.add('sheet-open')
    return () => document.documentElement.classList.remove('sheet-open')
  }, [props.target])

  const hasRemoteImages = body?.html ? /<img[^>]+src=["']?https?:/i.test(body.html) : false
  const useHtml = body?.html != null && !preferText

  // 枠の高さを中身に合わせる（スクリプトは動かさないが、同じオリジン扱いにして外から測る）
  const fit = () => {
    const doc = frame.current?.contentDocument
    if (frame.current && doc?.body) frame.current.style.height = `${doc.documentElement.scrollHeight}px`
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="メール">
      <div className="sheet-bar">
        <button className="back" onClick={props.onClose}>
          ‹ 戻る
        </button>
      </div>
      <div className="sheet-body">
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
              <p className="message-date">{fmtDate(body.headers.date)}</p>
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
                {useHtml && hasRemoteImages && !showImages && (
                  <button className="quiet" onClick={() => setShowImages(true)}>
                    画像を表示
                  </button>
                )}
                <button className="quiet" onClick={() => setPreferText((v) => !v)}>
                  {useHtml ? 'テキストで表示' : '元の表示に戻す'}
                </button>
              </div>
            )}

            {useHtml ? (
              <iframe
                ref={frame}
                className="message-frame"
                title="本文"
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                srcDoc={frameDocument(body.html!, showImages, dark)}
                onLoad={() => {
                  fit()
                  // 画像の読み込みで高さが変わるので少し後にも合わせる
                  setTimeout(fit, 500)
                  setTimeout(fit, 2000)
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
                      <span className="att-name">{a.filename}</span>
                      <span className="att-size">{fmtSize(a.size)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </article>
        )}
      </div>
    </div>
  )
}
