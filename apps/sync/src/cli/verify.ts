// DB の INBOX がサーバーと UID 単位で一致しているかを確かめる（読み取り専用）
import { createSql } from '@mailhub/db'
import { loadAccounts } from '../accounts.ts'
import { loadConfig } from '../config.ts'
import { imapClientFor } from '../imap/client.ts'

const config = loadConfig()
const sql = createSql(config.databaseUrl, { max: 1 })
let mismatch = false
try {
  for (const account of await loadAccounts(sql, config.masterKey)) {
    const client = await imapClientFor(account)
    await client.connect()
    try {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true })
      const server = new Set((await client.search({ all: true }, { uid: true })) || [])
      lock.release()
      const rows = await sql`
        select m.uid from messages m join mailboxes b on b.id = m.mailbox_id
        where b.account_id = ${account.id} and b.role = 'inbox'`
      const db = new Set(rows.map((r) => Number(r.uid)))
      const onlyServer = [...server].filter((u) => !db.has(u))
      const onlyDb = [...db].filter((u) => !server.has(u))
      if (onlyServer.length || onlyDb.length) mismatch = true
      console.log(`${account.email}: サーバー ${server.size} / DB ${db.size}`, { onlyServer, onlyDb })
    } finally {
      await client.logout()
    }
  }
} finally {
  await sql.end()
}
process.exit(mismatch ? 1 : 0)
