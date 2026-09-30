import { createSql } from '@mailhub/db'
import { migrate } from '@mailhub/db/migrate'

const sql = createSql(process.env.DATABASE_URL, { max: 1 })
try {
  await migrate(sql)
} finally {
  await sql.end()
}
