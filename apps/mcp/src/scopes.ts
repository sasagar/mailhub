// トークンごとの権限。同意画面でユーザーが選び、アクセストークンに焼き込まれる
export const SCOPES = {
  'mail.read': { label: '読み取り', description: '受信トレイの一覧・集計を見る', required: true, available: true },
  'mail.triage': {
    label: '整理',
    description: '既読にする・アーカイブする・迷惑メールに移す・下書きを作る',
    required: false,
    available: true,
  },
  // 下書きの作成・変更・削除だけ（エージェントが作った下書きに限る）。無人で動く常駐エージェント向けに、整理より狭くしたもの
  'mail.draft': {
    label: '下書き',
    description: '返信などの下書きを作る（送信はしない）',
    required: false,
    available: true,
  },
  // 送信は mailhub の Web 画面（戻り先が /app/）にだけ許す。エージェントは下書きまで（handler.ts で確かめる）
  'mail.send': {
    label: '送信',
    description: '下書きを送る（mailhub の Web 画面だけ）',
    required: false,
    available: true,
  },
} as const

export type Scope = keyof typeof SCOPES

export const ALL_SCOPES = Object.keys(SCOPES) as Scope[]

export const isScope = (s: string): s is Scope => s in SCOPES

// アクセストークンの props。apiHandler では ctx.props で受け取る
export type Props = {
  email: string
  scopes: Scope[]
  clientName: string
  // 登録された client_id。クライアント名は登録時に自由に名乗れるので、記録にはこちらも残す
  clientId?: string
}

// 操作の記録（requested_by / created_by）に残す依頼元。種類（mcp / web）・名乗った名前・client_id
export const requester = (kind: 'mcp' | 'web', props: Props) =>
  `${kind}:${props.clientName}${props.clientId ? `#${props.clientId}` : ''}`

// 許可したアドレスか（ALLOWED_EMAILS、カンマ区切り。空なら誰も通さない）
export function isAllowedEmail(allowedList: string, email: string | undefined): boolean {
  const allowed = allowedList
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return !!email && allowed.includes(email.toLowerCase())
}
