// 開発サーバーで ?demo を付けたときだけ使う見本データ。デザインの確認用で、本番のビルドには入らない
import type { Message, MessagePage, Operation, Overview, Queued, Sender } from './types.ts'

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

type Pending = { started: number; count: number; sender?: string }
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
      me: { email: 'me@example.com', scopes: ['mail.read', 'mail.triage'] },
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
      message_ids?: string[]
    }
    const count = body.sender
      ? (senders.find((s) => s.address === body.sender)?.total ?? 0)
      : (body.message_ids?.length ?? 0)
    const id = String(opSeq++)
    ops.set(id, { started: Date.now(), count, sender: body.sender })
    const q: Queued = { operations: [{ operationId: id, account: 'me@example.com', count }], notFound: [] }
    return q as T
  }
  if (tail === 'operations') {
    const list = (url.searchParams.get('ids') ?? '').split(',').map((id): Operation => {
      const p = ops.get(id)!
      const age = Date.now() - p.started
      // 2 秒待って、4 秒かけて移動する、という流れを見せる
      const status = age < 2000 ? 'queued' : age < 6000 ? 'running' : 'done'
      if (status === 'done' && p.sender) senders = senders.filter((s) => s.address !== p.sender)
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
