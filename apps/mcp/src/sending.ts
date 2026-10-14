// 差出人のドメインごとの送り方。同期デーモンの AGENTIC_INBOX_DOMAINS（deploy/k3s/mailhub.yaml）と揃える。
// このドメインの差出人は agentic-inbox（Cloudflare Email Service）から送るので、Email Service の上限に合わせる
export const AGENTIC_INBOX_DOMAINS = ['love-rox.cc', 'kizami.dev', 'bktsk.app']

// Email Service は 1 通 5 MiB まで（base64 にした添付込み）。元のファイルで 3.5 MiB なら base64 で約 4.7 MiB、
// 本文とヘッダーの分が残る。Gmail などの SMTP は 25MB までなので、base64 と本文の分を見て 15MB
export const ATTACHMENT_LIMIT_AGENTIC = 3.5 * 1024 * 1024
export const ATTACHMENT_LIMIT_SMTP = 15 * 1024 * 1024

export function attachmentLimitFor(from: string): number {
  const domain = from.split('@').pop()?.toLowerCase() ?? ''
  return AGENTIC_INBOX_DOMAINS.includes(domain) ? ATTACHMENT_LIMIT_AGENTIC : ATTACHMENT_LIMIT_SMTP
}

export const fmtMB = (bytes: number) => `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`
