import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { createSql } from '@mailhub/db'
import { PRESETS, type Provider } from '../accounts.ts'
import { loadConfig } from '../config.ts'
import { encryptSecret } from '../crypto.ts'
import { createImapClient } from '../imap/client.ts'

const config = loadConfig()
const rl = createInterface({ input: stdin, output: stdout })

const ask = async (q: string, def?: string) =>
  (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def || ''

// 入力を画面に出さない（アプリパスワード用）
async function askSecret(q: string): Promise<string> {
  const out = rl as unknown as { _writeToOutput: (s: string) => void }
  const original = out._writeToOutput
  out._writeToOutput = (s) => {
    if (s.startsWith(q)) original.call(rl, s)
  }
  try {
    return (await rl.question(q)).trim()
  } finally {
    out._writeToOutput = original
    stdout.write('\n')
  }
}

const email = await ask('メールアドレス')
const provider = (await ask(
  '種類 gmail / icloud / generic',
  email.endsWith('@gmail.com') ? 'gmail' : 'generic',
)) as Provider
const preset = provider === 'generic' ? undefined : PRESETS[provider]
const label = await ask('表示名（送信するときの差出人名になります）', email)
const imapHost = await ask('IMAP ホスト', preset?.imapHost)
const imapPort = Number(await ask('IMAP ポート', String(preset?.imapPort ?? 993)))
const smtpHost = await ask('SMTP ホスト', preset?.smtpHost)
const smtpPort = Number(await ask('SMTP ポート', String(preset?.smtpPort ?? 465)))
const username = await ask('ユーザー名', email)
const password = await askSecret('アプリパスワード: ')
rl.close()

// 保存前に本当に繋がるか確かめる
const client = createImapClient({ imapHost, imapPort, username }, { pass: password })
await client.connect()
await client.logout()
console.log('IMAP ログイン成功')

const sql = createSql(config.databaseUrl, { max: 1 })
try {
  await sql`
    insert into accounts ${sql({
      label,
      email,
      provider,
      imap_host: imapHost,
      imap_port: imapPort,
      smtp_host: smtpHost || null,
      smtp_port: smtpHost ? smtpPort : null,
      username,
      secret: encryptSecret(password, config.masterKey),
    })}`
  console.log(`${email} を追加しました`)
} finally {
  await sql.end()
}
