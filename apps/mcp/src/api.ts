// Web 画面用の API。MCP と同じ OAuth のトークン（ctx.props）で守られ、同じクエリを使う。
// トークンの宛先（/mcp）の配下に置く必要があるので /mcp/api/ にある
import { z } from 'zod'
import { createSql, type Sql } from '@mailhub/db'
import {
  enqueueArchive,
  addDraftAttachment,
  ATTACHMENT_MAX_TOTAL,
  createDraft,
  deleteDraft,
  getDraftAttachment,
  normalizeAttachment,
  removeDraftAttachment,
  enqueueArchiveBySenders,
  enqueueMarkSeen,
  getAttachment,
  getMessageBody,
  enqueueEmptyJunk,
  UserError,
  getThread,
  getOperations,
  getDraft,
  inboxOverview,
  listDrafts,
  searchMail,
  sendDraftNow,
  listMessages,
  senderSummary,
  updateDraft,
} from './queries.ts'
import { blockImages, proxyImages } from './images.ts'
import { sanitizeEmailHtml } from './sanitize.ts'
import { isAllowedEmail, requester, type Props, type Scope } from './scopes.ts'

export const API_PREFIX = '/mcp/api/'

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

const numericId = z.string().regex(/^\d+$/)
const DraftBody = z.object({
  id: numericId.optional(),
  account: z.string().optional(),
  to: z.string().max(5000).optional(),
  cc: z.string().max(5000).optional(),
  bcc: z.string().max(5000).optional(),
  subject: z.string().max(500).optional(),
  body: z.string().max(100_000).optional(),
  from: z.string().max(320).optional(),
  reply_to: z
    .union([z.object({ id: numericId }), z.object({ account: z.string(), mailbox: z.string(), uid: z.number().int() })])
    .optional(),
  reply_all: z.boolean().optional(),
})
// 移動の種類。迷惑メールにする（spam）・迷惑メールではない（not_spam）も同じ口で受ける
const MoveAction = z.enum(['archive', 'spam', 'not_spam']).default('archive')
const ArchiveBody = z.union([
  z.object({ message_ids: z.array(numericId).min(1).max(2000), mark_read: z.boolean().default(false) }),
  z.object({
    sender: z.string().min(3),
    account: z.string().optional(),
    mode: z.string().optional(),
    mark_read: z.boolean().default(false),
  }),
  z.object({
    senders: z.array(z.string().min(3)).min(1).max(200),
    account: z.string().optional(),
    mode: z.string().optional(),
    mark_read: z.boolean().default(false),
  }),
])

// エージェントが 1 回に動かせるメールの上限（server.ts の MCP ツールと同じ）
const AGENT_MAX_MESSAGES = 500

async function route(request: Request, env: Env, sql: Sql, props: Props): Promise<Response> {
  const url = new URL(request.url)
  const q = url.searchParams
  const need = (scope: Scope) => {
    if (!props.scopes.includes(scope)) throw new HttpError(403, `${scope} の権限がありません`)
  }
  // 操作した人。mail.send を持つのは Web 画面のトークンだけなので、それ以外（エージェントに発行した OAuth の
  // トークンでこの API を直接叩いたもの）はエージェントとして扱う。本人の下書きに手を出させず、
  // エージェント向けの上限（1 回 500 通・1 時間 3000 通）も同じようにかける
  const actor = () => requester(props.scopes.includes('mail.send') ? 'web' : 'mcp', props)
  // アカウント 1 つか、モード（個人・仕事など）で絞る
  const scope = { account: q.get('account') ?? undefined, mode: q.get('mode') ?? undefined }

  if (request.method === 'GET' && url.pathname === `${API_PREFIX}overview`) {
    need('mail.read')
    return json({ me: { email: props.email, scopes: props.scopes }, accounts: await inboxOverview(sql) })
  }
  if (request.method === 'GET' && url.pathname === `${API_PREFIX}senders`) {
    need('mail.read')
    const limit = Math.min(Number(q.get('limit') ?? 100) || 100, 500)
    return json(await senderSummary(sql, { ...scope, limit }))
  }
  if (request.method === 'GET' && url.pathname === `${API_PREFIX}messages`) {
    need('mail.read')
    return json(
      await listMessages(sql, {
        folder: q.get('folder') === 'junk' ? 'junk' : 'inbox',
        ...scope,
        from: q.get('from') ?? undefined,
        subject: q.get('subject') ?? undefined,
        unreadOnly: q.get('unread') === '1',
        limit: Math.min(Number(q.get('limit') ?? 50) || 50, 200),
        offset: Math.max(Number(q.get('offset') ?? 0) || 0, 0),
      }),
    )
  }
  if (request.method === 'GET' && url.pathname === `${API_PREFIX}search`) {
    need('mail.read')
    const query = (q.get('q') ?? '').trim()
    if (!query || query.length > 500) throw new HttpError(400, '検索語を 1〜500 文字で指定してください')
    return json(
      await searchMail(sql, {
        query,
        ...scope,
        maxResults: Math.min(Number(q.get('limit') ?? 50) || 50, 200),
        requestedBy: actor(),
      }),
    )
  }
  if (
    request.method === 'GET' &&
    [`${API_PREFIX}message`, `${API_PREFIX}attachment`, `${API_PREFIX}thread`].includes(url.pathname)
  ) {
    need('mail.read')
    const id = q.get('id')
    const uid = Number(q.get('uid'))
    const ref =
      id && /^\d+$/.test(id)
        ? { messageId: id }
        : q.get('account') && q.get('mailbox') && uid > 0
          ? { account: q.get('account')!, mailbox: q.get('mailbox')!, uid }
          : null
    if (!ref) throw new HttpError(400, 'id か、account・mailbox・uid を指定してください')
    const by = actor()
    if (url.pathname === `${API_PREFIX}thread`) return json(await getThread(sql, ref, by))
    if (url.pathname === `${API_PREFIX}attachment`) {
      const index = Number(q.get('index'))
      if (!Number.isInteger(index) || index < 0) throw new HttpError(400, 'index を指定してください')
      const a = await getAttachment(sql, ref, index, by)
      // ファイル名は RFC 5987 で日本語も渡す。中身は画面側で保存させる（Bearer が要るのでリンクでは落とせない）
      return new Response(a.content, {
        headers: {
          'Content-Type': a.mimeType,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
    const body = await getMessageBody(sql, ref, by)
    // 外部画像は mailhub 経由で読み込ませる（相手のサーバーに閲覧者の IP を渡さない）
    // 迷惑メールの画像は、求められたとき（images=1）だけ読み込む（開いたことを送り主に知らせない）。
    // 書き換えに失敗しても本文は返す（画像は枠の CSP で止まるので IP は漏れない。画像が出ないだけ）
    const imagesBlocked = body.junk && q.get('images') !== '1'
    if (body.html) {
      body.html = sanitizeEmailHtml(body.html)
      try {
        body.html = imagesBlocked
          ? blockImages(body.html)
          : await proxyImages(body.html, url.origin, env.IMAGE_PROXY_KEY)
      } catch (err) {
        console.error(`proxyImages: ${(err as Error).message}`)
      }
    }
    return json({ ...body, imagesBlocked })
  }
  if (request.method === 'POST' && url.pathname === `${API_PREFIX}mark-read`) {
    need('mail.triage')
    const body = z
      .object({ message_ids: z.array(numericId).min(1).max(2000) })
      .safeParse(await request.json().catch(() => null))
    if (!body.success) throw new HttpError(400, '本文の形式が正しくありません')
    const requestedBy = actor()
    if (requestedBy.startsWith('mcp:') && body.data.message_ids.length > AGENT_MAX_MESSAGES) {
      throw new HttpError(400, `1 回に既読にできるのは ${AGENT_MAX_MESSAGES} 通までです`)
    }
    return json(await enqueueMarkSeen(sql, { messageIds: body.data.message_ids, requestedBy }))
  }
  // 下書き。送信だけは mail.send（Web 画面だけに与える権限）が要る
  if (url.pathname === `${API_PREFIX}drafts`) {
    if (request.method === 'GET') {
      need('mail.read')
      const id = q.get('id')
      if (id) return json(await getDraft(sql, id))
      return json(await listDrafts(sql, { includeSent: q.get('sent') === '1', limit: 50 }))
    }
    need('mail.triage')
    const body = DraftBody.safeParse(await request.json().catch(() => null))
    if (!body.success) throw new HttpError(400, '本文の形式が正しくありません')
    const d = body.data
    if (request.method === 'POST') {
      const replyTo = d.reply_to
        ? 'id' in d.reply_to
          ? { messageId: d.reply_to.id }
          : { account: d.reply_to.account, mailbox: d.reply_to.mailbox, uid: d.reply_to.uid }
        : undefined
      return json(
        await createDraft(sql, {
          account: d.account,
          to: d.to,
          cc: d.cc,
          bcc: d.bcc,
          subject: d.subject,
          body: d.body,
          from: d.from,
          replyTo,
          replyAll: d.reply_all,
          createdBy: actor(),
        }),
      )
    }
    if (!d.id) throw new HttpError(400, 'id を指定してください')
    if (request.method === 'PATCH') return json(await updateDraft(sql, d.id, d, actor()))
    if (request.method === 'DELETE') {
      await deleteDraft(sql, d.id, actor())
      return json({ deleted: d.id })
    }
  }
  // 下書きの添付ファイル。付けるときは本文にファイルの中身をそのまま入れ、名前はクエリで渡す
  if (url.pathname === `${API_PREFIX}draft-attachments`) {
    const draftId = q.get('draft') ?? ''
    if (!/^\d+$/.test(draftId)) throw new HttpError(400, 'draft を指定してください')
    const attachmentId = q.get('id') ?? ''
    if (request.method === 'GET') {
      need('mail.read')
      if (!/^\d+$/.test(attachmentId)) throw new HttpError(400, 'id を指定してください')
      const a = await getDraftAttachment(sql, draftId, attachmentId)
      return new Response(a.content, {
        headers: {
          'Content-Type': a.mimeType,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
    need('mail.triage')
    const by = actor()
    if (request.method === 'POST') {
      if (Number(request.headers.get('Content-Length') ?? 0) > ATTACHMENT_MAX_TOTAL) {
        throw new HttpError(413, `添付は合計 ${ATTACHMENT_MAX_TOTAL / 1024 / 1024}MB までです`)
      }
      const content = new Uint8Array(await request.arrayBuffer())
      if (content.byteLength === 0) throw new HttpError(400, '空のファイルは付けられません')
      if (content.byteLength > ATTACHMENT_MAX_TOTAL) {
        throw new HttpError(413, `添付は合計 ${ATTACHMENT_MAX_TOTAL / 1024 / 1024}MB までです`)
      }
      const file = normalizeAttachment(q.get('filename') ?? '', request.headers.get('Content-Type'))
      return json(await addDraftAttachment(sql, draftId, { ...file, content }, by))
    }
    if (request.method === 'DELETE') {
      if (!/^\d+$/.test(attachmentId)) throw new HttpError(400, 'id を指定してください')
      return json(await removeDraftAttachment(sql, draftId, attachmentId, by))
    }
  }
  if (request.method === 'POST' && url.pathname === `${API_PREFIX}send`) {
    need('mail.send')
    const body = z
      .object({ id: numericId, version: z.number().int().positive() })
      .safeParse(await request.json().catch(() => null))
    if (!body.success) throw new HttpError(400, 'id と version を指定してください')
    return json(await sendDraftNow(sql, body.data.id, body.data.version, actor()))
  }
  if (request.method === 'GET' && url.pathname === `${API_PREFIX}operations`) {
    need('mail.read')
    const ids = (q.get('ids') ?? '').split(',').filter((s) => /^\d+$/.test(s))
    if (ids.length === 0) throw new HttpError(400, 'ids を指定してください')
    return json(await getOperations(sql, ids.slice(0, 100)))
  }
  // 迷惑メールの削除は取り消せないので Web 画面からだけ受ける（MCP にはツールを出さない）。
  // Web 画面のトークンだけが mail.send を持つので、それで見分ける
  if (request.method === 'POST' && url.pathname === `${API_PREFIX}delete-junk`) {
    need('mail.triage')
    need('mail.send')
    const body = z
      .union([
        z.object({ message_ids: z.array(numericId).min(1).max(5000) }),
        z.object({ all: z.literal(true), account: z.string().optional(), mode: z.string().optional() }),
      ])
      .safeParse(await request.json().catch(() => null))
    if (!body.success) throw new HttpError(400, '本文の形式が正しくありません')
    const requestedBy = actor()
    if ('all' in body.data) {
      return json(await enqueueEmptyJunk(sql, { account: body.data.account, mode: body.data.mode, requestedBy }))
    }
    return json(
      await enqueueArchive(sql, { messageIds: body.data.message_ids, markSeen: false, requestedBy, action: 'delete' }),
    )
  }
  if (request.method === 'POST' && url.pathname === `${API_PREFIX}archive`) {
    need('mail.triage')
    const raw = (await request.json().catch(() => null)) as { action?: unknown } | null
    const parsed = ArchiveBody.safeParse(raw)
    const action = MoveAction.safeParse(raw?.action)
    if (!parsed.success || !action.success) throw new HttpError(400, '本文の形式が正しくありません')
    const requestedBy = actor()
    const body = parsed.data
    // エージェントのトークンには、MCP のツールと同じ 1 回 500 通の上限をかける
    const agent = requestedBy.startsWith('mcp:')
    if (agent && 'message_ids' in body && body.message_ids.length > AGENT_MAX_MESSAGES) {
      throw new HttpError(400, `1 回に動かせるのは ${AGENT_MAX_MESSAGES} 通までです`)
    }
    if ('message_ids' in body) {
      return json(
        await enqueueArchive(sql, {
          messageIds: body.message_ids,
          markSeen: body.mark_read,
          requestedBy,
          action: action.data,
        }),
      )
    }
    const addresses = 'senders' in body ? body.senders : [body.sender]
    return json(
      await enqueueArchiveBySenders(sql, {
        addresses,
        account: body.account,
        mode: body.mode,
        markSeen: body.mark_read,
        requestedBy,
        action: action.data,
        ...(agent ? { maxMessages: AGENT_MAX_MESSAGES } : {}),
      }),
    )
  }
  throw new HttpError(404, 'Not Found')
}

export const restApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const props = ctx.props as Partial<Props> | undefined
    if (!props?.email || !Array.isArray(props.scopes) || !props.clientName) {
      return json({ error: 'トークンに権限情報がありません' }, 403)
    }
    // 許可アドレスから外したら、発行済みのトークンもすぐ使えなくする
    if (!isAllowedEmail(env.ALLOWED_EMAILS, props.email)) return json({ error: '許可されていません' }, 403)
    const sql = createSql(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false })
    try {
      return await route(request, env, sql, props as Props)
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status)
      if (err instanceof UserError) return json({ error: err.message }, 422)
      console.error(`${new URL(request.url).pathname}: ${(err as Error).message}`)
      return json({ error: '内部エラーが起きました' }, 500)
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }))
    }
  },
}
