// 受信トレイから条件に合うものを一括アーカイブする（操作キューに積むだけ。実行は同期デーモン）
//   pnpm archive --from store-news@amazon.co.jp          # 対象を表示するだけ
//   pnpm archive --from store-news@amazon.co.jp --yes    # 積む
//   pnpm archive --from ... --mark-read --yes             # 既読にしてからアーカイブ
import { parseArgs } from 'node:util'
import { createSql } from '@mailhub/db'
import { loadConfig } from '../config.ts'

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    account: { type: 'string' },
    'mark-read': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
})
if (!values.from) {
  console.error('--from <差出人アドレス> を指定してください')
  process.exit(2)
}

const config = loadConfig()
const sql = createSql(config.databaseUrl, { max: 1 })
try {
  const rows = await sql`
    select m.account_id, m.mailbox_id, m.uid, m.subject, m.received_at, a.email
    from messages m
    join mailboxes b on b.id = m.mailbox_id and b.role = 'inbox'
    join accounts a on a.id = m.account_id
    where lower(m.from_addr -> 0 ->> 'address') = lower(${values.from})
      ${values.account ? sql`and a.email = ${values.account}` : sql``}
    order by m.received_at desc`
  for (const r of rows.slice(0, 10))
    console.log(`  ${r.received_at?.toISOString().slice(0, 10)} ${r.email} ${r.subject}`)
  if (rows.length > 10) console.log(`  …ほか ${rows.length - 10} 通`)
  console.log(`対象 ${rows.length} 通${values['mark-read'] ? '（既読にしてからアーカイブ）' : ''}`)

  if (!values.yes || rows.length === 0) {
    if (rows.length > 0) console.log('積むには --yes を付けて再実行')
  } else {
    // フォルダごとに 1 操作（= IMAP の MOVE 1 回）
    const groups = Map.groupBy(rows, (r) => `${r.account_id}:${r.mailbox_id}`)
    for (const list of groups.values()) {
      const [op] = await sql`
        insert into operations (account_id, mailbox_id, kind, uids, params, requested_by)
        values (${list[0]!.account_id}, ${list[0]!.mailbox_id}, 'archive', ${list.map((r) => r.uid)}::bigint[],
          ${sql.json({ markSeen: values['mark-read'] })}, 'cli')
        returning id`
      console.log(`操作 #${op!.id} を積みました（${list.length} 通）`)
    }
  }
} finally {
  await sql.end()
}
