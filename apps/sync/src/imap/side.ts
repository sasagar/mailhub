// 同期とは別の、アカウントごとの補助の IMAP 接続。検索や本文の取得に使う。
// 同期用の接続は INBOX を IDLE で見張っているので、フォルダを切り替える用事はこちらでする。
// 使うたびに繋ぎ直すと 1〜2 秒かかるので持ち続け、しばらく使わなければ閉じる
import type { ImapFlow } from 'imapflow'
import type { Account } from '../accounts.ts'
import { imapClientFor } from './client.ts'

const IDLE_CLOSE_MS = 2 * 60_000

class SideConnection {
  private client: ImapFlow | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private idle: NodeJS.Timeout | null = null

  constructor(private readonly account: Account) {}

  // 1 本の接続でコマンドを重ねられないので、順に流す
  run<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      if (this.idle) clearTimeout(this.idle)
      try {
        return await fn(await this.connected())
      } finally {
        this.idle = setTimeout(() => void this.close(), IDLE_CLOSE_MS)
      }
    })
    this.chain = next.catch(() => {})
    return next
  }

  private async connected(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client
    const client = await imapClientFor(this.account)
    client.on('error', () => {})
    client.on('close', () => {
      if (this.client === client) this.client = null
    })
    await client.connect()
    this.client = client
    return client
  }

  private async close() {
    const c = this.client
    this.client = null
    await c?.logout().catch(() => {})
  }
}

const pool = new Map<number, SideConnection>()

export function sideConnection(account: Account): SideConnection {
  let c = pool.get(account.id)
  if (!c) pool.set(account.id, (c = new SideConnection(account)))
  return c
}
