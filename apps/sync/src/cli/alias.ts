// 送信に使うエイリアスの一覧・追加・削除
//   pnpm alias                                                       # 一覧
//   pnpm alias --account boku@bktsk.com --add hacosha@bktsk.com --name "hacoSHA! FanSite"
//   pnpm alias --remove hacosha@bktsk.com
import { parseArgs } from 'node:util'
import { createSql } from '@mailhub/db'
import { loadConfig } from '../config.ts'

const { values } = parseArgs({
  options: {
    account: { type: 'string' },
    add: { type: 'string' },
    name: { type: 'string' },
    remove: { type: 'string' },
  },
})
const config = loadConfig()
const sql = createSql(config.databaseUrl, { max: 1 })
try {
  if (values.add) {
    const address = values.add.trim().toLowerCase()
    if (!values.account || !values.name) throw new Error('--add には --account と --name も指定してください')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error(`アドレスの形式が正しくありません: ${address}`)
    const [a] = await sql`select id from accounts where email = ${values.account.toLowerCase()}`
    if (!a) throw new Error(`アカウント ${values.account} はありません`)
    await sql`
      insert into aliases (account_id, address, from_name) values (${a.id}, ${address}, ${values.name})
      on conflict (address) do update set account_id = excluded.account_id, from_name = excluded.from_name`
    console.log(`${address}（${values.name}）を ${values.account} のエイリアスにしました`)
  } else if (values.remove) {
    const rows = await sql`delete from aliases where address = ${values.remove.trim().toLowerCase()} returning address`
    console.log(rows.length ? `${values.remove} を消しました` : `${values.remove} はありません`)
  }
  const rows = await sql`
    select a.email, l.address, l.from_name from aliases l join accounts a on a.id = l.account_id
    order by a.email, l.address`
  console.log(rows.length ? '\nアカウント | エイリアス | 差出人名' : '\nエイリアスはありません')
  for (const r of rows) console.log(`${r.email} | ${r.address} | ${r.from_name}`)
} finally {
  await sql.end()
}
