import type { ImapFlow } from 'imapflow'
import type { Sql } from '@mailhub/db'
import type { Account } from '../accounts.ts'
import { imapClientFor } from '../imap/client.ts'
import { refreshMailboxes } from '../imap/mailboxes.ts'
import { syncMailbox } from './mailbox.ts'
import { requeueStale, runQueuedOperations } from './operations.ts'

// IDLE の通知を取りこぼしても、この間隔で必ず差分を取り直す（Spark で起きた取りこぼし対策）
const RESYNC_INTERVAL_MS = 5 * 60_000
const DEBOUNCE_MS = 1_500
const MAX_BACKOFF_MS = 5 * 60_000

// 1 アカウント分の常駐同期。段階 1 では INBOX だけを同期する。
// IMAP のコマンドは 1 本の接続で重ねられないので、同期と操作キューの実行は drain() で 1 本ずつ流す
export class AccountSync {
  private client: ImapFlow | null = null
  private stopped = false
  private draining: Promise<void> | null = null
  private needSync = false
  private needOps = false
  private debounce: NodeJS.Timeout | null = null
  private work: { sync: () => Promise<void>; ops: () => Promise<boolean> } | null = null

  constructor(
    private readonly sql: Sql,
    private readonly account: Account,
  ) {}

  private log = (msg: string) =>
    console.log(`${new Date().toLocaleTimeString('ja-JP', { hour12: false })} [${this.account.label}] ${msg}`)

  async run(): Promise<void> {
    let backoff = 5_000
    while (!this.stopped) {
      try {
        await this.session()
        backoff = 5_000
      } catch (err) {
        this.log(`エラー: ${(err as Error).message}`)
      }
      if (this.stopped) break
      this.log(`${Math.round(backoff / 1000)} 秒後に再接続`)
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
  }

  get accountId() {
    return this.account.id
  }

  // 操作キューに積まれたとき（NOTIFY）に呼ばれる。未接続なら次の接続時に拾う
  notifyOperations() {
    this.needOps = true
    this.kick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.client?.logout().catch(() => {})
  }

  // 接続してから切れるまで。切れたら resolve する
  private async session(): Promise<void> {
    const client = await imapClientFor(this.account)
    this.client = client
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))
    client.on('error', (err: Error) => this.log(`IMAP エラー: ${err.message}`))

    await client.connect()
    this.log('接続')
    const boxes = await refreshMailboxes(this.sql, client, this.account.id)
    const inbox = boxes.find((b) => b.role === 'inbox') ?? boxes.find((b) => b.path.toUpperCase() === 'INBOX')
    if (!inbox) throw new Error('INBOX が見つかりません')

    // INBOX を選択したままにしておくと imapflow が自動で IDLE に入る
    await client.mailboxOpen(inbox.path)
    await requeueStale(this.sql, this.account.id)
    this.work = {
      sync: () => syncMailbox(this.sql, client, this.account.id, inbox, this.log),
      ops: () => runQueuedOperations(this.sql, client, this.account, boxes, this.log),
    }
    const trigger = () => this.scheduleSync()
    client.on('exists', trigger)
    client.on('expunge', trigger)
    client.on('flags', trigger)
    const timer = setInterval(trigger, RESYNC_INTERVAL_MS)

    try {
      this.needSync = true
      this.needOps = true
      this.kick()
      await closed
    } finally {
      clearInterval(timer)
      if (this.debounce) clearTimeout(this.debounce)
      this.work = null
      this.client = null
    }
  }

  // IDLE の通知は連続して来るので少し待ってまとめる
  private scheduleSync() {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.needSync = true
      this.kick()
    }, DEBOUNCE_MS)
  }

  // 溜まっている仕事を 1 本ずつ流す。実行中に来た要求はフラグに残り、同じループで拾われる
  private kick() {
    if (this.draining || !this.work) return
    const work = this.work
    this.draining = (async () => {
      while (this.work === work && (this.needOps || this.needSync)) {
        // 操作を先に。ユーザーが待っているのはこちら
        if (this.needOps) {
          this.needOps = false
          await work.ops().catch((err: Error) => this.log(`操作の実行に失敗: ${err.message}`))
        } else {
          this.needSync = false
          await work.sync().catch((err: Error) => this.log(`同期失敗: ${err.message}`))
        }
      }
    })().finally(() => {
      this.draining = null
      // 再接続で work が差し替わっている間に積まれた分を、新しい接続で拾う
      if (this.work && (this.needOps || this.needSync)) this.kick()
    })
  }
}
