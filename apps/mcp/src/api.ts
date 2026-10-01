// Web 画面用の API。MCP と同じ OAuth のトークン（ctx.props）で守られ、同じクエリを使う。
// トークンの宛先（/mcp）の配下に置く必要があるので /mcp/api/ にある
import { z } from 'zod'
import { createSql, type Sql } from '@mailhub/db'
import {
  enqueueArchive,
  enqueueArchiveBySenders,
  getOperations,
  inboxOverview,
  searchMail,
  listMessages,
  senderSummary,
} from './queries.ts'
import type { Props, Scope } from './scopes.ts'

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
const ArchiveBody = z.union([
  z.object({ message_ids: z.array(numericId).min(1).max(2000), mark_read: z.boolean().default(false) }),
  z.object({ sender: z.string().min(3), account: z.string().optional(), mark_read: z.boolean().default(false) }),
  z.object({
    senders: z.array(z.string().min(3)).min(1).max(200),
    account: z.string().optional(),
    mark_read: z.boolean().default(false),
  }),
])

async function route(request: Request, sql: Sql, props: Props): Promise<Response> {
  const url = new URL(request.url)
  const q = url.searchParams
  const need = (scope: Scope) => {
    if (!props.scopes.includes(scope)) throw new HttpError(403, `${scope} の権限がありません`)
  }

  if (request.method === 'GET' && url.pathname === `${API_PREFIX}overview`) {
    need('mail.read')
    return json({ me: { email: props.email, scopes: props.scopes }, accounts: await inboxOverview(sql) })
  }
  if (request.method === 'GET' && url.pathname === `${API_PREFIX}senders`) {
    need('mail.read')
    const limit = Math.min(Number(q.get('limit') ?? 100) || 100, 500)
    return json(await senderSummary(sql, { account: q.get('account') ?? undefined, limit }))
  }
  if (request.method === 'GET' && url.pathname === `${API_PREFIX}messages`) {
    need('mail.read')
    return json(
      await listMessages(sql, {
        account: q.get('account') ?? undefined,
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
        account: q.get('account') ?? undefined,
        maxResults: Math.min(Number(q.get('limit') ?? 50) || 50, 200),
        requestedBy: `web:${props.clientName}`,
      }),
    )
  }
  if (request.method === 'GET' && url.pathname === `${API_PREFIX}operations`) {
    need('mail.read')
    const ids = (q.get('ids') ?? '').split(',').filter((s) => /^\d+$/.test(s))
    if (ids.length === 0) throw new HttpError(400, 'ids を指定してください')
    return json(await getOperations(sql, ids.slice(0, 100)))
  }
  if (request.method === 'POST' && url.pathname === `${API_PREFIX}archive`) {
    need('mail.triage')
    const parsed = ArchiveBody.safeParse(await request.json().catch(() => null))
    if (!parsed.success) throw new HttpError(400, '本文の形式が正しくありません')
    const requestedBy = `web:${props.clientName}`
    const body = parsed.data
    if ('message_ids' in body) {
      return json(await enqueueArchive(sql, { messageIds: body.message_ids, markSeen: body.mark_read, requestedBy }))
    }
    const addresses = 'senders' in body ? body.senders : [body.sender]
    return json(
      await enqueueArchiveBySenders(sql, { addresses, account: body.account, markSeen: body.mark_read, requestedBy }),
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
    const sql = createSql(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false })
    try {
      return await route(request, sql, props as Props)
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status)
      console.error(`${new URL(request.url).pathname}: ${(err as Error).message}`)
      return json({ error: '内部エラーが起きました' }, 500)
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }))
    }
  },
}
