-- Threads 海巡機器人 資料庫結構 v1
-- 時間欄位一律是 epoch 毫秒（INTEGER）。date 欄位是台北時間 'YYYY-MM-DD'。
-- 不用外鍵約束，關聯由程式維護（清理舊資料時才不會卡住）。

-- 設定（key/value）。預設值寫在 src/lib/settings.ts，這裡只存改過的值。
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 人設卡：只定語氣，不假冒身分
CREATE TABLE personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  tone TEXT NOT NULL,                      -- 語氣說明
  identity_note TEXT,                      -- 真實身分（例：maxstudio 創辦人）。沒有就留空
  banned_words TEXT NOT NULL DEFAULT '[]', -- JSON 字串陣列
  examples TEXT NOT NULL DEFAULT '[]',     -- JSON 字串陣列，範例留言
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 產品資料卡：留言裡只准用這張卡上的事實
CREATE TABLE product_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  facts TEXT NOT NULL,                     -- JSON 字串陣列
  cta_hint TEXT,                           -- 想導去哪（例：「看我主頁」），不放網址
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- 關鍵字紀錄（/海巡 指令、每批草稿帶的關鍵字）
CREATE TABLE keyword_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  source TEXT NOT NULL,                    -- 'patrol_cmd' | 'draft'
  result_count INTEGER,                    -- Phase 2 官方搜尋才有
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_keyword_log_kw ON keyword_log(keyword, created_at);

-- 目標貼文（別人的貼文）。不存全文，只存 100 字內摘要，30 天後清掉摘要
CREATE TABLE targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shortcode TEXT NOT NULL UNIQUE,
  author_username TEXT,
  url TEXT NOT NULL,
  summary TEXT,
  keyword TEXT,
  source_type TEXT,                        -- 'text' | 'image'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_targets_author ON targets(author_username);

-- 一次產生（5 則）＝一個 batch
CREATE TABLE draft_batches (
  id TEXT PRIMARY KEY,
  target_id INTEGER NOT NULL,
  persona_id INTEGER,
  variant TEXT NOT NULL DEFAULT 'default', -- default|regen|shorter|playful
  keyword TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_batches_target ON draft_batches(target_id);

-- 單則草稿。id 是 /go/<id> 用的隨機字串
CREATE TABLE comment_drafts (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,                    -- 1..5
  text TEXT NOT NULL,
  mentions_product INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',    -- draft|opened|posted
  opened_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_drafts_batch ON comment_drafts(batch_id);
CREATE INDEX idx_drafts_status ON comment_drafts(status, opened_at);

-- 按「開 Threads 回覆」的紀錄（含被安全檢查擋下的）
CREATE TABLE link_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  reason TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_clicks_created ON link_clicks(created_at);

-- 實際送出的留言（從 /me/replies 比對回來）
CREATE TABLE posted_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  threads_media_id TEXT NOT NULL UNIQUE,
  draft_id TEXT,
  target_id INTEGER,
  text TEXT NOT NULL,
  permalink TEXT,
  posted_at INTEGER NOT NULL,
  similarity REAL,                         -- 跟草稿的相似度 0..1（1＝沒改）
  status TEXT NOT NULL DEFAULT 'live',     -- live|missing
  missing_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_posted_posted_at ON posted_comments(posted_at);

-- 每則留言在 1h/24h/72h 的成效
CREATE TABLE reply_snapshots (
  posted_id INTEGER NOT NULL,
  milestone TEXT NOT NULL,                 -- '1h' | '24h' | '72h'
  views INTEGER,
  likes INTEGER,
  replies INTEGER,
  reposts INTEGER,
  quotes INTEGER,
  shares INTEGER,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (posted_id, milestone)
);

-- 自己帳號每日數據
CREATE TABLE own_daily (
  date TEXT PRIMARY KEY,
  followers_count INTEGER,
  views INTEGER,                           -- 個人檔案瀏覽（當天）
  likes INTEGER,
  replies INTEGER,
  reposts INTEGER,
  quotes INTEGER,
  clicks INTEGER,
  captured_at INTEGER NOT NULL
);

-- 自己的貼文
CREATE TABLE own_posts (
  media_id TEXT PRIMARY KEY,
  shortcode TEXT,
  permalink TEXT,
  text TEXT,
  media_type TEXT,
  posted_at INTEGER NOT NULL,
  topic TEXT,                              -- LLM 分類的主題（/主題 用）
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_own_posts_posted_at ON own_posts(posted_at);

CREATE TABLE own_post_snapshots (
  media_id TEXT NOT NULL,
  date TEXT NOT NULL,
  views INTEGER,
  likes INTEGER,
  replies INTEGER,
  reposts INTEGER,
  quotes INTEGER,
  shares INTEGER,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (media_id, date)
);

-- 黑名單：不回的作者或貼文
CREATE TABLE blocklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                      -- 'author' | 'shortcode'
  value TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, value)
);

-- 暫停紀錄
CREATE TABLE pauses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  until_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,                    -- 'manual' | 'auto'
  created_at INTEGER NOT NULL,
  cleared_at INTEGER
);

-- 第三方 token（AES-GCM 加密後存）
CREATE TABLE app_tokens (
  provider TEXT PRIMARY KEY,               -- 'threads'
  user_id TEXT,
  username TEXT,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  scopes TEXT,
  expires_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- 每次呼叫 Claude 的用量與花費
CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,                   -- 'comments' | 'keywords' | 'topics'
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL,
  stop_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_llm_usage_created ON llm_usage(created_at);

-- LINE webhook 去重（保留 7 天）
CREATE TABLE line_events (
  webhook_event_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,                    -- 'queued' | 'done' | 'failed'
  created_at INTEGER NOT NULL
);

-- push 用量（reply 不算則數，所以只記 push）
CREATE TABLE line_push_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,                   -- 'morning' | 'late_reply' | 'alert'
  retry_key TEXT,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  request_id TEXT,
  created_at INTEGER NOT NULL
);

-- 對話狀態：「先貼網址，下一則再傳原文或截圖」要記住上一則
CREATE TABLE conversation_state (
  user_id TEXT PRIMARY KEY,
  pending_url TEXT,
  pending_shortcode TEXT,
  pending_author TEXT,
  pending_at INTEGER,
  current_keyword TEXT,                    -- 最近一次 /海巡 的關鍵字，之後的草稿都帶這個
  keyword_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- 後台登入失敗紀錄（防暴力破解）
CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts ON login_attempts(ip, created_at);

-- 排程與背景工作紀錄（後台「用量與健康」頁看）
CREATE TABLE job_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_job_log_created ON job_log(created_at);
