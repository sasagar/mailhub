#!/bin/sh
# Google の OAuth クライアント（デスクトップ アプリ）の ID とシークレットを、k3s の Secret mailhub-secret に足す。
# 入力は画面にもシェルの履歴にも残さない。
#   sh deploy/scripts/set-google-client.sh            # control plane に ssh samurai-watch で入る
#   KUBE_HOST=other sh deploy/scripts/set-google-client.sh
set -eu
host="${KUBE_HOST:-samurai-watch}"

printf 'GOOGLE_CLIENT_ID: '
read -r id
printf 'GOOGLE_CLIENT_SECRET（表示されません）: '
stty -echo
read -r secret
stty echo
printf '\n'
[ -n "$id" ] && [ -n "$secret" ] || { echo "空の値は入れられません" >&2; exit 1; }

# 値は標準入力で渡す（コマンドラインに載せると ps やログに残る）
printf '{"stringData":{"GOOGLE_CLIENT_ID":"%s","GOOGLE_CLIENT_SECRET":"%s"}}' "$id" "$secret" |
  ssh "$host" 'f=$(mktemp); cat > "$f"; sudo k3s kubectl -n mailhub patch secret mailhub-secret --type merge --patch-file "$f"; rm -f "$f"'
ssh "$host" 'sudo k3s kubectl -n mailhub rollout restart deploy/mailhub-sync' >/dev/null
echo "Secret に入れて、同期デーモンを再起動しました"
