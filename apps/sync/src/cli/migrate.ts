import { createSql } from '@mailhub/db'
import { migrate } from '@mailhub/db/migrate'
import { secret } from '../config.ts'

// 本番では k3s の init コンテナから、テーブルの所有者のロール（mailhub）で流す。
// 常駐するデーモンはデータの読み書きだけのロール（mailhub_app）で動き、テーブルを作り替えられない
const password = secret('PGPASSWORD')
if (password) process.env.PGPASSWORD = password
const sql = createSql(process.env.DATABASE_URL, { max: 1 })
try {
  await migrate(sql)
} finally {
  await sql.end()
}
