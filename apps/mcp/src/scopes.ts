// トークンごとの権限。同意画面でユーザーが選び、アクセストークンに焼き込まれる
export const SCOPES = {
  'mail.read': { label: '読み取り', description: '受信トレイの一覧・集計を見る', required: true, available: true },
  'mail.triage': { label: '整理', description: '既読にする・アーカイブする', required: false, available: true },
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
}
