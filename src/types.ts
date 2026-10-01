// 跨模組共用的型別。改這裡等於改介面，要同步所有用到的模組。

// ---------- Queue 工作 ----------
export type Job = LineEventJob | SnapshotPostsJob;

export interface LineEventJob {
  kind: 'line_event';
  event: LineWebhookEvent;
  receivedAt: number;           // Worker 收到 webhook 的時間（ms）
}

export interface SnapshotPostsJob {
  kind: 'snapshot_posts';
  date: string;                 // 台北日期 YYYY-MM-DD
  mediaIds: string[];           // 每則最多 25 個，避免超過免費版單次 50 個 subrequest
}

// ---------- LINE webhook（只列我們用到的欄位） ----------
export interface LineSource {
  type: 'user' | 'group' | 'room';
  userId?: string;
}

export interface LineWebhookEvent {
  type: 'message' | 'postback' | 'follow' | 'unfollow' | string;
  webhookEventId: string;
  timestamp: number;            // ms
  replyToken?: string;
  source: LineSource;
  deliveryContext?: { isRedelivery: boolean };
  mode?: 'active' | 'standby';
  message?: {
    id: string;
    type: 'text' | 'image' | string;
    text?: string;
    quoteToken?: string;
    contentProvider?: { type: 'line' | 'external' };
  };
  postback?: { data: string };
}

export interface LineWebhookBody {
  destination: string;
  events: LineWebhookEvent[];
}

// LINE 訊息物件（寬鬆型別，flex 內容太多變）
export type LineMessage = Record<string, unknown> & { type: string };

// 回覆情境：reply token 有效就用 reply（免費），過期改 push（算則數）
export interface ReplyContext {
  userId: string;
  replyToken?: string;
  eventTimestamp: number;
}

// ---------- 人設與產品 ----------
export interface Persona {
  id: number;
  name: string;
  tone: string;
  identityNote: string | null;
  bannedWords: string[];
  examples: string[];
  isActive: boolean;
  sortOrder: number;
}

export interface ProductCard {
  id: number;
  title: string;
  facts: string[];
  ctaHint: string | null;
}

// ---------- 產生留言 ----------
export type DraftVariant = 'default' | 'regen' | 'shorter' | 'playful';

export interface GenerateInput {
  post: {
    url: string;
    author: string | null;
    text?: string;                              // Max 貼的原文
    image?: { base64: string; mediaType: string }; // Max 傳的截圖
  };
  persona: Persona;
  product: ProductCard | null;
  variant: DraftVariant;
  keyword: string | null;
  avoidTexts: string[];                         // 最近送出過的留言，避免重複
  previousDrafts?: string[];                    // 「換一批／再短一點」時，上一批的內容
}

export interface GeneratedComment {
  text: string;
  mentionsProduct: boolean;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  stopReason: string | null;
}

export type GenerateResult =
  | { ok: true; comments: GeneratedComment[]; summary: string; usage: LlmUsage }
  | { ok: false; reason: 'sensitive' | 'refusal' | 'invalid_output' | 'api_error' | 'budget'; message: string; usage?: LlmUsage };

// ---------- 後台／安全 ----------
export type OpenCheck =
  | { allowed: true; intentUrl: string }
  | { allowed: false; reason: string; retryAt?: number; hint?: string }; // hint：擋下頁多顯示的一句下一步
