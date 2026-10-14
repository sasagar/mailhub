// 一時データの掃除。本文・添付・検索結果・依頼は、使い終わったら残さない（DB とそのバックアップに溜めない）。
// 以前は次の依頼が来たときにしか消していなかったので、依頼が無い間は期限を過ぎても残っていた
import type { Sql } from '@mailhub/db'

export const RETENTION = {
  // 開いた本文（開き直しを速くするため）
  bodyDays: 7,
  // 取り出した添付（Worker が受け取れば役目は終わり）
  attachmentMinutes: 60,
  // 送った下書きの添付（送信済みフォルダに控えがあるので、DB には長く残さない）
  sentAttachmentDays: 7,
  // 検索結果と依頼の記録
  requestHours: 24,
} as const

export async function purgeExpired(sql: Sql): Promise<void> {
  await sql`delete from message_bodies where fetched_at < now() - make_interval(days => ${RETENTION.bodyDays})`
  await sql`delete from attachment_blobs where created_at < now() - make_interval(mins => ${RETENTION.attachmentMinutes})`
  await sql`
    delete from draft_attachments where draft_id in (
      select id from drafts where status = 'sent' and sent_at < now() - make_interval(days => ${RETENTION.sentAttachmentDays}))`
  await sql`delete from search_requests where created_at < now() - make_interval(hours => ${RETENTION.requestHours})`
  await sql`delete from requests where created_at < now() - make_interval(hours => ${RETENTION.requestHours})`
}
