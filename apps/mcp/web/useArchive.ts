import { useCallback, useState } from 'react'
import { api } from './auth.ts'
import type { Operation, Queued } from './types.ts'

export type Toast = { id: number; text: string; tone: 'done' | 'error' }

// アーカイブを積み、同期デーモンが IMAP で実行し終えるまで待つ。完了したら onDone を呼ぶ
export function useArchive(onDone: () => void) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const notify = useCallback((text: string, tone: Toast['tone']) => {
    const id = Date.now() + Math.random()
    setToasts((list) => [...list, { id, text, tone }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 6000)
  }, [])

  const archive = useCallback(
    async (body: Record<string, unknown>, label: string) => {
      try {
        const queued = await api<Queued>('/mcp/api/archive', { method: 'POST', body: JSON.stringify(body) })
        const ids = queued.operations.map((o) => o.operationId)
        if (ids.length === 0) {
          notify(`${label}は、もう受信トレイにありません`, 'done')
          onDone()
          return
        }
        // 実行は同期デーモン。だいたい数秒〜数十秒で終わる
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          const ops = await api<Operation[]>(`/mcp/api/operations?ids=${ids.join(',')}`)
          if (ops.every((o) => o.status === 'done' || o.status === 'failed')) {
            const failed = ops.filter((o) => o.status === 'failed')
            const moved = ops.reduce((sum, o) => sum + (o.result?.moved ?? 0), 0)
            if (failed.length > 0) notify(`${label}のアーカイブに失敗しました: ${failed[0]!.error}`, 'error')
            else notify(`${label}の ${moved} 通をアーカイブしました`, 'done')
            onDone()
            return
          }
        }
        notify(`${label}のアーカイブがまだ終わっていません。少し待ってから更新してください`, 'error')
      } catch (err) {
        notify(`${label}のアーカイブを頼めませんでした: ${(err as Error).message}`, 'error')
      }
    },
    [notify, onDone],
  )

  return { archive, toasts }
}
