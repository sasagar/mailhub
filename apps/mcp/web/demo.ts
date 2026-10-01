// 開発サーバーで ?demo を付けたときだけ使う見本データ。デザインの確認用で、本番のビルドには入らない
import type {
  Draft,
  Message,
  MessageBody,
  MessagePage,
  Operation,
  Overview,
  Queued,
  SearchResult,
  Sender,
} from './types.ts'

const NAMES: [string, string, number, number][] = [
  ['＠IT通信 Special', 'atmarkit-mail@noreply.itmedia.co.jp', 176, 175],
  ['YOUTRUST', 'hello@youtrust.jp', 154, 152],
  ['ニューエラ公式オンラインストア', 'news@news.neweraonlinestore.jp', 152, 151],
  ['Money Forward ME', 'feedback@moneyforward.com', 151, 150],
  ['JAL Pay', 'info@jal-paymentport.co.jp', 131, 131],
  ['Just MyShop', 'info@mag.justmyshop.com', 139, 139],
  ['Amazon.co.jp', 'store-news@amazon.co.jp', 109, 104],
  ['ITmedia エンタープライズ', 'enterprise-mail@noreply.itmedia.co.jp', 98, 97],
  ['Wantedly', 'message-noreply@wantedly.com', 87, 80],
  ['Klook', 'support-noreply@klook.com', 64, 64],
  ['さくらインターネット', 'support@sakura.ad.jp', 52, 12],
  ['GitHub', 'notifications@github.com', 48, 3],
  ['Airbnb', 'automated@airbnb.com', 41, 20],
  ['ローソン銀行', 'notice@maild.lawsonbank.jp', 33, 33],
  ['Google', 'no-reply@accounts.google.com', 29, 2],
]
const SUBJECTS = [
  '【本日のお買い得商品】 オーガニックバナナ 50%OFF',
  '中川 こころさん他19名があなたのプロフィールに注目しています',
  'DDoSかBotか アクセス急増から事業を守る最新WAF運用',
  '6月30日～7月7日のご予約が確定しました',
  '[会員メニュー] クレジットカードによる支払い',
  'セキュリティ通知',
  '配達済み: 「ASMARK 交換用バッテリー MacBook Pro...」',
  '【重要】実特法に基づく届出書のご提出のお願い',
]

let senders: Sender[] = [
  ...NAMES.map(([name, address, total, unread], i) => ({
    name,
    address,
    total,
    unread,
    latest: new Date(Date.now() - i * 3_600_000 * 5).toISOString(),
  })),
  ...Array.from({ length: 25 }, (_, i) => ({
    name: `ニュースレター ${i + 1}`,
    address: `news${i + 1}@example.jp`,
    total: 24 - (i % 20),
    unread: 20 - (i % 20),
    latest: new Date(Date.now() - (i + 15) * 86_400_000).toISOString(),
  })),
]
const OTHER = 6200

const messagesOf = (from?: string): Message[] =>
  senders
    .filter((s) => !from || s.address === from)
    .flatMap((s, si) =>
      Array.from({ length: Math.min(s.total, from ? 12 : 3) }, (_, k) => ({
        id: `${si * 1000 + k}`,
        account: 'me@example.com',
        from: { name: s.name, address: s.address },
        subject: SUBJECTS[(si + k) % SUBJECTS.length]!,
        receivedAt: new Date(Date.now() - (si * 3 + k) * 3_600_000).toISOString(),
        unread: k % 3 !== 2,
      })),
    )

let draftSeq = 100
let drafts: Draft[] = [
  {
    id: '99',
    account: 'me@example.com',
    to: [{ name: '山田 太郎', address: 'taro@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Re: 来週の打ち合わせ',
    body: '山田さん\n\n来週火曜の 14 時で大丈夫です。\n',
    replyToMessageId: null,
    inReplyTo: null,
    status: 'draft',
    error: null,
    createdBy: 'mcp:Claude',
    updatedAt: new Date().toISOString(),
    sentAt: null,
  },
]

type Pending = { started: number; count: number; senders: string[] }
const ops = new Map<string, Pending>()
let opSeq = 1

export async function demoApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  await new Promise((r) => setTimeout(r, 300))
  const url = new URL(path, location.origin)
  const tail = url.pathname.replace('/mcp/api/', '')
  const total = senders.reduce((s, x) => s + x.total, 0) + OTHER
  const unread = senders.reduce((s, x) => s + x.unread, 0) + 3100
  if (tail === 'overview') {
    const o: Overview = {
      me: { email: 'me@example.com', scopes: ['mail.read', 'mail.triage', 'mail.send'] },
      accounts: [{ account: 'me@example.com', label: 'わたし', total, unread, syncedAt: new Date().toISOString() }],
    }
    return o as T
  }
  if (tail === 'senders') return senders as T
  if (tail === 'messages') {
    const all = messagesOf(url.searchParams.get('from') ?? undefined)
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const page: MessagePage = { total: all.length, offset, messages: all.slice(offset, offset + limit) }
    return page as T
  }
  if (tail === 'archive') {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
      sender?: string
      senders?: string[]
      message_ids?: string[]
    }
    const targets = body.senders ?? (body.sender ? [body.sender] : [])
    const count = targets.length
      ? senders.filter((s) => targets.includes(s.address)).reduce((sum, s) => sum + s.total, 0)
      : (body.message_ids?.length ?? 0)
    const id = String(opSeq++)
    ops.set(id, { started: Date.now(), count, senders: targets })
    const q: Queued = { operations: [{ operationId: id, account: 'me@example.com', count }], notFound: [] }
    return q as T
  }
  if (tail === 'search') {
    // 本物は数秒かかるので、待ち時間の表示も確かめられるようにする
    await new Promise((r) => setTimeout(r, 2500))
    const q = url.searchParams.get('q') ?? ''
    const hits = messagesOf()
      .slice(0, 12)
      .map((m, i) => ({
        account: m.account,
        mailbox: '[Gmail]/すべてのメール',
        uid: 1000 + i,
        subject: `${m.subject}（${q}）`,
        from: m.from,
        receivedAt: new Date(Date.now() - i * 86_400_000 * 40).toISOString(),
        unread: i % 4 === 0,
        inInbox: i < 3,
        messageId: i < 3 ? m.id : null,
        gmThreadId: String(i),
      }))
    const r: SearchResult = { hits, totals: [{ account: 'me@example.com', matched: 1284, error: null }] }
    return r as T
  }
  if (tail === 'mark-read') return { operations: [], count: 1 } as T
  if (tail === 'message') {
    await new Promise((r) => setTimeout(r, 600))
    const id = url.searchParams.get('id')
    const m = messagesOf().find((x) => x.id === id) ?? messagesOf()[0]!
    const body: MessageBody = {
      account: 'me@example.com',
      mailbox: 'INBOX',
      uid: 1,
      messageId: id,
      unread: m.unread,
      headers: {
        subject: m.subject,
        from: m.from,
        to: [{ name: 'わたし', address: 'me@example.com' }],
        cc: [],
        replyTo: [],
        date: m.receivedAt,
        messageId: '<demo@example.com>',
        inReplyTo: null,
        references: null,
      },
      text: 'テキスト版の本文です。',
      html: `<div style="font-family:sans-serif"><h1 style="color:#c45">${m.subject}</h1>
<p>いつもご利用いただきありがとうございます。本メールは見本です。</p>
<p><img src="https://example.com/banner.png" alt="バナー" width="600" height="200"></p>
<table style="width:100%;border-collapse:collapse"><tr><td style="border:1px solid #ccc;padding:8px">商品</td><td style="border:1px solid #ccc;padding:8px">¥1,980</td></tr></table>
<p><a href="https://example.com/">詳しくはこちら</a></p></div>`,
      attachments: [{ index: 0, filename: '領収書.pdf', mimeType: 'application/pdf', size: 182_000 }],
    }
    return body as T
  }
  if (tail === 'drafts') {
    const method = init.method ?? 'GET'
    const id = url.searchParams.get('id')
    if (method === 'GET' && !id) return drafts as T
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
      id?: string
      reply_to?: unknown
      subject?: string
      body?: string
    }
    if (method === 'POST') {
      const d: Draft = {
        id: String(draftSeq++),
        account: 'me@example.com',
        to: body.reply_to ? [{ name: 'YOUTRUST', address: 'hello@youtrust.jp' }] : [],
        cc: [],
        bcc: [],
        subject: body.reply_to
          ? 'Re: 中川 こころさん他19名があなたのプロフィールに注目しています'
          : (body.subject ?? ''),
        body: body.reply_to
          ? '\n\n2026/10/1 11:14 YOUTRUST <hello@youtrust.jp>:\n> 本文の引用です。\n'
          : (body.body ?? ''),
        replyToMessageId: null,
        inReplyTo: null,
        status: 'draft',
        error: null,
        createdBy: 'web:mailhub Web',
        updatedAt: new Date().toISOString(),
        sentAt: null,
      }
      drafts = [d, ...drafts]
      return d as T
    }
    const target = id ?? String(body.id)
    const d = drafts.find((x) => x.id === target)!
    if (method === 'GET') return d as T
    if (method === 'PATCH') {
      Object.assign(d, {
        subject: body.subject ?? d.subject,
        body: body.body ?? d.body,
        updatedAt: new Date().toISOString(),
      })
      return d as T
    }
    drafts = drafts.filter((x) => x.id !== target)
    return { deleted: target } as T
  }
  if (tail === 'send') {
    await new Promise((r) => setTimeout(r, 1500))
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { id: string }
    const d = drafts.find((x) => x.id === body.id)!
    drafts = drafts.filter((x) => x.id !== body.id)
    return { ...d, status: 'sent', sentAt: new Date().toISOString() } as T
  }
  if (tail === 'operations') {
    const list = (url.searchParams.get('ids') ?? '').split(',').map((id): Operation => {
      const p = ops.get(id)!
      const age = Date.now() - p.started
      // 2 秒待って、4 秒かけて移動する、という流れを見せる
      const status = age < 2000 ? 'queued' : age < 6000 ? 'running' : 'done'
      if (status === 'done') senders = senders.filter((s) => !p.senders.includes(s.address))
      return {
        operationId: id,
        status,
        count: p.count,
        result: status === 'done' ? { moved: p.count } : null,
        error: null,
      }
    })
    return list as T
  }
  throw new Error(`demo: ${path} は未対応`)
}
