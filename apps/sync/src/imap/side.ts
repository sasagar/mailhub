// 同期とは別の、アカウントごとの補助の IMAP 接続。検索や本文の取得に使う。
// 同期用の接続は INBOX を IDLE で見張っているので、フォルダを切り替える用事はこちらでする。
// 使うたびに繋ぎ直すと 1〜2 秒、Gmail が混んでいると 30 秒以上かかる（検索の 20 秒を超える）ので持ち続け、
// しばらく使わなければ閉じる。続けて検索するときに繋ぎ直さないよう、長めに持つ
import type { ImapFlow } from 'imapflow'
import type { Account } from '../accounts.ts'
import { imapClientFor } from './client.ts'

const IDLE_CLOSE_MS = 10 * 60_000

// 繋いで使える状態のクライアントを返す。テストでは差し替える
export type Connect = () => Promise<ImapFlow>

const connectAccount =
  (account: Account): Connect =>
  async () => {
    const client = await imapClientFor(account)
    client.on('error', () => {})
    await client.connect()
    return client
  }

export class SideConnection {
  private client: ImapFlow | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private idle: NodeJS.Timeout | null = null

  constructor(private readonly connect: Connect) {}

  // 1 本の接続でコマンドを重ねられないので、順に流す。
  // signal が切れたら、順番待ちのものは始めずに、実行中のものは接続ごと切って止める。
  // 切った接続の上のコマンドが終わらないまま残ることがある（imapflow が完了も失敗もさせない）。
  // それを待つと後ろの依頼がすべて詰まるので、切れた時点で順番を次に進め、次の依頼は新しい接続で始める
  run<T>(fn: (client: ImapFlow) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const next = this.chain.then(async () => {
      if (this.idle) clearTimeout(this.idle)
      signal?.throwIfAborted()
      const client = await untilAborted(this.connected(signal), signal)
      const abort = () => this.drop(client)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        return await untilAborted(fn(client), signal)
      } finally {
        signal?.removeEventListener('abort', abort)
        // 捨てた接続の分は、今の接続の閉じるタイマーに触らない
        if (this.client === client) this.idle = setTimeout(() => void this.close(), IDLE_CLOSE_MS)
      }
    })
    this.chain = next.catch(() => {})
    return next
  }

  private async connected(signal?: AbortSignal): Promise<ImapFlow> {
    if (this.client?.usable) return this.client
    const client = await this.connect()
    client.on('close', () => {
      if (this.client === client) this.client = null
    })
    if (signal?.aborted) {
      // 繋がる前に時間切れになった（呼んだ側はもう次へ進んでいる）。Gmail は繋ぐだけで 20 秒を超えることがあるので、
      // 捨てずに次の依頼で使う。その間に別の接続ができていたら、そちらを使う
      if (this.client?.usable) client.close()
      else {
        this.client = client
        if (this.idle) clearTimeout(this.idle)
        this.idle = setTimeout(() => void this.close(), IDLE_CLOSE_MS)
      }
      signal.throwIfAborted()
    }
    this.client = client
    return client
  }

  private drop(client: ImapFlow) {
    if (this.client === client) this.client = null
    client.close()
  }

  private async close() {
    const c = this.client
    this.client = null
    await c?.logout().catch(() => {})
  }
}

// signal が切れたら、work の終わりを待たずに失敗させる
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

const pool = new Map<number, SideConnection>()

export function sideConnection(account: Account): SideConnection {
  let c = pool.get(account.id)
  if (!c) pool.set(account.id, (c = new SideConnection(connectAccount(account))))
  return c
}
