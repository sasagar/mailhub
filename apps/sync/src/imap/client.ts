import { ImapFlow } from 'imapflow'
import type { Account } from '../accounts.ts'

export function createImapClient(account: Pick<Account, 'imapHost' | 'imapPort' | 'username' | 'password'>): ImapFlow {
  return new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.username, pass: account.password },
    logger: false,
  })
}
