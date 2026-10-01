import { setDefaultResultOrder } from 'node:dns'
import { ImapFlow } from 'imapflow'
import type { Account } from '../accounts.ts'
import { accessTokenFor, loadGoogleClient } from '../google.ts'

// Gmail への IPv6 の経路が不安定なことがあり、接続に 20 秒以上かかった（IPv4 なら 2 秒前後）。IPv4 を優先する
setDefaultResultOrder('ipv4first')

type Target = Pick<Account, 'imapHost' | 'imapPort' | 'username'>
type Credential = { pass: string } | { accessToken: string }

export function createImapClient(target: Target, credential: Credential): ImapFlow {
  return new ImapFlow({
    host: target.imapHost,
    port: target.imapPort,
    secure: true,
    auth: { user: target.username, ...credential },
    logger: false,
  })
}

// アカウントの認証方式に合わせて接続情報を用意する。OAuth は接続のたびにアクセストークンを取り直す
export async function imapClientFor(account: Account): Promise<ImapFlow> {
  if (account.authType === 'password') return createImapClient(account, { pass: account.secret })
  const google = loadGoogleClient()
  if (!google) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です')
  return createImapClient(account, { accessToken: await accessTokenFor(google, account.secret) })
}
