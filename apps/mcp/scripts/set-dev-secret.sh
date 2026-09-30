#!/bin/sh
# infra の tofu state から Access の client secret を取り出し、apps/mcp/.dev.vars に書き込む。
# 値は画面にもシェルの履歴にも出さない。
#   sh apps/mcp/scripts/set-dev-secret.sh
set -eu

here="$(cd "$(dirname "$0")/.." && pwd)"
infra="${INFRA_DIR:-$HOME/ghq/github.com/sasagar/infra}/terraform/cloudflare/account"

secret="$(cd "$infra" && tofu output -raw mailhub_mcp_oidc_client_secret)"
if [ -z "$secret" ]; then
  echo "client secret を取り出せませんでした" >&2
  exit 1
fi

SECRET="$secret" node -e '
const fs = require("fs")
const file = process.argv[1]
const lines = fs.readFileSync(file, "utf8").split("\n")
const i = lines.findIndex((l) => l.startsWith("ACCESS_CLIENT_SECRET="))
const line = "ACCESS_CLIENT_SECRET=" + process.env.SECRET
if (i >= 0) lines[i] = line
else lines.push(line)
fs.writeFileSync(file, lines.join("\n"), { mode: 0o600 })
' "$here/.dev.vars"

echo "ACCESS_CLIENT_SECRET を $here/.dev.vars に書き込みました"
