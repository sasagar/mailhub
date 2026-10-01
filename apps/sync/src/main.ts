import { createSql } from '@mailhub/db'
import { migrate } from '@mailhub/db/migrate'
import { loadAccounts } from './accounts.ts'
import { loadConfig } from './config.ts'
import { runRequest } from './requests.ts'
import { runSearchRequest } from './search.ts'
import { AccountSync } from './sync/account.ts'

const config = loadConfig()
const sql = createSql(config.databaseUrl)
await migrate(sql)

const accounts = await loadAccounts(sql, config.masterKey)
if (accounts.length === 0) console.log('有効なアカウントがありません。pnpm account:add で追加してください')

const workers = accounts.map((a) => new AccountSync(sql, a))
const runs = workers.map((w) => w.run())

// operations に行が入るとトリガーが NOTIFY する（payload はアカウント ID）
await sql.listen('mailhub_operations', (payload) => {
  workers.find((w) => w.accountId === Number(payload))?.notifyOperations()
})

// 検索の依頼（payload は依頼の ID）。サーバーに負担をかけないよう 1 件ずつ順に流す
const log = (msg: string) => console.log(`${new Date().toLocaleTimeString('ja-JP', { hour12: false })} ${msg}`)
let searches = Promise.resolve()
const enqueueSearch = (id: string) => {
  searches = searches
    .then(() => runSearchRequest(sql, accounts, id, log))
    .catch((err: Error) => log(`検索失敗: ${err.message}`))
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
await sql.listen('mailhub_requests', (payload) => enqueueRequest(payload))

const shutdown = async () => {
  console.log('停止中…')
  await Promise.all(workers.map((w) => w.stop()))
  await Promise.allSettled(runs)
  await sql.end()
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
