// Gmail アカウントを OAuth で登録する（既にあればアプリパスワードから切り替える）。
//   pnpm google-auth --email you@gmail.com
// 表示された URL をどの端末のブラウザで開いてもよい。同意後に 127.0.0.1 へ戻される:
// - このコマンドと同じマシンのブラウザなら自動で受け取る
// - 別の端末なら「接続できません」のページになるので、そのアドレスバーの URL を貼り付ける
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { createSql } from '@mailhub/db'
import { PRESETS } from '../accounts.ts'
import { loadConfig } from '../config.ts'
import { encryptSecret } from '../crypto.ts'
import { authorizeUrl, exchangeCode, loadGoogleClient } from '../google.ts'
import { createImapClient } from '../imap/client.ts'

const PORT = 8765
const redirectUri = `http://127.0.0.1:${PORT}/`

const { values } = parseArgs({ options: { email: { type: 'string' }, label: { type: 'string' } } })
const email = values.email?.trim().toLowerCase()
if (!email) {
  console.error('--email <Gmail のアドレス> を指定してください')
  process.exit(2)
}
const config = loadConfig()
const google = loadGoogleClient()
if (!google) {
  console.error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です')
  process.exit(2)
}

const b64url = (b: Buffer) => b.toString('base64url')
const verifier = b64url(randomBytes(32))
const challenge = b64url(createHash('sha256').update(verifier).digest())
const state = b64url(randomBytes(16))

console.log(
  '\n次の URL をブラウザで開き、Google にログインして許可してください（「確認されていないアプリ」と出たら「詳細」→「移動」）:\n',
)
console.log(authorizeUrl(google, { redirectUri, codeChallenge: challenge, state, loginHint: email }))
console.log(
  `\n許可した後、このマシンのブラウザなら自動で続きます。別の端末なら、${redirectUri} から始まるアドレスをここに貼り付けてください。\n`,
)

// 戻りの URL（?code=…&state=…）からコードを取り出す
function codeFrom(url: URL): string {
  if (url.searchParams.get('error')) throw new Error(`Google で拒否されました: ${url.searchParams.get('error')}`)
  if (url.searchParams.get('state') !== state) throw new Error('state が一致しません。最初からやり直してください')
  const code = url.searchParams.get('code')
  if (!code) throw new Error('code がありません')
  return code
}

const code = await new Promise<string>((resolve, reject) => {
  const rl = createInterface({ input: stdin, output: stdout })
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    try {
      const c = codeFrom(new URL(req.url ?? '/', redirectUri))
      res.end('<h1>許可を受け取りました。このタブは閉じてかまいません。</h1>')
      finish(() => resolve(c))
    } catch (err) {
      res.end(`<h1>${(err as Error).message}</h1>`)
    }
  })
  const finish = (done: () => void) => {
    server.close()
    rl.close()
    done()
  }
  // Pod の中などでポートを開けなくても、貼り付けで続けられるようにする
  server.on('error', () => {})
  server.listen(PORT, '127.0.0.1')
  rl.question('戻りの URL> ')
    .then((line) => finish(() => resolve(codeFrom(new URL(line.trim())))))
    .catch((err: Error) => finish(() => reject(err)))
})

const tokens = await exchangeCode(google, { code, codeVerifier: verifier, redirectUri })
if (tokens.scope && !tokens.scope.split(' ').includes('https://mail.google.com/')) {
  throw new Error(`メールへのアクセスが許可されていません（scope: ${tokens.scope}）`)
}

// 同意した Google アカウントが --email と同じかは、IMAP にそのアドレスで入れるかで確かめる
const preset = PRESETS.gmail
const imap = createImapClient(
  { imapHost: preset.imapHost, imapPort: preset.imapPort, username: email },
  {
    accessToken: tokens.accessToken,
  },
)
try {
  await imap.connect()
  await imap.logout()
} catch (err) {
  throw new Error(
    `${email} で IMAP に入れませんでした。別の Google アカウントで許可していないか確かめてください（${(err as Error).message}）`,
  )
}
console.log('IMAP ログイン成功（OAuth）')

const sql = createSql(config.databaseUrl, { max: 1 })
try {
  const secret = encryptSecret(tokens.refreshToken, config.masterKey)
  const [row] = await sql`
    insert into accounts ${sql({
      label: values.label ?? email,
      email,
      provider: 'gmail',
      imap_host: preset.imapHost,
      imap_port: preset.imapPort,
      smtp_host: preset.smtpHost,
      smtp_port: preset.smtpPort,
      username: email,
      auth_type: 'oauth',
      secret,
    })}
    on conflict (email) do update set auth_type = 'oauth', secret = excluded.secret, username = excluded.username
    returning id, (xmax = 0) as inserted`
  console.log(`${email} を${row?.inserted ? '追加' : 'OAuth に切り替え'}ました。デーモンを再起動すると反映されます`)
} finally {
  await sql.end()
}
