import { useCallback, useEffect, useState } from 'react'
import { api } from './auth.ts'
import type { Operation, Queued } from './types.ts'

// アーカイブ 1 件の進み具合。画面下の進行状況の欄に出す
export type Job = {
  id: number
  label: string
  phase: 'sending' | 'queued' | 'running' | 'done' | 'failed'
  startedAt: number
  count?: number
  error?: string
}

export const PHASE_LABEL: Record<Job['phase'], string> = {
  sending: '依頼中',
  queued: '順番待ち',
  running: 'メールサーバーで移動中',
  done: '完了',
  failed: '失敗',
}

const DONE_VISIBLE_MS = 5000

// アーカイブを積み、同期デーモンが IMAP で実行し終えるまで追いかける。完了したら onDone を呼ぶ
export function useArchive(onDone: () => void) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [now, setNow] = useState(Date.now())

  // 経過秒数の表示用。動いている仕事があるときだけ時計を回す
  const active = jobs.some((j) => j.phase !== 'done' && j.phase !== 'failed')
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [active])

  const update = useCallback((id: number, patch: Partial<Job>) => {
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...patch } : j)))
    if (patch.phase === 'done') {
      setTimeout(() => setJobs((list) => list.filter((j) => j.id !== id)), DONE_VISIBLE_MS)
    }
  }, [])

  const dismiss = useCallback((id: number) => setJobs((list) => list.filter((j) => j.id !== id)), [])

  const archive = useCallback(
    // path を変えると迷惑メールの削除（/mcp/api/delete-junk）も同じ進行状況の欄で追える
    async (body: Record<string, unknown>, label: string, path = '/mcp/api/archive') => {
      const id = Date.now() + Math.random()
      setNow(Date.now())
      setJobs((list) => [...list, { id, label, phase: 'sending', startedAt: Date.now() }])
      try {
        const queued = await api<Queued>(path, { method: 'POST', body: JSON.stringify(body) })
        const ids = queued.operations.map((o) => o.operationId)
        if (ids.length === 0) {
          update(id, { phase: 'done', count: 0 })
          onDone()
          return
        }
        update(id, { phase: 'queued', count: queued.operations.reduce((s, o) => s + o.count, 0) })
        // 実行は同期デーモン。だいたい数秒〜数十秒で終わる
        for (let i = 0; i < 180; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          const ops = await api<Operation[]>(`/mcp/api/operations?ids=${ids.join(',')}`)
          if (ops.some((o) => o.status === 'running')) update(id, { phase: 'running' })
          if (ops.every((o) => o.status === 'done' || o.status === 'failed')) {
            const failed = ops.find((o) => o.status === 'failed')
            if (failed) update(id, { phase: 'failed', error: failed.error ?? '理由不明' })
            else
              update(id, {
                phase: 'done',
                count: ops.reduce((s, o) => s + (o.result?.moved ?? o.result?.deleted ?? 0), 0),
              })
            onDone()
            return
          }
        }
        update(id, { phase: 'failed', error: '3 分たっても終わりませんでした。少し待ってから更新してください' })
      } catch (err) {
        update(id, { phase: 'failed', error: (err as Error).message })
      }
    },
    [onDone, update],
  )

  return { archive, jobs, now, dismiss }
}
