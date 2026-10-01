// 可在後台調整的設定。預設值只寫在這裡；DB 的 settings 表只存「改過的值」。
import type { Env } from '../env';

export interface Settings {
  llm_model: string;              // 'claude-opus-5' | 'claude-sonnet-5' | 'claude-haiku-4-5'
  llm_effort: 'low' | 'medium' | 'high'; // Haiku 4.5 不吃這個參數，會自動忽略
  monthly_budget_usd: number;     // 本月 Claude 花費超過就停止產生（0 = 不限）
  daily_cap_first14: number;      // 開始後前 14 天每日上限
  daily_cap: number;              // 之後每日上限
  hourly_cap: number;
  min_interval_min: number;       // 兩則之間的隨機間隔下限（分鐘）
  max_interval_min: number;       // 上限
  night_start: string;            // 'HH:MM' 台北時間，這段時間不開放送出
  night_end: string;
  same_author_days: number;       // 同一作者 N 天內只回 1 次
  reopen_grace_min: number;       // 同一篇貼文打開後 N 分鐘內可換別則草稿再開（算同一則）
  product_every: number;          // 每 N 則最多 1 則提到產品
  similarity_block: number;       // 跟最近送出的留言相似度 ≥ 這個值就擋（0..1）
  missing_pause_threshold: number;// 7 天內有 N 則留言查不到 → 自動暫停
  auto_pause_hours: number;
  push_warn_at: number;           // push 用到這個數字就提醒
  morning_report: boolean;
  flex_clipboard: boolean;        // 卡片放「複製」按鈕（只有手機 LINE 14.0.0+ 支援）
  open_external_browser: boolean; // /go/ 連結加 openExternalBrowser=1
  started_at: number;             // 開始海巡的日期（ms），算「前 14 天」用；0 = 還沒開始
  next_allowed_at: number;        // 下一則最早可以開的時間（ms），由 /go/ 寫入
  active_persona_id: number;      // 0 = 用排序第一個啟用中的人設
}

export const DEFAULT_SETTINGS: Settings = {
  llm_model: 'claude-opus-5',
  llm_effort: 'low',             // 預設低：LINE 免費回覆要在約 1 分鐘內送出，思考太久會改用算則數的 push
  monthly_budget_usd: 40,
  daily_cap_first14: 10,
  daily_cap: 20,
  hourly_cap: 3,
  min_interval_min: 6,
  max_interval_min: 20,
  night_start: '00:00',
  night_end: '08:00',
  same_author_days: 7,
  reopen_grace_min: 15,
  product_every: 3,
  similarity_block: 0.8,
  missing_pause_threshold: 3,
  auto_pause_hours: 72,
  push_warn_at: 150,
  morning_report: true,
  flex_clipboard: true,
  open_external_browser: false,
  started_at: 0,
  next_allowed_at: 0,
  active_persona_id: 0,
};

// 後台可以改的 key（next_allowed_at 由系統寫，不給改）
export const EDITABLE_KEYS: (keyof Settings)[] = [
  'llm_model', 'llm_effort', 'monthly_budget_usd', 'daily_cap_first14', 'daily_cap', 'hourly_cap',
  'min_interval_min', 'max_interval_min', 'night_start', 'night_end', 'same_author_days',
  'reopen_grace_min', 'product_every', 'similarity_block', 'missing_pause_threshold',
  'auto_pause_hours', 'push_warn_at', 'morning_report', 'flex_clipboard', 'open_external_browser',
  'started_at', 'active_persona_id',
];

export const ALLOWED_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;

function coerce<K extends keyof Settings>(key: K, raw: string): Settings[K] {
  const def = DEFAULT_SETTINGS[key];
  if (typeof def === 'number') {
    const n = Number(raw);
    return (Number.isFinite(n) ? n : def) as Settings[K];
  }
  if (typeof def === 'boolean') return (raw === 'true' || raw === '1') as Settings[K];
  return raw as Settings[K];
}

export async function getSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const s: Settings = { ...DEFAULT_SETTINGS };
  for (const r of results ?? []) {
    if (r.key in DEFAULT_SETTINGS) {
      const k = r.key as keyof Settings;
      (s as unknown as Record<string, unknown>)[k] = coerce(k, r.value);
    }
  }
  return s;
}

export async function setSetting<K extends keyof Settings>(env: Env, key: K, value: Settings[K]): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  )
    .bind(key, String(value), Date.now())
    .run();
}

// 驗證後台送來的值。回傳錯誤訊息（中文）或 null
export function validateSetting(key: keyof Settings, value: unknown): string | null {
  const def = DEFAULT_SETTINGS[key];
  if (typeof def === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return `${key} 要是 0 以上的數字`;
    if (key === 'similarity_block' && value > 1) return 'similarity_block 要在 0 到 1 之間';
    return null;
  }
  if (typeof def === 'boolean') return typeof value === 'boolean' ? null : `${key} 要是 true/false`;
  if (typeof value !== 'string') return `${key} 要是文字`;
  if (key === 'llm_model' && !(ALLOWED_MODELS as readonly string[]).includes(value)) return `模型只能選 ${ALLOWED_MODELS.join('、')}`;
  if (key === 'llm_effort' && !['low', 'medium', 'high'].includes(value)) return 'llm_effort 只能是 low、medium、high';
  if ((key === 'night_start' || key === 'night_end') && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return '時間格式是 HH:MM';
  return null;
}

export async function logJob(env: Env, job: string, ok: boolean, detail?: string): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO job_log (job, ok, detail, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(job, ok ? 1 : 0, detail?.slice(0, 2000) ?? null, Date.now())
      .run();
  } catch {
    // 記 log 失敗不影響主流程
  }
}
