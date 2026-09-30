// フォルダの同期方針を決める純粋関数。IMAP にも DB にも触らないのでテストしやすい。

export type StoredState = {
  uidValidity: bigint
  uidNext: number
  highestModseq: bigint | null
}

export type ServerState = {
  uidValidity: bigint
  uidNext: number
  highestModseq: bigint | null
  // サーバーが CONDSTORE に対応しているか（highestModseq が取れるなら true）
  condstore: boolean
}

export type FlagSync =
  | { mode: 'changedSince'; modseq: bigint } // modseq 以降に変わったものだけ取る
  | { mode: 'all' } // 全件のフラグを取り直す
  | { mode: 'none' } // 変化なし

export type SyncPlan =
  | { kind: 'full' } // DB のこのフォルダを捨てて全件取り込み直す
  | {
      kind: 'incremental'
      fetchNewFrom: number | null // この UID 以降を新着として取る。null は新着なし
      flags: FlagSync
    }

// stored: 前回同期時に DB に保存したサーバー状態。null は初回
// server: 今 SELECT した時点のサーバー状態
//
// 迷ったら取り直す側に倒す。余分な取得は 1 回で済むが、取りこぼしは後から気付けない。
export function planMailboxSync(stored: StoredState | null, server: ServerState): SyncPlan {
  // UIDVALIDITY が変わると同じ UID が別のメールを指すので、DB の中身は使えない。
  // UIDNEXT が戻るのも本来ありえないので、同じ扱いにする
  if (!stored || stored.uidValidity !== server.uidValidity || server.uidNext < stored.uidNext) {
    return { kind: 'full' }
  }

  const fetchNewFrom = server.uidNext > stored.uidNext ? stored.uidNext : null

  let flags: FlagSync
  if (!server.condstore || server.highestModseq == null) {
    flags = { mode: 'all' }
  } else if (stored.highestModseq == null || server.highestModseq < stored.highestModseq) {
    // 前回は CONDSTORE が無かった / MODSEQ が戻った: 差分の起点が無いので 1 回だけ全件
    flags = { mode: 'all' }
  } else if (server.highestModseq > stored.highestModseq) {
    flags = { mode: 'changedSince', modseq: stored.highestModseq }
  } else {
    flags = { mode: 'none' }
  }

  return { kind: 'incremental', fetchNewFrom, flags }
}
