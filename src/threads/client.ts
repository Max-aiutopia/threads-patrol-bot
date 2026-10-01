// Threads Graph API 用戶端（只用 Phase 1 不用審的端點：自己的帳號、自己的貼文與回覆、自己的 insights）
// 端點與回應格式來源：
//   https://developers.facebook.com/documentation/threads/insights
//   https://developers.facebook.com/documentation/threads/retrieve-and-manage-replies/retrieve-replies
//   https://developers.facebook.com/documentation/threads/get-started/long-lived-tokens
import type { Env } from '../env';
import { THREADS_API_VERSION } from '../env';
import { fetchWithTimeout } from '../lib/http';

const TIMEOUT_MS = 20_000;

export interface ThreadsMedia {
  id: string;
  text?: string;
  timestamp: string;
  permalink?: string;
  shortcode?: string;
  media_type?: string;
  is_reply?: boolean;
  is_quote_post?: boolean;
}

export class ThreadsApiError extends Error {
  status: number;
  code?: number;
  subcode?: number;
  isRateLimit: boolean;
  isAuth: boolean;
  isNotFound: boolean;

  constructor(message: string, status: number, code?: number, subcode?: number) {
    super(message);
    this.name = 'ThreadsApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.isRateLimit = status === 429 || (code !== undefined && [4, 17, 32, 613].includes(code));
    this.isAuth = status === 401 || code === 190;
    const lower = message.toLowerCase();
    this.isNotFound =
      status === 404 ||
      (code === 100 && (subcode === 33 || lower.includes('does not exist') || lower.includes('unsupported get request')));
  }
}

// Graph API 的 id 是字串，但 OAuth 回應的 user_id 是超過 2^53 的數字，直接 JSON.parse 會失真。
// 先把 16 位以上的 id / user_id 數字包成字串再 parse。
function parseJsonKeepIds(text: string): unknown {
  return JSON.parse(text.replace(/"(id|user_id)"\s*:\s*(\d{16,})/g, '"$1":"$2"'));
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function errorFromBody(status: number, body: unknown, fallback: string): ThreadsApiError {
  const b = (body ?? {}) as Record<string, unknown>;
  const e = b.error;
  if (e && typeof e === 'object') {
    const eo = e as Record<string, unknown>;
    const msg = typeof eo.message === 'string' ? eo.message : fallback;
    return new ThreadsApiError(msg, status, toNum(eo.code), toNum(eo.error_subcode));
  }
  // OAuth 端點有時回 { error_type, code, error_message }
  if (typeof b.error_message === 'string') {
    return new ThreadsApiError(b.error_message, status, toNum(b.code), undefined);
  }
  if (typeof e === 'string') {
    const desc = typeof b.error_description === 'string' ? b.error_description : e;
    return new ThreadsApiError(desc, status);
  }
  return new ThreadsApiError(fallback, status);
}

function apiBase(env: Env): string {
  return env.THREADS_API_BASE.replace(/\/+$/, '');
}

// 送出請求並解析 JSON；失敗一律丟 ThreadsApiError。錯誤訊息只帶路徑，不帶網址參數（裡面有 token）。
async function send(url: string, init: RequestInit, label: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, init, TIMEOUT_MS);
  } catch (err) {
    const reason = err instanceof Error ? err.name : String(err);
    throw new ThreadsApiError(`network error on ${label}: ${reason}`, 0);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = parseJsonKeepIds(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok || (body && typeof body === 'object' && 'error' in (body as object))) {
    throw errorFromBody(res.status, body, `HTTP ${res.status} on ${label}`);
  }
  if (body === null) throw new ThreadsApiError(`non-JSON response on ${label}`, res.status);
  return body;
}

// 沒有版本前綴的端點（/oauth/access_token、/access_token、/refresh_access_token）
export async function threadsRawGet(env: Env, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  return (await send(`${apiBase(env)}${path}?${qs}`, { headers: { accept: 'application/json' } }, path)) as Record<string, unknown>;
}

export async function threadsRawPostForm(env: Env, path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  return (await send(
    `${apiBase(env)}${path}`,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    },
    path,
  )) as Record<string, unknown>;
}

// Threads 的 timestamp 長這樣：2024-07-12T08:00:00+0000。回傳 epoch ms；看不懂就回 null
export function parseThreadsTime(s: string | undefined | null): number | null {
  if (!s) return null;
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(fixed);
  return Number.isFinite(t) ? t : null;
}

// insights 的一個 metric 取數字：total_value.value → values[] 加總 → link_total_values[] 加總
function metricNumber(item: Record<string, unknown>): number | undefined {
  const tv = item.total_value as Record<string, unknown> | undefined;
  if (tv && typeof tv === 'object') {
    const v = toNum(tv.value);
    if (v !== undefined) return v;
    if (Array.isArray(tv.link_total_values)) {
      return sumValues(tv.link_total_values);
    }
  }
  if (Array.isArray(item.values)) {
    const s = sumValues(item.values);
    if (s !== undefined) return s;
  }
  if (Array.isArray(item.link_total_values)) return sumValues(item.link_total_values);
  return undefined;
}

function sumValues(arr: unknown[]): number | undefined {
  let sum = 0;
  let found = false;
  for (const x of arr) {
    const v = toNum((x as Record<string, unknown> | null)?.value);
    if (v !== undefined) {
      sum += v;
      found = true;
    }
  }
  return found ? sum : undefined;
}

function parseInsights(body: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return out;
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== 'string') continue;
    const v = metricNumber(item);
    if (v !== undefined) out[item.name] = v;
  }
  return out;
}

function toMedia(raw: unknown): ThreadsMedia | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.id === undefined || r.id === null) return null;
  return {
    id: String(r.id),
    text: typeof r.text === 'string' ? r.text : undefined,
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
    permalink: typeof r.permalink === 'string' ? r.permalink : undefined,
    shortcode: typeof r.shortcode === 'string' ? r.shortcode : undefined,
    media_type: typeof r.media_type === 'string' ? r.media_type : undefined,
    is_reply: typeof r.is_reply === 'boolean' ? r.is_reply : undefined,
    is_quote_post: typeof r.is_quote_post === 'boolean' ? r.is_quote_post : undefined,
  };
}

// 下一頁的 cursor。官方範例的 paging 有時只有 cursors、沒有 next：
// 有 next 就照 next；沒有 next 但這頁是滿的（筆數 = limit）而且有 after，也往下翻（呼叫端有頁數上限，不會無限翻）
export function afterCursor(body: unknown, pageLen?: number, limit?: number): string | undefined {
  const paging = (body as { paging?: { next?: string; cursors?: { after?: string } } })?.paging;
  const after = paging?.cursors?.after || undefined;
  if (!after) return undefined;
  if (paging?.next) return after;
  return limit && pageLen !== undefined && pageLen >= limit ? after : undefined;
}

// 某個 metric 的 values 有幾段（帳號 views 是每天一段的時間序列）
function valuesCount(body: unknown, name: string): number | undefined {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return undefined;
  const item = data.find((x) => x && typeof x === 'object' && (x as { name?: unknown }).name === name) as { values?: unknown } | undefined;
  return Array.isArray(item?.values) ? item!.values.length : undefined;
}

export class ThreadsClient {
  private env: Env;
  private token: string;
  private userId: string | null;
  // 這個用戶端送出的請求數（給排程控制免費版每次 ≤ 40 個對外請求）
  calls = 0;

  constructor(env: Env, accessToken: string, userId?: string | null) {
    this.env = env;
    this.token = accessToken;
    this.userId = userId ?? null;
  }

  private async get(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    qs.set('access_token', this.token);
    this.calls++;
    return send(`${apiBase(this.env)}/${THREADS_API_VERSION}${path}?${qs.toString()}`, { headers: { accept: 'application/json' } }, path);
  }

  async me(): Promise<{ id: string; username: string }> {
    const b = (await this.get('/me', { fields: 'id,username' })) as Record<string, unknown>;
    if (b.id === undefined || b.id === null) throw new ThreadsApiError('me: missing id', 200);
    return { id: String(b.id), username: typeof b.username === 'string' ? b.username : '' };
  }

  // 自己的回覆。maxPages 是本專案加的：一次最多跟幾頁（預設 1）
  async myReplies(p: { sinceSec?: number; limit?: number; maxPages?: number }): Promise<ThreadsMedia[]> {
    const out: ThreadsMedia[] = [];
    const pages = Math.max(1, p.maxPages ?? 1);
    let after: string | undefined;
    for (let i = 0; i < pages; i++) {
      const b = await this.get('/me/replies', {
        fields: 'id,text,timestamp,permalink,shortcode,is_reply,media_type',
        since: p.sinceSec,
        limit: p.limit,
        after,
      });
      const data = (b as { data?: unknown[] })?.data;
      if (Array.isArray(data)) for (const r of data) {
        const m = toMedia(r);
        if (m) out.push(m);
      }
      after = afterCursor(b, Array.isArray(data) ? data.length : 0, p.limit);
      if (!after) break;
    }
    return out;
  }

  async myThreads(p: { sinceSec?: number; limit?: number; after?: string }): Promise<{ data: ThreadsMedia[]; next?: string }> {
    const b = await this.get('/me/threads', {
      fields: 'id,text,timestamp,permalink,shortcode,media_type,is_quote_post',
      since: p.sinceSec,
      limit: p.limit,
      after: p.after,
    });
    const data: ThreadsMedia[] = [];
    const raw = (b as { data?: unknown[] })?.data;
    if (Array.isArray(raw)) for (const r of raw) {
      const m = toMedia(r);
      if (m) data.push(m);
    }
    return { data, next: afterCursor(b, Array.isArray(raw) ? raw.length : 0, p.limit) };
  }

  async mediaInsights(mediaId: string): Promise<{ views?: number; likes?: number; replies?: number; reposts?: number; quotes?: number; shares?: number }> {
    const b = await this.get(`/${encodeURIComponent(mediaId)}/insights`, { metric: 'views,likes,replies,reposts,quotes,shares' });
    const m = parseInsights(b);
    return { views: m.views, likes: m.likes, replies: m.replies, reposts: m.reposts, quotes: m.quotes, shares: m.shares };
  }

  // 本專案加的：確認某則貼文／回覆還在（insights 查不到時用來分辨「被刪了」還是「這種貼文不支援 insights」）
  // 在 → true；查不到 → false；其他錯誤照丟
  async mediaExists(mediaId: string): Promise<boolean> {
    try {
      await this.get(`/${encodeURIComponent(mediaId)}`, { fields: 'id' });
      return true;
    } catch (err) {
      if (err instanceof ThreadsApiError && err.isNotFound) return false;
      throw err;
    }
  }

  // 帳號 insights。官方文件寫 followers_count 不支援 since/until，所以拆成兩次請求：
  //   1) views,likes,replies,reposts,quotes,clicks + since/until
  //   2) followers_count（不帶時間）
  // 其中一次失敗（授權或限流以外的錯誤）時保留另一次的結果；兩次都失敗才丟錯。
  // viewsBuckets 是本專案加的：views 時間序列有幾段（診斷用，見 daily.ts）
  async userInsights(p: { sinceSec: number; untilSec: number }): Promise<{ views?: number; likes?: number; replies?: number; reposts?: number; quotes?: number; clicks?: number; followersCount?: number; viewsBuckets?: number }> {
    const who = this.userId ? encodeURIComponent(this.userId) : 'me';
    const path = `/${who}/threads_insights`;
    let range: Record<string, number> | null = null;
    let viewsBuckets: number | undefined;
    let followers: Record<string, number> | null = null;
    let firstErr: unknown = null;

    try {
      const body = await this.get(path, { metric: 'views,likes,replies,reposts,quotes,clicks', since: p.sinceSec, until: p.untilSec });
      range = parseInsights(body);
      viewsBuckets = valuesCount(body, 'views');
    } catch (err) {
      if (err instanceof ThreadsApiError && (err.isAuth || err.isRateLimit)) throw err;
      firstErr = err;
    }
    try {
      followers = parseInsights(await this.get(path, { metric: 'followers_count' }));
    } catch (err) {
      if (err instanceof ThreadsApiError && (err.isAuth || err.isRateLimit)) throw err;
      firstErr = firstErr ?? err;
    }
    if (!range && !followers) throw firstErr;

    return {
      views: range?.views,
      likes: range?.likes,
      replies: range?.replies,
      reposts: range?.reposts,
      quotes: range?.quotes,
      clicks: range?.clicks,
      followersCount: followers?.followers_count,
      viewsBuckets,
    };
  }
}
