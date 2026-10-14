#!/bin/bash
# 残りのアカウントを本番（k3s の同期デーモン）に登録する。Google 系（Gmail / Google Workspace）は OAuth、
# iCloud と SoftBank はアプリパスワード。終わったら同期デーモンを再起動して反映する。
#
#   bash deploy/scripts/register-accounts.sh
#
# GOOGLE の各行は「メールアドレス|表示名|差出人名」。表示名は画面に出す短い名前、差出人名は送信時に相手に見える名前。
# 登録済みのものや後回しにするものは行を消す。失敗したアカウントは飛ばして次へ進むので、あとでその行だけ残して再実行する。
set -u
host="${KUBE_HOST:-samurai-watch}"

cli() {
  # 対話式なので ssh -t と exec -it で端末をつなぐ
  ssh -t "$host" "sudo k3s kubectl -n mailhub exec -it deploy/mailhub-sync -- node_modules/.bin/tsx src/cli/$1"
}

# アカウントの一覧は accounts.local から読む（個人のメールアドレスを公開リポジトリに置かない）。
# 見本は accounts.local.example
here=$(dirname "$0")
if [ ! -f "$here/accounts.local" ]; then
  echo "$here/accounts.local がありません。accounts.local.example をコピーして書き換えてください" >&2
  exit 1
fi
. "$here/accounts.local"

failed=''
IFS='
'
for line in $GOOGLE; do
  case "$line" in *'|'*) ;; *) continue ;; esac
  email=${line%%|*}
  rest=${line#*|}
  label=${rest%%|*}
  from=${rest#*|}
  printf '\n==== %s（表示名: %s ／ 差出人名: %s）====\n' "$email" "$label" "$from"
  printf 'URL をブラウザで開き、このアカウント（%s）を選んで許可してください。\n\n' "$email"
  if ! cli "google-auth.ts --email $email --label '$label' --from-name '$from'"; then
    failed="$failed $email"
    printf '\n!! %s は失敗しました。残りを続けます。\n' "$email"
  fi
done
unset IFS

for item in "${PASSWORD_ACCOUNTS[@]}"; do
  name=${item%%|*}; rest=${item#*|}; email=${rest%%|*}; hint=${rest#*|}
  printf '\n==== %s（%s）====\n%s\n\n' "$name" "$email" "$hint"
  cli add-account.ts || failed="$failed $email"
done

printf '\n==== 同期デーモンを再起動して反映します ====\n'
ssh "$host" 'sudo k3s kubectl -n mailhub rollout restart deploy/mailhub-sync'

if [ -n "$failed" ]; then
  printf '\n失敗したアカウント:%s\n該当する行だけ残して、このスクリプトをもう一度実行してください。\n' "$failed"
else
  printf '\n全部登録しました。\n'
fi
