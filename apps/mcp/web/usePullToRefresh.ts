import { useEffect, useRef, useState } from 'react'

const THRESHOLD = 70 // これより引いて離すと更新する（px）
const MAX = 110

// ページの先頭で下に引くと更新する。PWA には再読み込みの手段が無いので、スマホの作法に合わせて用意する
export function usePullToRefresh(onRefresh: () => Promise<void> | void) {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  const pullRef = useRef(0)
  const busy = useRef(false)

  useEffect(() => {
    const set = (v: number) => {
      pullRef.current = v
      setPull(v)
    }
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0]
      const target = e.target as HTMLElement | null
      // 先頭にいるとき、入力欄や下のバー以外で始めた 1 本指の操作だけを見る
      if (busy.current || window.scrollY > 0 || e.touches.length !== 1 || !t) return
      if (target?.closest('input, textarea, select, .selection-bar, .activity')) return
      start.current = { x: t.clientX, y: t.clientY }
    }
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!start.current || !t) return
      const dy = t.clientY - start.current.y
      const dx = Math.abs(t.clientX - start.current.x)
      // 横の操作や上方向は引っ張りとみなさない
      if (dy <= 0 || dx > dy) {
        if (pullRef.current) set(0)
        return
      }
      // 引くほど重くなるようにする
      set(Math.min(MAX, dy * 0.5))
      if (e.cancelable) e.preventDefault()
    }
    const onEnd = async () => {
      if (!start.current) return
      start.current = null
      if (pullRef.current < THRESHOLD) {
        set(0)
        return
      }
      busy.current = true
      setRefreshing(true)
      set(THRESHOLD * 0.7)
      try {
        await Promise.all([onRefresh(), new Promise((r) => setTimeout(r, 700))])
      } finally {
        busy.current = false
        setRefreshing(false)
        set(0)
      }
    }
    window.addEventListener('touchstart', onStart, { passive: true })
    // preventDefault するので passive にしない
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onEnd)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [onRefresh])

  return { pull, ready: pull >= THRESHOLD, refreshing }
}
