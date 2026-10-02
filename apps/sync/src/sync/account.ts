import type { ImapFlow } from 'imapflow'
import type { Sql } from '@mailhub/db'
import type { Account } from '../accounts.ts'
import { imapClientFor } from '../imap/client.ts'
import { inboxFolder, junkFolder, refreshMailboxes } from '../imap/mailboxes.ts'
import { syncMailbox } from './mailbox.ts'
import { requeueStale, runQueuedOperations } from './operations.ts'

// IDLE の通知を取りこぼしても、この間隔で必ず差分を取り直す（Spark で起きた取りこぼし対策）
const RESYNC_INTERVAL_MS = 5 * 60_000
const DEBOUNCE_MS = 1_500
const MAX_BACKOFF_MS = 5 * 60_000

// 1 アカウント分の常駐同期。INBOX は IDLE で見張り、迷惑メールフォルダは定期的に（と操作の後に）取り直す。
// IMAP のコマンドは 1 本の接続で重ねられないので、同期と操作キューの実行は drain() で 1 本ずつ流す
export class AccountSync {
  private client: ImapFlow | null = null
  private stopped = false
  private draining: Promise<void> | null = null
  private needSync = false
  private needOps = false
  private needJunk = false
  private debounce: NodeJS.Timeout | null = null
  private work: { sync: () => Promise<void>; ops: () => Promise<boolean>; junk: () => Promise<void> } | null = null

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
    const inbox = inboxFolder(boxes)
    if (!inbox) throw new Error('INBOX が見つかりません')
    const junk = junkFolder(boxes)
    // 迷惑メールフォルダの同期や「迷惑メールではない」の移動で別のフォルダを選んだら、受信トレイに戻して IDLE を続ける
    const backToInbox = async () => {
      if (client.mailbox === false || client.mailbox.path !== inbox.path) await client.mailboxOpen(inbox.path)
    }

    // INBOX を選択したままにしておくと imapflow が自動で IDLE に入る
    await client.mailboxOpen(inbox.path)
    await requeueStale(this.sql, this.account.id)
    this.work = {
      sync: () => syncMailbox(this.sql, client, this.account.id, inbox, this.log),
      ops: async () => {
        try {
          const touched = await runQueuedOperations(this.sql, client, this.account, boxes, this.log)
          // 迷惑メールにした・戻したものを迷惑メールフォルダの一覧にもすぐ反映する
          if (touched && junk) this.needJunk = true
          return touched
        } finally {
          await backToInbox()
        }
      },
      junk: async () => {
        if (!junk) return
        try {
          await client.mailboxOpen(junk.path)
          await syncMailbox(this.sql, client, this.account.id, junk, this.log)
        } finally {
          await backToInbox()
        }
      },
    }
    const trigger = () => this.scheduleSync()
    client.on('exists', trigger)
    client.on('expunge', trigger)
    client.on('flags', trigger)
    const timer = setInterval(() => {
      this.needJunk = true
      trigger()
    }, RESYNC_INTERVAL_MS)

    try {
      this.needSync = true
      this.needOps = true
      this.needJunk = true
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
      while (this.work === work && (this.needOps || this.needSync || this.needJunk)) {
        // 操作を先に。ユーザーが待っているのはこちら。迷惑メールフォルダは最後
        if (this.needOps) {
          this.needOps = false
          await work.ops().catch((err: Error) => this.log(`操作の実行に失敗: ${err.message}`))
        } else if (this.needSync) {
          this.needSync = false
          await work.sync().catch((err: Error) => this.log(`同期失敗: ${err.message}`))
        } else {
          this.needJunk = false
          await work.junk().catch((err: Error) => this.log(`迷惑メールの同期失敗: ${err.message}`))
        }
      }
    })().finally(() => {
      this.draining = null
      // 再接続で work が差し替わっている間に積まれた分を、新しい接続で拾う
      if (this.work && (this.needOps || this.needSync || this.needJunk)) this.kick()
    })
  }
}
