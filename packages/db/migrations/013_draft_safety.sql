-- 下書きの取り違え・すり替え対策
-- version: 変更のたびに増やす。送信は画面で表示していた版と一致したときだけ受け付ける
-- queued: 送信の依頼を受けた状態。この間は変更も削除もできず、同期デーモンは queued の下書きだけを送る
-- updated_by / agent_touched: 最後に変えたのは誰か、エージェント（MCP）が一度でも作った・変えたか
-- reply_expected / reply_redirected: 返信のとき、元のメールにあった宛先（それ以外が入っていれば画面で警告する）と、
--   返信先（Reply-To）が差出人と違ったときの元の差出人
alter table drafts add column version integer not null default 1;
alter table drafts add column updated_by text;
alter table drafts add column agent_touched boolean not null default false;
alter table drafts add column reply_expected jsonb;
alter table drafts add column reply_redirected text;
alter table drafts drop constraint drafts_status_check;
alter table drafts add constraint drafts_status_check
  check (status in ('draft', 'queued', 'sending', 'sent', 'failed'));
update drafts set agent_touched = true where created_by like 'mcp:%';
