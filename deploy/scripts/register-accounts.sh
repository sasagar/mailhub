#!/bin/sh
# 残りのアカウントを本番（k3s の同期デーモン）に登録する。Google 系（Gmail / Google Workspace）は OAuth、
# iCloud と SoftBank はアプリパスワード。終わったら同期デーモンを再起動して反映する。
#
#   sh deploy/scripts/register-accounts.sh
#
# GOOGLE の各行は「メールアドレス|表示名|差出人名」。表示名は画面に出す短い名前、差出人名は送信時に相手に見える名前。
# 登録済みのものや後回しにするものは行を消す。失敗したアカウントは飛ばして次へ進むので、あとでその行だけ残して再実行する。
set -u
host="${KUBE_HOST:-samurai-watch}"

cli() {
  # 対話式なので ssh -t と exec -it で端末をつなぐ
  ssh -t "$host" "sudo k3s kubectl -n mailhub exec -it deploy/mailhub-sync -- node_modules/.bin/tsx src/cli/$1"
}

GOOGLE='
yoshidakent@gmail.com|yoshidakent|吉田健徒
vo.parc.endless.dreamscometrue@gmail.com|vo.parc.endless.dreamscometrue|SASAGAWA Kiyoshi
yeosseun@gmail.com|yeosseun|Yeosseun
sasapiyogames@gmail.com|sasapiyogames|ささぴよげえむず
kent1123kent@gmail.com|kent1123kent|SASAGAWA Kiyoshi
loverox.sasapiyo@gmail.com|loverox.sasapiyo|SASAPIYO
boku@bktsk.com|boku|SASAGAWA Kiyoshi
sasagawa@kent-and-co.com|sasagawa|SASAGAWA Kiyoshi
'

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

for item in \
  'iCloud|sasagawakent@icloud.com|種類: icloud ／ 表示名: iCloud ／ 差出人名: 相手に見せる名前 ／ ホストとポートは Enter（自動） ／ ユーザー名: Enter（アドレスのまま） ／ パスワード: account.apple.com で作ったアプリ用パスワード' \
  'SoftBank|yoshidakent@i.softbank.jp|種類: generic ／ 表示名: SoftBank ／ 差出人名: 相手に見せる名前 ／ IMAP: imap.softbank.jp 993 ／ SMTP: smtp.softbank.jp 465 ／ ユーザー名: まず Enter（アドレスのまま）。失敗したら @ より前だけで再実行 ／ パスワード: My SoftBank の「Eメール(i)」のパスワード'; do
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
