-- アカウントを「個人」「仕事」などのモードに振り分ける。画面ではモードごとに見渡せる。
-- 値は画面にそのまま出す名前（あとで「個人事業」のように足すときも、値を変えるだけで済む）
alter table accounts add column mode text not null default '個人' check (length(mode) between 1 and 20);

-- モード単位の検索。対象のアカウントを並べて渡す（null なら account_id に従う）
alter table search_requests add column account_ids integer[];
