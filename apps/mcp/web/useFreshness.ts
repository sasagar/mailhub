import { useCallback, useEffect, useState } from 'react'

// 本番では index.html が読み込むスクリプトのファイル名にハッシュが入る（/assets/index-xxxx.js）。
// サーバーの index.html と見比べて、新しい版が出ているかを知る（開発サーバーでは比べない）
const currentScript = () =>
  document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? null

async function hasNewVersion(): Promise<boolean> {
  const mine = currentScript()
  if (!mine) return false
  try {
    const html = await (await fetch('/app/', { cache: 'no-store' })).text()
    const latest = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/.exec(html)?.[1]
    return latest != null && latest !== mine
  } catch {
    return false
  }
}

// iPhone のホーム画面の PWA には再読み込みの手段が無く、閉じても前の画面のまま再開される。
// 前面に戻ったときと更新ボタンで、データを読み直して新しい版を確かめる
export function useFreshness(reload: () => void) {
  const [updateReady, setUpdateReady] = useState(false)

  const refresh = useCallback(() => {
    reload()
    void hasNewVersion().then((v) => v && setUpdateReady(true))
  }, [reload])

  useEffect(() => {
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now()
      // 一瞬切り替えただけなら読み直さない
      else if (Date.now() - hiddenAt > 15_000) refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [refresh])

  return { refresh, updateReady, applyUpdate: () => location.reload() }
}
