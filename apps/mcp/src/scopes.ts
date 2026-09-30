// トークンごとの権限。同意画面でユーザーが選び、アクセストークンに焼き込まれる
export const SCOPES = {
  'mail.read': { label: '読み取り', description: '受信トレイの一覧・集計を見る', required: true, available: true },
  'mail.triage': { label: '整理', description: '既読にする・アーカイブする', required: false, available: true },
  'mail.send': { label: '送信', description: 'メールを送る（未実装）', required: false, available: false },
} as const

export type Scope = keyof typeof SCOPES

export const ALL_SCOPES = Object.keys(SCOPES) as Scope[]

export const isScope = (s: string): s is Scope => s in SCOPES

// アクセストークンの props。apiHandler では ctx.props で受け取る
export type Props = {
  email: string
  scopes: Scope[]
  clientName: string
}
