import { readdir, readFile } from 'node:fs/promises'
import type { Sql } from './index.ts'

const dir = new URL('../migrations/', import.meta.url)

// migrations/*.sql をファイル名順に 1 回ずつ適用する（Node 専用）
export async function migrate(sql: Sql): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`
  const applied = new Set((await sql`select name from schema_migrations`).map((r) => r.name as string))
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    if (applied.has(file)) continue
    const body = await readFile(new URL(file, dir), 'utf8')
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx.unsafe('insert into schema_migrations (name) values ($1)', [file])
    })
    console.log(`migrated ${file}`)
  }
}
