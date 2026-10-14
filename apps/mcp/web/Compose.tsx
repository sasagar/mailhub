import { useEffect, useRef, useState } from 'react'
import { api, login, LoggedOut } from './auth.ts'
import { fmtSize } from './format.ts'
import type { Account, ComposeTarget, Draft, DraftAddr } from './types.ts'

const joinAddrs = (list: DraftAddr[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')

type Fields = { account: string; from: string; to: string; cc: string; bcc: string; subject: string; body: string }

// 差出人の候補。アカウント本体と、そのエイリアス
type Identity = { address: string; account: string; label: string; fromName: string }
const identitiesOf = (accounts: Account[]): Identity[] =>
  accounts.flatMap((a) => [
    { address: a.account, account: a.account, label: a.label, fromName: a.fromName },
    ...a.aliases.map((l) => ({ address: l.address, account: a.account, label: a.label, fromName: l.fromName })),
  ])

const mb = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`

const fieldsOf = (d: Draft): Fields => ({
  account: d.account,
  from: d.from,
  to: joinAddrs(d.to),
  cc: joinAddrs(d.cc),
  bcc: joinAddrs(d.bcc),
  subject: d.subject,
  body: d.body,
})

// 下書きの作成・編集・送信の画面。送信は 2 回押しで確定する（取り消せないため）
export function Compose(props: {
  target: ComposeTarget
  accounts: Account[]
  canSend: boolean
  onClose: () => void
  onSent: (draft: Draft) => void
  onError: (err: unknown) => void
}) {
  const [id, setId] = useState<string | null>(null)
  // 最後に読み込んだ・保存した下書き。送信のときに版（version）を渡し、表示と違う内容が送られないようにする
  const [draft, setDraft] = useState<Draft | null>(null)
  const [fields, setFields] = useState<Fields | null>(null)
  const [saved, setSaved] = useState<Fields | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'sending' | 'attaching'>('idle')
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCc, setShowCc] = useState(false)
  const body = useRef<HTMLTextAreaElement>(null)

  const fail = (err: unknown) => {
    if (err instanceof LoggedOut) props.onError(err)
    else setError((err as Error).message)
  }

  useEffect(() => {
    const t = props.target
    const load =
      'draftId' in t
        ? api<Draft>(`/mcp/api/drafts?id=${t.draftId}`)
        : 'replyTo' in t
          ? api<Draft>('/mcp/api/drafts', {
              method: 'POST',
              body: JSON.stringify({ reply_to: t.replyTo, reply_all: t.replyAll, body: '' }),
            })
          : null
    if (!load) {
      const first = props.accounts[0]?.account ?? ''
      const blank = { account: first, from: first, to: '', cc: '', bcc: '', subject: '', body: '' }
      setFields(blank)
      setSaved(blank)
      return
    }
    load
      .then((d) => {
        setId(d.id)
        setDraft(d)
        setFields(fieldsOf(d))
        setSaved(fieldsOf(d))
        setShowCc(d.cc.length + d.bcc.length > 0)
        if (d.status === 'failed' && d.error) setError(`前回の送信に失敗しました: ${d.error}`)
        // 返信は本文の先頭（引用の上）から書き始められるようにする
        setTimeout(() => {
          body.current?.focus()
          body.current?.setSelectionRange(0, 0)
        }, 50)
      })
      .catch(fail)
    document.documentElement.classList.add('sheet-open')
    return () => document.documentElement.classList.remove('sheet-open')
  }, [props.target])

  const dirty = fields != null && JSON.stringify(fields) !== JSON.stringify(saved)

  const save = async (): Promise<Draft | null> => {
    if (!fields) return null
    setStatus('saving')
    setError(null)
    try {
      const payload = {
        from: fields.from,
        to: fields.to,
        cc: fields.cc,
        bcc: fields.bcc,
        subject: fields.subject,
        body: fields.body,
      }
      const d = id
        ? await api<Draft>('/mcp/api/drafts', { method: 'PATCH', body: JSON.stringify({ id, ...payload }) })
        : await api<Draft>('/mcp/api/drafts', { method: 'POST', body: JSON.stringify(payload) })
      setId(d.id)
      setDraft(d)
      setSaved(fieldsOf(d))
      return d
    } catch (err) {
      fail(err)
      return null
    } finally {
      setStatus('idle')
    }
  }

  const send = async () => {
    if (!armed) {
      setArmed(true)
      setTimeout(() => setArmed(false), 4000)
      return
    }
    setArmed(false)
    const target = dirty || !draft ? await save() : draft
    if (!target) return
    setStatus('sending')
    try {
      const d = await api<Draft>('/mcp/api/send', {
        method: 'POST',
        body: JSON.stringify({ id: target.id, version: target.version }),
      })
      props.onSent(d)
    } catch (err) {
      fail(err)
      setStatus('idle')
    }
  }

  // 添付を付ける。下書きがまだ無いか未保存なら、先に保存して ID と最新の版を得る
  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const list = [...files]
    const base = dirty || !draft ? await save() : draft
    if (!base) return
    // 差出人ごとの上限（サーバーと同じ値）。大きなファイルを送り始める前に止める
    const current = base.attachments.reduce((sum, a) => sum + a.size, 0)
    if (current + list.reduce((sum, f) => sum + f.size, 0) > base.attachmentLimit) {
      setError(`${base.from} から送るメールの添付は合計 ${mb(base.attachmentLimit)} までです`)
      return
    }
    setStatus('attaching')
    setError(null)
    try {
      for (const f of list) {
        const q = new URLSearchParams({ draft: base.id, filename: f.name })
        const d = await api<Draft>(`/mcp/api/draft-attachments?${q}`, {
          method: 'POST',
          headers: { 'Content-Type': f.type || 'application/octet-stream' },
          body: f,
        })
        setDraft(d)
      }
    } catch (err) {
      fail(err)
    } finally {
      setStatus('idle')
    }
  }

  const detach = async (attachmentId: string) => {
    if (!draft) return
    setStatus('attaching')
    setError(null)
    try {
      const q = new URLSearchParams({ draft: draft.id, id: attachmentId })
      setDraft(await api<Draft>(`/mcp/api/draft-attachments?${q}`, { method: 'DELETE' }))
    } catch (err) {
      fail(err)
    } finally {
      setStatus('idle')
    }
  }

  const remove = async () => {
    if (id) {
      try {
        await api('/mcp/api/drafts', { method: 'DELETE', body: JSON.stringify({ id }) })
      } catch (err) {
        fail(err)
        return
      }
    }
    props.onClose()
  }

  const set = (k: keyof Fields) => (e: { target: { value: string } }) =>
    setFields((f) => (f ? { ...f, [k]: e.target.value } : f))
  // 新規は全アカウントとそのエイリアスから、既存の下書き（返信など）は同じアカウントの中から選ぶ
  const identities = identitiesOf(props.accounts).filter((i) => !id || i.account === fields?.account)
  const chooseFrom = (address: string) => {
    const i = identities.find((x) => x.address === address)
    if (i) setFields((f) => (f ? { ...f, from: i.address, account: i.account } : f))
  }
  const busy = status !== 'idle'
  const attachmentTotal = draft?.attachments.reduce((sum, a) => sum + a.size, 0) ?? 0
  const recipients = fields ? [fields.to, fields.cc, fields.bcc].join('').trim() : ''

  return (
    <div className="sheet compose" role="dialog" aria-modal="true" aria-label="メールを書く">
      <div className="sheet-bar">
        <button className="back" onClick={() => void (dirty ? save().then(props.onClose) : props.onClose())}>
          ‹ {dirty ? '保存して閉じる' : '閉じる'}
        </button>
        <span className="bar-status">
          {status === 'attaching'
            ? '添付中…'
            : status === 'saving'
              ? '保存中…'
              : dirty
                ? '未保存'
                : id
                  ? '保存済み'
                  : ''}
        </span>
      </div>
      <div className="sheet-body">
        {!fields && !error && (
          <p className="notice searching">
            <span className="spinner" aria-hidden="true" />
            下書きを用意しています
          </p>
        )}
        {error && <p className="notice error">{error}</p>}
        {draft?.agentTouched && (
          <p className="notice agent-draft">
            エージェントが作成・変更した下書きです（{draft.updatedBy ?? draft.createdBy}
            ）。送る前に宛先・BCC・本文を確かめてください。
          </p>
        )}
        {draft?.warnings.map((w) => (
          <p key={w} className="notice error">
            {w}
          </p>
        ))}
        {fields && (
          <form className="compose-form" onSubmit={(e) => e.preventDefault()}>
            <label>
              <span>差出人</span>
              {identities.length > 1 ? (
                <select value={fields.from} onChange={(e) => chooseFrom(e.target.value)}>
                  {identities.map((i) => (
                    <option key={i.address} value={i.address}>
                      {i.fromName} &lt;{i.address}&gt;{i.address === i.account ? `（${i.label}）` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <output>
                  {identities[0]?.fromName} &lt;{fields.from}&gt;
                </output>
              )}
            </label>
            <label>
              <span>宛先</span>
              <input value={fields.to} onChange={set('to')} placeholder="name@example.com" inputMode="email" />
            </label>
            {showCc ? (
              <>
                <label>
                  <span>CC</span>
                  <input value={fields.cc} onChange={set('cc')} inputMode="email" />
                </label>
                <label>
                  <span>BCC</span>
                  <input value={fields.bcc} onChange={set('bcc')} inputMode="email" />
                </label>
              </>
            ) : (
              <button type="button" className="link-button" onClick={() => setShowCc(true)}>
                CC / BCC を足す
              </button>
            )}
            <label>
              <span>件名</span>
              <input value={fields.subject} onChange={set('subject')} />
            </label>
            <textarea ref={body} value={fields.body} onChange={set('body')} rows={14} aria-label="本文" />

            <section className="attachments compose-attachments" aria-label="添付ファイル">
              {draft && attachmentTotal > draft.attachmentLimit && (
                <p className="notice error">
                  {draft.from} から送るメールの添付は合計 {mb(draft.attachmentLimit)} までです（今は{' '}
                  {mb(attachmentTotal)}
                  ）。添付を減らすか、大きなファイルは共有リンクを本文に入れてください。
                </p>
              )}
              {draft && draft.attachments.length > 0 && (
                <ul>
                  {draft.attachments.map((a) => (
                    <li key={a.id}>
                      <span className="att-name">{a.filename}</span>
                      <span className="att-size">{fmtSize(a.size)}</span>
                      <button
                        type="button"
                        className="link-button danger"
                        disabled={busy}
                        onClick={() => void detach(a.id)}
                        aria-label={`${a.filename} を外す`}
                      >
                        外す
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <label className="link-button attach-button" aria-disabled={busy}>
                {status === 'attaching' ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> 添付しています
                  </>
                ) : (
                  'ファイルを添付'
                )}
                <input
                  type="file"
                  multiple
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    void attach(e.target.files)
                    e.target.value = ''
                  }}
                />
              </label>
            </section>

            {armed && (
              <dl className="send-summary" aria-live="polite">
                <dt>宛先</dt>
                <dd>{fields.to || 'なし'}</dd>
                {fields.cc.trim() && (
                  <>
                    <dt>CC</dt>
                    <dd>{fields.cc}</dd>
                  </>
                )}
                {fields.bcc.trim() && (
                  <>
                    <dt>BCC</dt>
                    <dd className="bcc">{fields.bcc}</dd>
                  </>
                )}
                {draft && draft.attachments.length > 0 && (
                  <>
                    <dt>添付</dt>
                    <dd>{draft.attachments.map((a) => a.filename).join('、')}</dd>
                  </>
                )}
              </dl>
            )}
            <div className="compose-actions">
              <button type="button" className="quiet danger" disabled={busy} onClick={() => void remove()}>
                {id ? '下書きを削除' : '破棄'}
              </button>
              <button type="button" className="quiet" disabled={busy || !dirty} onClick={() => void save()}>
                保存
              </button>
              {props.canSend ? (
                <button
                  type="button"
                  className={armed ? 'primary armed' : 'primary'}
                  disabled={busy || !recipients}
                  onClick={() => void send()}
                >
                  {status === 'sending' ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> 送信中
                    </>
                  ) : armed ? (
                    'もう一度押すと送信'
                  ) : (
                    '送信'
                  )}
                </button>
              ) : (
                <button type="button" className="primary" onClick={() => void save().then(() => login())}>
                  送信するにはログインし直す
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
