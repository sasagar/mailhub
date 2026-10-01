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
  createDraft,
  deleteDraft,
  enqueueArchiveBySenders,
  enqueueMarkSeen,
  getMessageBody,
  getOperations,
  inboxOverview,
  listDrafts,
  listMessages,
  searchMail,
  senderSummary,
  updateDraft,
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
          '全アカウントの受信トレイの件数・未読数・最終同期時刻と、送信に使えるエイリアス（aliases）を返す。まずこれで全体を把握してから他のツールを使う。',
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
      'read_message',
      {
        description:
          'メールの本文とヘッダー（宛先・CC・日時・Message-ID など）を読む。受信トレイのメールは message_id（list_messages や search_mail の messageId）で、' +
          '受信トレイに無いメール（search_mail の結果）は account・mailbox・uid で指定する。本文はテキスト（HTML メールはテキストに直したもの）。' +
          '長い本文は max_chars で切る。既読にはしない（必要なら mark_read）。',
        inputSchema: {
          message_id: z.string().regex(/^\d+$/).optional(),
          account: z.string().optional(),
          mailbox: z.string().optional(),
          uid: z.number().int().positive().optional(),
          max_chars: z.number().int().min(200).max(100_000).default(20_000),
        },
        annotations: { readOnlyHint: true },
      },
      async (a) => {
        requireScope('mail.read')
        const ref = a.message_id
          ? { messageId: a.message_id }
          : a.account && a.mailbox && a.uid
            ? { account: a.account, mailbox: a.mailbox, uid: a.uid }
            : null
        if (!ref) throw new Error('message_id か、account・mailbox・uid の組を指定してください')
        const body = await getMessageBody(sql, ref, `mcp:${props.clientName}`)
        const truncated = body.text.length > a.max_chars
        return json({
          ...body,
          html: undefined,
          text: truncated
            ? `${body.text.slice(0, a.max_chars)}\n…（以下 ${body.text.length - a.max_chars} 文字省略）`
            : body.text,
          truncated,
        })
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
      'mark_read',
      {
        description:
          '受信トレイのメールを既読にする（アーカイブはしない）。id は list_messages や search_mail の messageId。',
        inputSchema: { message_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(2000) },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (a) => {
        requireScope('mail.triage')
        return json(await enqueueMarkSeen(sql, { messageIds: a.message_ids, requestedBy: `mcp:${props.clientName}` }))
      },
    )

    // 送信は Web 画面で本人が行う。エージェントは下書きまで（送信のツールは無い）
    const draftLink = (id: string) => `${new URL(env.MCP_RESOURCE).origin}/app/#draft=${id}`
    const addrList = z.union([z.string(), z.array(z.string())]).optional()

    server.registerTool(
      'create_draft',
      {
        description:
          'メールの下書きを作る（送信はしない。送信は本人が mailhub の Web 画面で確認して行う）。' +
          'reply_to_message_id（受信トレイのメールの ID）または reply_to_account・reply_to_mailbox・reply_to_uid（search_mail の結果）を渡すと返信になり、' +
          '宛先・「Re: 件名」・引用・返信ヘッダーを元のメールから組み立てる（to や subject を渡せばそちらが優先）。body には本文だけを書けば、引用は後ろに付く。' +
          '返したリンクを本人に伝えると、Web 画面で開いて送信できる。',
        inputSchema: {
          body: z.string().max(100_000).describe('本文（プレーンテキスト）'),
          to: addrList.describe('宛先。「名前 <a@b>」や「a@b」をカンマ区切りか配列で'),
          cc: addrList,
          bcc: addrList,
          subject: z.string().max(500).optional(),
          account: z.string().optional().describe('送信に使うアカウント（返信なら元のメールのアカウント）'),
          from: z
            .string()
            .optional()
            .describe(
              '差出人のアドレス。アカウント本体か、inbox_overview の aliases にあるもの。返信でエイリアス宛てなら省略時にそのエイリアスになる',
            ),
          reply_to_message_id: z.string().regex(/^\d+$/).optional(),
          reply_to_account: z.string().optional(),
          reply_to_mailbox: z.string().optional(),
          reply_to_uid: z.number().int().positive().optional(),
          reply_all: z.boolean().default(false).describe('返信のとき、元の宛先と CC にも送る'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async (a) => {
        requireScope('mail.triage')
        const replyTo = a.reply_to_message_id
          ? { messageId: a.reply_to_message_id }
          : a.reply_to_account && a.reply_to_mailbox && a.reply_to_uid
            ? { account: a.reply_to_account, mailbox: a.reply_to_mailbox, uid: a.reply_to_uid }
            : undefined
        const draft = await createDraft(sql, {
          account: a.account,
          to: a.to,
          cc: a.cc,
          bcc: a.bcc,
          subject: a.subject,
          body: a.body,
          from: a.from,
          replyTo,
          replyAll: a.reply_all,
          createdBy: `mcp:${props.clientName}`,
        })
        return json({ draft, openInMailhub: draftLink(draft.id) })
      },
    )

    server.registerTool(
      'update_draft',
      {
        description: '下書きを書き直す（送信前のものだけ）。渡した項目だけを置き換える。',
        inputSchema: {
          draft_id: z.string().regex(/^\d+$/),
          to: addrList,
          cc: addrList,
          bcc: addrList,
          subject: z.string().max(500).optional(),
          body: z.string().max(100_000).optional(),
          from: z.string().optional().describe('差出人のアドレス（アカウント本体かエイリアス）'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (a) => {
        requireScope('mail.triage')
        const draft = await updateDraft(sql, a.draft_id, a)
        return json({ draft, openInMailhub: draftLink(draft.id) })
      },
    )

    server.registerTool(
      'list_drafts',
      {
        description: '下書きの一覧（送信前のもの。include_sent で送信済みも）。',
        inputSchema: { include_sent: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(20) },
        annotations: { readOnlyHint: true },
      },
      async (a) => {
        requireScope('mail.read')
        return json(await listDrafts(sql, { includeSent: a.include_sent, limit: a.limit }))
      },
    )

    server.registerTool(
      'delete_draft',
      {
        description: '下書きを消す（送信前のものだけ）。',
        inputSchema: { draft_id: z.string().regex(/^\d+$/) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      async (a) => {
        requireScope('mail.triage')
        await deleteDraft(sql, a.draft_id)
        return json({ deleted: a.draft_id })
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
