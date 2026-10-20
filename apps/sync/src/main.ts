import { createSql } from '@mailhub/db'
import { migrate } from '@mailhub/db/migrate'
import { loadAccounts } from './accounts.ts'
import { loadConfig } from './config.ts'
import { purgeExpired } from './cleanup.ts'
import { runRequest } from './requests.ts'
import { runSearchRequest } from './search.ts'
import { AccountSync } from './sync/account.ts'

const config = loadConfig()
const sql = createSql(config.databaseUrl)
// 本番は k3s の init コンテナが所有者のロールで先に流す（MAILHUB_MIGRATE=0）。手元の開発ではここで流す
if (process.env.MAILHUB_MIGRATE !== '0') await migrate(sql)

const accounts = await loadAccounts(sql, config.masterKey)
if (accounts.length === 0) console.log('有効なアカウントがありません。pnpm account:add で追加してください')

const workers = accounts.map((a) => new AccountSync(sql, a))
const runs = workers.map((w) => w.run())

// operations に行が入るとトリガーが NOTIFY する（payload はアカウント ID）
await sql.listen('mailhub_operations', (payload) => {
  workers.find((w) => w.accountId === Number(payload))?.notifyOperations()
})

// 検索の依頼（payload は依頼の ID）。すぐに始める。アカウントごとの補助の接続が 1 件ずつ順に流すので、
// メールサーバーへの負担は増えない（全体を 1 列にすると、遅い検索 1 つで後ろが全部待たされる）
const log = (msg: string) => console.log(`${new Date().toLocaleTimeString('ja-JP', { hour12: false })} ${msg}`)
const enqueueSearch = (id: string) => {
  runSearchRequest(sql, accounts, id, log).catch((err: Error) => log(`検索失敗: ${err.message}`))
}
// 止まっている間に積まれた依頼は、頼んだ側がもう待っていないので失敗にする
await sql`update search_requests set status = 'failed', error = '同期デーモンが止まっていました', finished_at = now()
  where status in ('queued', 'running')`
await sql.listen('mailhub_search', (payload) => enqueueSearch(payload))

// 本文の取得などの依頼（payload は依頼の ID）。開いた人が待っているので検索とは別の列で流す
let requests = Promise.resolve()
const enqueueRequest = (id: string) => {
  requests = requests
    .then(() => runRequest(sql, accounts, id, log))
    .catch((err: Error) => log(`依頼失敗: ${err.message}`))
}
await sql`update requests set status = 'failed', error = '同期デーモンが止まっていました', finished_at = now()
  where status in ('queued', 'running')`
// 送信待ちのまま止まった下書きは、もう一度送れるように失敗にする
await sql`update drafts set status = 'failed', error = '同期デーモンが止まっていたため送信していません'
  where status = 'queued'`
await sql.listen('mailhub_requests', (payload) => enqueueRequest(payload))

// 期限を過ぎた一時データを、起動時と 10 分ごとに消す
const purge = () => purgeExpired(sql).catch((err: Error) => log(`一時データの掃除に失敗: ${err.message}`))
await purge()
const purgeTimer = setInterval(() => void purge(), 10 * 60_000)

const shutdown = async () => {
  clearInterval(purgeTimer)
  console.log('停止中…')
  await Promise.all(workers.map((w) => w.stop()))
  await Promise.allSettled(runs)
  await sql.end()
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
