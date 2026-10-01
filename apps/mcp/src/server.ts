import { env } from 'cloudflare:workers'
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { z } from 'zod'
import { createSql, type Sql } from '@mailhub/db'
import { API_PREFIX, restApi } from './api.ts'
import { authHandler } from './auth/handler.ts'
import {
  enqueueArchive,
  enqueueArchiveBySenders,
  getOperations,
  inboxOverview,
  listMessages,
  searchMail,
  senderSummary,
} from './queries.ts'
import { SCOPES, type Props, type Scope } from './scopes.ts'

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }] })

// リクエストごとに作る（createMcpHandler はステートレス。サーバーを使い回さない）。
// 権限の無いツールは一覧にも出さない。念のため実行時にも確かめる
function createServer(sql: Sql, props: Props) {
  const server = new McpServer({ name: 'mailhub', version: '0.2.0' })
  const can = (scope: Scope) => props.scopes.includes(scope)
  const requireScope = (scope: Scope) => {
    if (!can(scope)) throw new Error(`このトークンには ${scope}（${SCOPES[scope].label}）の権限がありません`)
  }

  if (can('mail.read')) {
    server.registerTool(
      'inbox_overview',
      {
        description:
          '全アカウントの受信トレイの件数・未読数・最終同期時刻を返す。まずこれで全体を把握してから他のツールを使う。',
        annotations: { readOnlyHint: true },
      },
      async () => {
        requireScope('mail.read')
        return json(await inboxOverview(sql))
      },
    )

    server.registerTool(
      'list_messages',
      {
        description:
          '受信トレイのメールを新しい順に一覧する（本文なし）。条件はすべて AND。from と subject は部分一致。total で全件数が分かるので、多ければ offset でページングする。返す id は archive_messages に渡せる。',
        inputSchema: {
          account: z.string().optional().describe('アカウントのメールアドレス。省略で全アカウント'),
          from: z.string().optional().describe('差出人アドレスの部分一致'),
          subject: z.string().optional().describe('件名の部分一致'),
          unread_only: z.boolean().optional().describe('未読だけ'),
          since: z.string().optional().describe('この日時以降に受信（ISO 8601）'),
          until: z.string().optional().describe('この日時より前に受信（ISO 8601）'),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        },
        annotations: { readOnlyHint: true },
      },
      async (a) => {
        requireScope('mail.read')
        return json(
          await listMessages(sql, {
            account: a.account,
            from: a.from,
            subject: a.subject,
            unreadOnly: a.unread_only,
            since: a.since,
            until: a.until,
            limit: a.limit,
            offset: a.offset,
          }),
        )
      },
    )

    server.registerTool(
      'sender_summary',
      {
        description:
          '受信トレイを差出人ごとに集計し、件数の多い順に返す。まとめてアーカイブする候補（メルマガ・通知など）を探すのに使う。',
        inputSchema: {
          account: z.string().optional().describe('アカウントのメールアドレス。省略で全アカウント'),
          limit: z.number().int().min(1).max(200).default(30),
        },
        annotations: { readOnlyHint: true },
      },
      async (a) => {
        requireScope('mail.read')
        return json(await senderSummary(sql, { account: a.account, limit: a.limit }))
      },
    )

    server.registerTool(
      'search_mail',
      {
        description:
          '受信トレイだけでなく、アーカイブ済みを含むすべてのメールをメールサーバー側で検索する（本文も対象）。新しい順に返す。' +
          'Gmail のアカウントは Gmail の検索式がそのまま使える（例: from:amazon.co.jp after:2024/01/01 has:attachment、' +
          'subject:請求書、"完全一致の語句"、label:xxx、in:sent）。Gmail 以外は語句が件名・差出人・本文のどれかに含まれるものを探す。' +
          '1 回に数秒かかる。結果の messageId が null でないものは受信トレイにあり、archive_messages にそのまま渡せる。',
        inputSchema: {
          query: z.string().min(1).max(500).describe('検索語。Gmail なら Gmail の検索式'),
          account: z.string().optional().describe('アカウントのメールアドレス。省略で全アカウント'),
          max_results: z.number().int().min(1).max(200).default(30),
        },
        annotations: { readOnlyHint: true },
      },
      async (a) => {
        requireScope('mail.read')
        return json(
          await searchMail(sql, {
            query: a.query,
            account: a.account,
            maxResults: a.max_results,
            requestedBy: `mcp:${props.clientName}`,
          }),
        )
      },
    )

    server.registerTool(
      'get_operations',
      {
        description: 'archive_messages で積んだ操作の状況（queued / running / done / failed）と結果を返す。',
        inputSchema: { operation_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(100) },
        annotations: { readOnlyHint: true },
      },
      async (a) => {
        requireScope('mail.read')
        return json(await getOperations(sql, a.operation_ids))
      },
    )
  }

  if (can('mail.triage')) {
    server.registerTool(
      'archive_messages',
      {
        description:
          '指定したメールを受信トレイからアーカイブする（Gmail は受信トレイのラベルを外す。削除はしない）。' +
          'すぐには実行されず、操作として積まれ、同期デーモンがアカウントのフォルダごとに 1 回でまとめて処理する。' +
          '返る operation_id を get_operations に渡すと完了を確認できる。id は list_messages の id。',
        inputSchema: {
          message_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(2000),
          mark_read: z.boolean().default(false).describe('アーカイブの前に既読にする'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (a) => {
        requireScope('mail.triage')
        return json(
          await enqueueArchive(sql, {
            messageIds: a.message_ids,
            markSeen: a.mark_read,
            requestedBy: `mcp:${props.clientName}`,
          }),
        )
      },
    )

    server.registerTool(
      'archive_senders',
      {
        description:
          '指定した差出人（メールアドレス）から届いた受信トレイのメールを、まとめてアーカイブする。' +
          'sender_summary で見つけたメルマガや通知を片付けるのに使う。動きは archive_messages と同じ（積んで、同期デーモンが実行する）。',
        inputSchema: {
          senders: z
            .array(z.string().min(3))
            .min(1)
            .max(200)
            .describe('差出人のメールアドレス（大文字小文字は区別しない）'),
          account: z.string().optional().describe('アカウントのメールアドレス。省略で全アカウント'),
          mark_read: z.boolean().default(false).describe('アーカイブの前に既読にする'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (a) => {
        requireScope('mail.triage')
        return json(
          await enqueueArchiveBySenders(sql, {
            addresses: a.senders,
            account: a.account,
            markSeen: a.mark_read,
            requestedBy: `mcp:${props.clientName}`,
          }),
        )
      },
    )
  }

  return server
}

// OAuthProvider がトークンを確かめた後に呼ばれる。ctx.props は同意時に焼き込んだ Props
const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const props = ctx.props as Partial<Props> | undefined
    if (!props?.email || !Array.isArray(props.scopes) || !props.clientName) {
      return new Response('トークンに権限情報がありません', { status: 403 })
    }
    // Hyperdrive がプールを持つので、Worker 側はリクエストごとに小さく作って閉じる。
    // MCP の応答は本文が後から流れる（ツールの実行前にレスポンスが返る）ので、閉じるのは本文を流し終えてから。
    // 先に閉じると、実行中のツールの 2 本目以降のクエリが CONNECTION_ENDED で落ちる
    const sql = createSql(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false })
    const close = () => sql.end({ timeout: 5 })
    let response: Response
    try {
      response = await createMcpHandler(() => createServer(sql, props as Props))(request, env, ctx)
    } catch (err) {
      ctx.waitUntil(close())
      throw err
    }
    if (!response.body) {
      ctx.waitUntil(close())
      return response
    }
    const { readable, writable } = new TransformStream()
    ctx.waitUntil(response.body.pipeTo(writable).finally(close))
    return new Response(readable, response)
  },
}

export default new OAuthProvider({
  // MCP（エージェント）と Web 画面の API（/mcp/api/*）は同じトークンで守る。
  // トークンの宛先（resource）は /mcp の 1 つだけにし、保護するパスはすべてその配下に置く。
  // MCP クライアントは宛先として MCP サーバーの URL を送ってくるので、宛先を変えると繋がらなくなる
  apiRoute: '/mcp',
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const api = new URL(request.url).pathname.startsWith(API_PREFIX)
      return api ? restApi.fetch(request, env, ctx) : mcpApi.fetch(request, env, ctx)
    },
  },
  defaultHandler: authHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: (Object.keys(SCOPES) as Scope[]).filter((s) => SCOPES[s].available),
  // 発行するトークンはこの URL 向けに縛られる。本番とローカルで違うので vars から読む
  resourceMetadata: { resource: env.MCP_RESOURCE, resource_name: 'mailhub' },
})
