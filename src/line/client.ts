// LINE Messaging API 用戶端。網址一律從 env 讀（測試時指到 mock）。
// 官方規格：https://developers.line.biz/en/reference/messaging-api/
// - reply / push 一次最多 5 個訊息物件
// - reply 不算則數；push 算則數（以收件人數計），輕用量每月 200 則、用完回 429
// - push 帶 X-Line-Retry-Key，重試用同一把 key；已被接受過會回 409 + x-line-accepted-request-id
// - 端點網址結尾不要加斜線（2026-08-17 官方公告）
import type { Env } from '../env';
import type { LineMessage, ReplyContext } from '../types';
import { fetchWithTimeout } from '../lib/http';
import { logJob } from '../lib/settings';

const MAX_MESSAGES = 5;
// reply token 官方寫「收到 webhook 後 1 分鐘內」，時限可能無預警縮短，所以留 10 秒緩衝
const REPLY_WINDOW_MS = 50_000;
const SEND_TIMEOUT_MS = 10_000;

type PushPurpose = 'morning' | 'late_reply' | 'alert';

function trimSlash(s: string | undefined): string {
  return (s ?? '').replace(/\/+$/, '');
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function capMessages(messages: LineMessage[], where: string): LineMessage[] {
  if (messages.length <= MAX_MESSAGES) return messages;
  console.warn(`LINE ${where}: ${messages.length} 個訊息物件，只送前 ${MAX_MESSAGES} 個`);
  return messages.slice(0, MAX_MESSAGES);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LineClient {
  private readonly env: Env;
  private readonly api: string;
  private readonly dataApi: string;

  constructor(env: Env) {
    this.env = env;
    this.api = trimSlash(env.LINE_API_BASE);
    this.dataApi = trimSlash(env.LINE_DATA_API_BASE || env.LINE_API_BASE);
  }

  private headers(json: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}`, ...extra };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  async reply(
    replyToken: string,
    messages: LineMessage[],
  ): Promise<{ ok: boolean; status: number; requestId: string | null; body?: string }> {
    const msgs = capMessages(messages, 'reply');
    try {
      const res = await fetchWithTimeout(
        `${this.api}/v2/bot/message/reply`,
        { method: 'POST', headers: this.headers(true), body: JSON.stringify({ replyToken, messages: msgs }) },
        SEND_TIMEOUT_MS,
      );
      const requestId = res.headers.get('x-line-request-id');
      const text = await res.text().catch(() => '');
      if (res.ok) return { ok: true, status: res.status, requestId };
      return { ok: false, status: res.status, requestId, body: text.slice(0, 500) };
    } catch (err) {
      return { ok: false, status: 0, requestId: null, body: errText(err) };
    }
  }

  private async pushOnce(
    to: string,
    msgs: LineMessage[],
    retryKey: string,
  ): Promise<{ status: number; requestId: string | null; acceptedId: string | null }> {
    try {
      const res = await fetchWithTimeout(
        `${this.api}/v2/bot/message/push`,
        {
          method: 'POST',
          headers: this.headers(true, { 'X-Line-Retry-Key': retryKey }),
          body: JSON.stringify({ to, messages: msgs }),
        },
        SEND_TIMEOUT_MS,
      );
      await res.text().catch(() => '');
      return {
        status: res.status,
        requestId: res.headers.get('x-line-request-id'),
        acceptedId: res.headers.get('x-line-accepted-request-id'),
      };
    } catch {
      return { status: 0, requestId: null, acceptedId: null };
    }
  }

  async push(
    to: string,
    messages: LineMessage[],
    purpose: PushPurpose,
  ): Promise<{ ok: boolean; status: number; requestId: string | null }> {
    const msgs = capMessages(messages, 'push');
    const retryKey = crypto.randomUUID();
    let r = await this.pushOnce(to, msgs, retryKey);
    // 5xx 或網路錯誤：不確定 LINE 有沒有收到，用同一把 key 重試一次（收過的話會回 409，不會重複送）
    if (r.status === 0 || r.status >= 500) {
      await sleep(700);
      r = await this.pushOnce(to, msgs, retryKey);
    }
    const ok = (r.status >= 200 && r.status < 300) || r.status === 409;
    const requestId = r.status === 409 ? r.acceptedId ?? r.requestId : r.requestId;
    try {
      await this.env.DB.prepare(
        'INSERT INTO line_push_log (purpose, retry_key, ok, status_code, request_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      )
        .bind(purpose, retryKey, ok ? 1 : 0, r.status, requestId, Date.now())
        .run();
    } catch (err) {
      console.error('line_push_log insert failed', errText(err));
    }
    return { ok, status: r.status, requestId };
  }

  // 等待動畫：只在一對一聊天、使用者正開著聊天室時顯示（iOS/Android 13.16.0+）。失敗不影響主流程
  async startLoading(chatId: string, seconds = 45): Promise<void> {
    const n = Number.isFinite(seconds) ? seconds : 45;
    const loadingSeconds = Math.min(60, Math.max(5, Math.round(n / 5) * 5));
    try {
      const res = await fetchWithTimeout(
        `${this.api}/v2/bot/chat/loading/start`,
        { method: 'POST', headers: this.headers(true), body: JSON.stringify({ chatId, loadingSeconds }) },
        5_000,
      );
      await res.text().catch(() => '');
    } catch {
      // 動畫出不來就算了
    }
  }

  // 取回使用者傳的圖（只有 contentProvider.type === 'line' 才能用）
  async getContent(messageId: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    const res = await fetchWithTimeout(
      `${this.dataApi}/v2/bot/message/${encodeURIComponent(messageId)}/content`,
      { method: 'GET', headers: this.headers(false) },
      20_000,
    );
    if (res.status !== 200) {
      await res.text().catch(() => '');
      throw new Error(`LINE content HTTP ${res.status}`);
    }
    const bytes = await res.arrayBuffer();
    return { bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  private async getJson(path: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetchWithTimeout(`${this.api}${path}`, { method: 'GET', headers: this.headers(false) }, 8_000);
      if (!res.ok) {
        await res.text().catch(() => '');
        return null;
      }
      const data = (await res.json()) as unknown;
      return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  // limit：本月上限（type 'none' = 沒設上限 → null）；used：本月已用（官方說是約略值）。查不到 → null
  async getQuota(): Promise<{ limit: number | null; used: number | null }> {
    const [q, c] = await Promise.all([this.getJson('/v2/bot/message/quota'), this.getJson('/v2/bot/message/quota/consumption')]);
    const limit = q && q.type === 'limited' && typeof q.value === 'number' ? q.value : null;
    const used = c && typeof c.totalUsage === 'number' ? c.totalUsage : null;
    return { limit, used };
  }
}

// 回覆使用者：reply token 還新鮮就用 reply（免費），不然改 push（算 1 則）
export async function sendResult(
  env: Env,
  ctx: ReplyContext,
  messages: LineMessage[],
  purpose?: 'late_reply' | 'alert',
): Promise<'reply' | 'push' | 'failed'> {
  const client = new LineClient(env);
  let replyNote = '';
  if (ctx.replyToken && Date.now() - ctx.eventTimestamp < REPLY_WINDOW_MS) {
    const r = await client.reply(ctx.replyToken, messages);
    if (r.ok) return 'reply';
    replyNote = `reply ${r.status} ${r.body ?? ''}`.trim();
    await logJob(env, 'line_reply', false, replyNote);
    // 400 = token 過期或用過；0/5xx = 網路或 LINE 端問題。這幾種改用 push 補送。
    // 401/403/429 之類 push 也一樣會失敗，就不浪費一次呼叫
    const fallback = r.status === 400 || r.status === 0 || r.status >= 500;
    if (!fallback) return 'failed';
  }
  const p = await client.push(ctx.userId, messages, purpose ?? 'late_reply');
  if (p.ok) return 'push';
  const why = p.status === 429 ? 'push 429：本月則數用完或發太快' : `push ${p.status}`;
  await logJob(env, 'line_push', false, replyNote ? `${why}；先前 ${replyNote}` : why);
  return 'failed';
}
