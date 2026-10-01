export type Account = { account: string; label: string; total: number; unread: number; syncedAt: string | null }
export type Overview = { me: { email: string; scopes: string[] }; accounts: Account[] }
export type Sender = { address: string; name: string | null; total: number; unread: number; latest: string | null }
export type Message = {
  id: string
  account: string
  from: { name: string | null; address: string | null } | null
  subject: string | null
  receivedAt: string | null
  unread: boolean
}
export type MessagePage = { total: number; offset: number; messages: Message[] }
export type Queued = { operations: { operationId: string; account: string; count: number }[]; notFound: string[] }
export type Operation = {
  operationId: string
  status: 'queued' | 'running' | 'done' | 'failed'
  count: number
  result: { moved?: number } | null
  error: string | null
}
export type SearchHit = {
  account: string
  mailbox: string
  uid: number
  subject: string | null
  from: { name: string | null; address: string | null } | null
  receivedAt: string | null
  unread: boolean
  inInbox: boolean
  messageId: string | null
  gmThreadId: string | null
}
export type SearchResult = {
  hits: SearchHit[]
  totals: { account: string; matched: number | null; error: string | null }[]
}
export type Addr = { name: string | null; address: string | null }
export type MessageRef = { id: string } | { account: string; mailbox: string; uid: number }
export type MessageBody = {
  account: string
  mailbox: string
  uid: number
  messageId: string | null
  unread: boolean | null
  headers: {
    subject: string | null
    from: Addr | null
    to: Addr[]
    cc: Addr[]
    replyTo: Addr[]
    date: string | null
    messageId: string | null
    inReplyTo: string | null
    references: string | null
  }
  text: string
  html: string | null
  attachments: { index: number; filename: string; mimeType: string; size: number }[]
}
