import { setDefaultResultOrder } from 'node:dns'
import { ImapFlow } from 'imapflow'
import type { Account } from '../accounts.ts'
import { accessTokenFor, loadGoogleClient } from '../google.ts'

// Gmail への IPv6 の経路が不安定なことがあり、接続に 20 秒以上かかった（IPv4 なら 2 秒前後）。IPv4 を優先する
setDefaultResultOrder('ipv4first')

type Target = Pick<Account, 'imapHost' | 'imapPort' | 'username'>
type Credential = { pass: string } | { accessToken: string }

// imapflow は MOVE などが失敗しても例外にせず false を返し、理由はロガーに warn で出すだけ。
// ロガーを切っていると理由が分からないので、最後の warn / error をクライアントごとに覚えておく
const lastErrors = new WeakMap<ImapFlow, string>()

export function lastImapError(client: ImapFlow): string | undefined {
  return lastErrors.get(client)
}

export function createImapClient(target: Target, credential: Credential): ImapFlow {
  let client: ImapFlow | undefined
  const remember = (entry: {
    err?: { message?: string; response?: string; serverResponseCode?: string }
    msg?: string
  }) => {
    if (!client) return
    const err = entry.err
    const text = [err?.serverResponseCode, err?.response || err?.message || entry.msg].filter(Boolean).join(' ')
    if (text) lastErrors.set(client, text)
  }
  const noop = () => {}
  client = new ImapFlow({
    host: target.imapHost,
    port: target.imapPort,
    secure: true,
    auth: { user: target.username, ...credential },
    logger: { debug: noop, info: noop, warn: remember, error: remember },
  })
  return client
}

// アカウントの認証方式に合わせて接続情報を用意する。OAuth は接続のたびにアクセストークンを取り直す
export async function imapClientFor(account: Account): Promise<ImapFlow> {
  if (account.authType === 'password') return createImapClient(account, { pass: account.secret })
  const google = loadGoogleClient()
  if (!google) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です')
  return createImapClient(account, { accessToken: await accessTokenFor(google, account.secret) })
}
