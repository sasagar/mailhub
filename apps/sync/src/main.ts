import { createSql } from '@mailhub/db'
import { migrate } from '@mailhub/db/migrate'
import { loadAccounts } from './accounts.ts'
import { loadConfig } from './config.ts'
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

const shutdown = async () => {
  console.log('停止中…')
  await Promise.all(workers.map((w) => w.stop()))
  await Promise.allSettled(runs)
  await sql.end()
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
