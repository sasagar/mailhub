-- Worker のロール（mailhub_mcp）が下書きの状態を変えられるのは、送信待ち（queued）にするときだけにする。
-- 送信中・送信済み・失敗にするのは同期デーモン（所有者のロール）だけ。Worker のコードに不備があっても、
-- 版の確認を飛ばして送信済みの下書きを下書きに戻す（再送させる）ようなことはできない
create function drafts_status_guard() returns trigger language plpgsql as $$
begin
  if current_user = 'mailhub_mcp' and new.status is distinct from old.status
     and not (old.status in ('draft', 'failed') and new.status = 'queued') then
    raise exception 'mailhub_mcp は下書きの状態を % から % に変えられません', old.status, new.status;
  end if;
  return new;
end $$;

create trigger drafts_status_guard before update on drafts
  for each row execute function drafts_status_guard();
