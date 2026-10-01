// 後台 JSON API。index.ts 已經檢查過登入；這裡負責 CSRF、驗證輸入、查資料。
// 免費方案每次呼叫最多 40 個 D1 查詢：每個端點都控制在 10 個以內。
import type { Env } from '../env';
import type { Persona } from '../types';
import { json } from '../lib/http';
import { DAY, HOUR, startOfTaipeiDay, taipeiDate, TAIPEI_OFFSET_MS } from '../lib/time';
import {
  ALLOWED_MODELS, EDITABLE_KEYS, getSettings, logJob, setSetting, validateSetting, type Settings,
} from '../lib/settings';
import { getActivePersona, listPersonas, monthLlmCostUsd, monthPushCount, rowToPersona } from '../lib/repo';
import { sameOriginOk } from './auth';
import { containsLinkOrDomain } from '../lib/links';

import { tokenStatus } from '../threads/token';
import { parseThreadsPostUrl } from '../threads/url';
import { activePause, pauseFor, resume } from '../safety/pause';
import { dailyCapFor } from '../safety/limits';
import { LineClient } from '../line/client';
import { MODEL_PRICES, USD_TO_TWD } from '../llm/pricing';
import { runHourly } from '../jobs/hourly';
import { runDaily } from '../jobs/daily';
import { runMorning } from '../jobs/morning';
import { runWeekly } from '../jobs/weekly';

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

const bad = (message: string, extra?: Record<string, unknown>) => new HttpError(400, 'bad_request', message, extra);
const notFound = (message = '找不到') => new HttpError(404, 'not_found', message);

const MAX_BODY_BYTES = 64 * 1024;

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw bad('資料太大了');
  if (!text.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw bad('格式不是 JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('格式要是 JSON 物件');
  return v as Record<string, unknown>;
}

function intParam(url: URL, key: string, def: number, min: number, max: number): number {
  const n = Number(url.searchParams.get(key));
  if (!url.searchParams.has(key) || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isUniqueError(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err));
}


// ---------- 小工具 ----------

function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * DAY;
  return new Date(t).toISOString().slice(0, 10);
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function avg(nums: number[]): number | null {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function taipeiMonthStart(now: number): number {
  const d = new Date(now + TAIPEI_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TAIPEI_OFFSET_MS;
}

function normalizeUsername(s: string): string {
  return s.trim().replace(/^@+/, '').toLowerCase();
}

async function safeTokenStatus(env: Env) {
  try {
    return await tokenStatus(env);
  } catch (err) {
    console.error('tokenStatus failed', err);
    return { connected: false, username: null, expiresAt: null, daysLeft: null };
  }
}

// ---------- 路由 ----------

export async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method.toUpperCase();

  if (!sameOriginOk(req, env)) {
    return json({ error: 'forbidden', message: '請從後台頁面操作（來源或格式不對）' }, 403);
  }

  try {
    const seg = path.split('/').filter(Boolean); // ['api', ...]
    const [, a, b] = seg;

    if (seg.length === 2 && a === 'overview' && method === 'GET') return json(await overview(env));
    if (seg.length === 2 && a === 'comments' && method === 'GET') return json(await comments(env, url));
    if (seg.length === 2 && a === 'breakdown' && method === 'GET') return json(await breakdown(env));
    if (seg.length === 2 && a === 'posts' && method === 'GET') return json(await posts(env));

    if (a === 'personas') {
      if (seg.length === 2 && method === 'GET') return json(await personasList(env));
      if (seg.length === 2 && method === 'POST') return json(await personaCreate(env, await readBody(req)), 201);
      if (seg.length === 3) {
        const id = Number(b);
        if (!Number.isInteger(id) || id <= 0) throw notFound('找不到這個人設');
        if (method === 'PUT') return json(await personaUpdate(env, id, await readBody(req)));
        if (method === 'DELETE') return json(await personaDelete(env, id));
      }
    }

    if (seg.length === 2 && a === 'product') {
      if (method === 'GET') return json(await productGet(env));
      if (method === 'PUT') return json(await productPut(env, await readBody(req)));
    }

    if (seg.length === 2 && a === 'settings') {
      if (method === 'GET') return json(await settingsGet(env));
      if (method === 'PUT') return json(await settingsPut(env, await readBody(req)));
    }

    if (a === 'blocklist') {
      if (seg.length === 2 && method === 'GET') return json(await blocklistGet(env));
      if (seg.length === 2 && method === 'POST') return json(await blocklistAdd(env, await readBody(req)), 201);
      if (seg.length === 3 && method === 'DELETE') {
        const id = Number(b);
        if (!Number.isInteger(id) || id <= 0) throw notFound('找不到這筆黑名單');
        return json(await blocklistDelete(env, id));
      }
    }

    if (seg.length === 2 && a === 'pause' && method === 'POST') return json(await pauseNow(env, await readBody(req)));
    if (seg.length === 2 && a === 'resume' && method === 'POST') {
      await resume(env);
      return json({ ok: true, pause: await activePause(env) });
    }

    if (seg.length === 2 && a === 'usage' && method === 'GET') return json(await usage(env));

    if (seg.length === 3 && a === 'data' && b === 'delete-author' && method === 'POST') {
      return json(await deleteAuthor(env, await readBody(req)));
    }

    if (seg.length === 3 && a === 'jobs' && b === 'run' && method === 'POST') {
      return json(await runJob(env, ctx, await readBody(req)));
    }

    return json({ error: 'not_found', message: '沒有這個 API' }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.code, message: err.message, ...(err.extra ?? {}) }, err.status);
    console.error('api error', method, path, err);
    return json({ error: 'internal_error', message: '伺服器出錯了，等一下再試' }, 500);
  }
}

// ---------- 總覽 ----------

async function overview(env: Env) {
  const now = Date.now();
  const since90 = taipeiDate(now - 90 * DAY);
  const since30 = taipeiDate(now - 29 * DAY);
  const todayStart = startOfTaipeiDay(now);

  const [dailyRes, weekRes, openedRes] = await env.DB.batch([
    env.DB.prepare('SELECT date, followers_count, views FROM own_daily WHERE date >= ?1 ORDER BY date').bind(since90),
    env.DB.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(s.views), 0) AS v, COUNT(s.views) AS n
       FROM posted_comments pc
       LEFT JOIN reply_snapshots s ON s.posted_id = pc.id AND s.milestone = '24h'
       WHERE pc.posted_at >= ?1`,
    ).bind(now - 7 * DAY),
    env.DB.prepare('SELECT COUNT(DISTINCT target_id) AS c FROM comment_drafts WHERE opened_at >= ?1').bind(todayStart),
  ]);
  const settings = await getSettings(env);
  const [threads, pause] = await Promise.all([safeTokenStatus(env), activePause(env, now)]);

  const daily = (dailyRes.results ?? []) as { date: string; followers_count: number | null; views: number | null }[];
  const followersSeries = daily
    .filter((r) => r.followers_count != null)
    .map((r) => ({ date: r.date, followers: r.followers_count as number }));
  const profileViewsSeries = daily.filter((r) => r.date >= since30).map((r) => ({ date: r.date, views: r.views }));

  const last = followersSeries[followersSeries.length - 1] ?? null;
  const deltaFor = (days: number): number | null => {
    if (!last) return null;
    const target = addDays(last.date, -days);
    let base: { date: string; followers: number } | null = null;
    for (const p of followersSeries) {
      if (p.date <= target) base = p;
      else break;
    }
    return base ? last.followers - base.followers : null;
  };

  const week = (weekRes.results?.[0] ?? { c: 0, v: 0, n: 0 }) as { c: number; v: number; n: number };
  const opened = ((openedRes.results?.[0] ?? { c: 0 }) as { c: number }).c;

  return {
    followers: { today: last?.followers ?? null, asOf: last?.date ?? null, delta7: deltaFor(7), delta30: deltaFor(30) },
    followersSeries,
    profileViewsSeries,
    week: { comments: week.c, totalViews24h: week.v, withSnapshot24h: week.n },
    threads,
    pause,
    today: {
      opened,
      cap: dailyCapFor(settings, now),
      nextAllowedAt: settings.next_allowed_at > now ? settings.next_allowed_at : null,
      nightStart: settings.night_start,
      nightEnd: settings.night_end,
    },
  };
}

// ---------- 留言紀錄 ----------

interface CommentRow {
  id: number; threads_media_id: string; text: string; permalink: string | null; posted_at: number;
  similarity: number | null; status: string; missing_at: number | null;
  author_username: string | null; target_url: string | null; keyword: string | null;
  idx: number | null; persona_name: string | null;
  v1: number | null; l1: number | null; r1: number | null;
  v24: number | null; l24: number | null; r24: number | null;
  v72: number | null; l72: number | null; r72: number | null;
}

async function comments(env: Env, url: URL) {
  const limit = intParam(url, 'limit', 50, 1, 200);
  const offset = intParam(url, 'offset', 0, 0, 100_000);
  const now = Date.now();

  const [rowsRes, totalRes, unmatchedRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT pc.id, pc.threads_media_id, pc.text, pc.permalink, pc.posted_at, pc.similarity, pc.status, pc.missing_at,
              t.author_username, t.url AS target_url, COALESCE(b.keyword, t.keyword) AS keyword,
              d.idx, p.name AS persona_name,
              s1.views AS v1, s1.likes AS l1, s1.replies AS r1,
              s24.views AS v24, s24.likes AS l24, s24.replies AS r24,
              s72.views AS v72, s72.likes AS l72, s72.replies AS r72
       FROM posted_comments pc
       LEFT JOIN targets t ON t.id = pc.target_id
       LEFT JOIN comment_drafts d ON d.id = pc.draft_id
       LEFT JOIN draft_batches b ON b.id = d.batch_id
       LEFT JOIN personas p ON p.id = b.persona_id
       LEFT JOIN reply_snapshots s1 ON s1.posted_id = pc.id AND s1.milestone = '1h'
       LEFT JOIN reply_snapshots s24 ON s24.posted_id = pc.id AND s24.milestone = '24h'
       LEFT JOIN reply_snapshots s72 ON s72.posted_id = pc.id AND s72.milestone = '72h'
       ORDER BY pc.posted_at DESC
       LIMIT ?1 OFFSET ?2`,
    ).bind(limit, offset),
    env.DB.prepare('SELECT COUNT(*) AS c FROM posted_comments'),
    env.DB.prepare(
      `SELECT d.id, d.text, d.idx, d.opened_at, d.mentions_product,
              t.author_username, t.url AS target_url, COALESCE(b.keyword, t.keyword) AS keyword, p.name AS persona_name
       FROM comment_drafts d
       LEFT JOIN targets t ON t.id = d.target_id
       LEFT JOIN draft_batches b ON b.id = d.batch_id
       LEFT JOIN personas p ON p.id = b.persona_id
       WHERE d.status = 'opened' AND d.opened_at >= ?1
         AND NOT EXISTS (SELECT 1 FROM posted_comments pc WHERE pc.draft_id = d.id OR pc.target_id = d.target_id)
       ORDER BY d.opened_at DESC
       LIMIT 50`,
    ).bind(now - 72 * HOUR),
  ]);

  const snap = (v: number | null, l: number | null, r: number | null) => (v == null && l == null && r == null ? null : { views: v, likes: l, replies: r });

  const rows = ((rowsRes.results ?? []) as unknown as CommentRow[]).map((r) => ({
    id: r.id,
    mediaId: r.threads_media_id,
    text: r.text,
    permalink: r.permalink,
    postedAt: r.posted_at,
    similarity: r.similarity,
    status: r.status,
    missingAt: r.missing_at,
    target: { author: r.author_username, url: r.target_url, keyword: r.keyword },
    persona: r.persona_name,
    draftIdx: r.idx,
    snapshots: { '1h': snap(r.v1, r.l1, r.r1), '24h': snap(r.v24, r.l24, r.r24), '72h': snap(r.v72, r.l72, r.r72) },
  }));

  const openedUnmatched = ((unmatchedRes.results ?? []) as {
    id: string; text: string; idx: number; opened_at: number; mentions_product: number;
    author_username: string | null; target_url: string | null; keyword: string | null; persona_name: string | null;
  }[]).map((d) => ({
    draftId: d.id,
    text: d.text,
    draftIdx: d.idx,
    openedAt: d.opened_at,
    mentionsProduct: d.mentions_product === 1,
    target: { author: d.author_username, url: d.target_url, keyword: d.keyword },
    persona: d.persona_name,
  }));

  const total = ((totalRes.results?.[0] ?? { c: 0 }) as { c: number }).c;
  return { rows, total, limit, offset, opened_unmatched: openedUnmatched };
}

// ---------- 人設 × 關鍵字 ----------

async function breakdown(env: Env) {
  const now = Date.now();
  const since = now - 90 * DAY;
  const firstDay = taipeiDate(now - 29 * DAY);

  const [postedRes, dailyRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT pc.posted_at, p.name AS persona_name, COALESCE(b.keyword, t.keyword) AS keyword,
              s.views AS v24, s.likes AS l24
       FROM posted_comments pc
       LEFT JOIN targets t ON t.id = pc.target_id
       LEFT JOIN comment_drafts d ON d.id = pc.draft_id
       LEFT JOIN draft_batches b ON b.id = d.batch_id
       LEFT JOIN personas p ON p.id = b.persona_id
       LEFT JOIN reply_snapshots s ON s.posted_id = pc.id AND s.milestone = '24h'
       WHERE pc.posted_at >= ?1
       ORDER BY pc.posted_at DESC
       LIMIT 3000`,
    ).bind(since),
    env.DB.prepare('SELECT date, followers_count, views FROM own_daily WHERE date >= ?1 ORDER BY date').bind(addDays(firstDay, -1)),
  ]);

  const posted = (postedRes.results ?? []) as {
    posted_at: number; persona_name: string | null; keyword: string | null; v24: number | null; l24: number | null;
  }[];

  const group = (keyOf: (r: (typeof posted)[number]) => string) => {
    const m = new Map<string, { comments: number; views: number[]; likes: number[] }>();
    for (const r of posted) {
      const k = keyOf(r);
      const g = m.get(k) ?? { comments: 0, views: [], likes: [] };
      g.comments++;
      if (r.v24 != null) g.views.push(r.v24);
      if (r.l24 != null) g.likes.push(r.l24);
      m.set(k, g);
    }
    return [...m.entries()]
      .map(([name, g]) => ({
        name,
        comments: g.comments,
        withSnapshot24h: g.views.length,
        medianViews24h: median(g.views),
        avgLikes24h: avg(g.likes),
      }))
      .sort((x, y) => y.comments - x.comments);
  };

  const byPersona = group((r) => r.persona_name ?? '（人設已刪除或沒記到）').map(({ name, ...rest }) => ({ persona: name, ...rest }));
  const byKeyword = group((r) => r.keyword?.trim() || '（沒有關鍵字）').map(({ name, ...rest }) => ({ keyword: name, ...rest }));

  const perDay = new Map<string, number>();
  for (const r of posted) {
    const d = taipeiDate(r.posted_at);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const own = new Map<string, { followers: number | null; views: number | null }>();
  for (const r of (dailyRes.results ?? []) as { date: string; followers_count: number | null; views: number | null }[]) {
    own.set(r.date, { followers: r.followers_count, views: r.views });
  }
  const daily: { date: string; comments: number; followersDelta: number | null; profileViews: number | null }[] = [];
  for (let i = 0; i < 30; i++) {
    const date = addDays(firstDay, i);
    const cur = own.get(date);
    const prev = own.get(addDays(date, -1));
    daily.push({
      date,
      comments: perDay.get(date) ?? 0,
      followersDelta: cur?.followers != null && prev?.followers != null ? cur.followers - prev.followers : null,
      profileViews: cur?.views ?? null,
    });
  }

  return {
    rangeDays: 90,
    byPersona,
    byKeyword,
    daily,
    attributionNote: '粉絲增減是整個帳號當天的變化，不是單則留言帶來的',
  };
}

// ---------- 我的貼文 ----------

async function posts(env: Env) {
  const since = Date.now() - 90 * DAY;
  const { results } = await env.DB.prepare(
    `SELECT op.media_id, op.shortcode, op.permalink, op.text, op.media_type, op.posted_at, op.topic,
            s.date AS snap_date, s.views, s.likes, s.replies, s.reposts, s.quotes, s.shares
     FROM own_posts op
     LEFT JOIN own_post_snapshots s ON s.media_id = op.media_id
       AND s.date = (SELECT MAX(date) FROM own_post_snapshots x WHERE x.media_id = op.media_id)
     WHERE op.posted_at >= ?1
     ORDER BY op.posted_at DESC
     LIMIT 400`,
  )
    .bind(since)
    .all<{
      media_id: string; shortcode: string | null; permalink: string | null; text: string | null; media_type: string | null;
      posted_at: number; topic: string | null; snap_date: string | null; views: number | null; likes: number | null;
      replies: number | null; reposts: number | null; quotes: number | null; shares: number | null;
    }>();

  const rows = (results ?? []).map((r) => ({
    mediaId: r.media_id,
    permalink: r.permalink,
    text: r.text ? r.text.slice(0, 500) : null,
    mediaType: r.media_type,
    postedAt: r.posted_at,
    topic: r.topic,
    snapshot: r.snap_date
      ? { date: r.snap_date, views: r.views, likes: r.likes, replies: r.replies, reposts: r.reposts, quotes: r.quotes, shares: r.shares }
      : null,
  }));

  // 星期（一＝0 … 日＝6）× 2 小時一格，台北時間
  const acc: { count: number; views: number[] }[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 12 }, () => ({ count: 0, views: [] as number[] })),
  );
  for (const r of rows) {
    const d = new Date(r.postedAt + TAIPEI_OFFSET_MS);
    const weekday = (d.getUTCDay() + 6) % 7;
    const slot = Math.floor(d.getUTCHours() / 2);
    const cell = acc[weekday][slot];
    cell.count++;
    if (r.snapshot?.views != null) cell.views.push(r.snapshot.views);
  }
  const cells = acc.map((row) =>
    row.map((c) => ({ count: c.count, withViews: c.views.length, avgViews: c.views.length ? Math.round(avg(c.views) as number) : null })),
  );

  return {
    rows,
    heatmap: {
      rows: 7,
      cols: 12,
      weekdayLabels: ['一', '二', '三', '四', '五', '六', '日'],
      slotHours: 2,
      cells,
      sample: rows.length,
      withViews: rows.filter((r) => r.snapshot?.views != null).length,
    },
  };
}

// ---------- 人設 ----------

function strArray(v: unknown, field: string, maxItems: number, maxLen: number): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad(`${field}要是文字清單`);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') throw bad(`${field}裡只能放文字`);
    const t = x.trim();
    if (!t) continue;
    if (t.length > maxLen) throw bad(`${field}每一項最多 ${maxLen} 個字`);
    out.push(t);
  }
  if (out.length > maxItems) throw bad(`${field}最多 ${maxItems} 項`);
  return [...new Set(out)];
}

interface PersonaInput {
  name: string; tone: string; identityNote: string | null; bannedWords: string[]; examples: string[];
  isActive: boolean; sortOrder: number;
}

function validatePersona(body: Record<string, unknown>, base?: Persona): PersonaInput {
  const pick = <T>(k: string, fallback: T): unknown => (k in body ? body[k] : fallback);

  const name = pick('name', base?.name ?? '');
  if (typeof name !== 'string' || !name.trim()) throw bad('人設要有名稱');
  if (name.trim().length > 20) throw bad('名稱最多 20 個字');

  const tone = pick('tone', base?.tone ?? '');
  if (typeof tone !== 'string' || !tone.trim()) throw bad('要寫語氣說明');
  if (tone.trim().length > 500) throw bad('語氣說明最多 500 個字');

  const idn = pick('identityNote', base?.identityNote ?? null);
  if (idn != null && typeof idn !== 'string') throw bad('真實身分要是文字');
  const identityNote = typeof idn === 'string' && idn.trim() ? idn.trim() : null;
  if (identityNote && identityNote.length > 300) throw bad('真實身分最多 300 個字');

  const bannedWords = strArray(pick('bannedWords', base?.bannedWords ?? []), '禁用詞', 100, 30);
  const examples = strArray(pick('examples', base?.examples ?? []), '範例留言', 10, 300);

  const act = pick('isActive', base?.isActive ?? true);
  if (typeof act !== 'boolean') throw bad('啟用要是 true 或 false');

  const so = pick('sortOrder', base?.sortOrder ?? 0);
  if (typeof so !== 'number' || !Number.isInteger(so) || so < 0 || so > 9999) throw bad('排序要是 0 到 9999 的整數');

  return { name: name.trim(), tone: tone.trim(), identityNote, bannedWords, examples, isActive: act, sortOrder: so };
}

async function personasList(env: Env) {
  const [personas, active] = await Promise.all([listPersonas(env), getActivePersona(env)]);
  return { personas, activeId: active?.id ?? null };
}

async function personaCreate(env: Env, body: Record<string, unknown>) {
  const p = validatePersona(body);
  const now = Date.now();
  try {
    const row = await env.DB.prepare(
      `INSERT INTO personas (name, tone, identity_note, banned_words, examples, is_active, sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) RETURNING *`,
    )
      .bind(p.name, p.tone, p.identityNote, JSON.stringify(p.bannedWords), JSON.stringify(p.examples), p.isActive ? 1 : 0, p.sortOrder, now)
      .first<Parameters<typeof rowToPersona>[0]>();
    if (!row) throw new Error('insert returned nothing');
    return { persona: rowToPersona(row) };
  } catch (err) {
    if (isUniqueError(err)) throw new HttpError(409, 'conflict', '已經有同名的人設');
    throw err;
  }
}

async function personaUpdate(env: Env, id: number, body: Record<string, unknown>) {
  const existing = await env.DB.prepare('SELECT * FROM personas WHERE id = ?1').bind(id).first<Parameters<typeof rowToPersona>[0]>();
  if (!existing) throw notFound('找不到這個人設');
  const p = validatePersona(body, rowToPersona(existing));
  try {
    const row = await env.DB.prepare(
      `UPDATE personas SET name = ?2, tone = ?3, identity_note = ?4, banned_words = ?5, examples = ?6,
              is_active = ?7, sort_order = ?8, updated_at = ?9
       WHERE id = ?1 RETURNING *`,
    )
      .bind(id, p.name, p.tone, p.identityNote, JSON.stringify(p.bannedWords), JSON.stringify(p.examples), p.isActive ? 1 : 0, p.sortOrder, Date.now())
      .first<Parameters<typeof rowToPersona>[0]>();
    if (!row) throw notFound('找不到這個人設');
    return { persona: rowToPersona(row) };
  } catch (err) {
    if (isUniqueError(err)) throw new HttpError(409, 'conflict', '已經有同名的人設');
    throw err;
  }
}

async function personaDelete(env: Env, id: number) {
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS c, SUM(CASE WHEN id = ?1 THEN 1 ELSE 0 END) AS hit FROM personas').bind(id).first<{ c: number; hit: number }>();
  if (!cnt?.hit) throw notFound('找不到這個人設');
  if (cnt.c <= 1) throw bad('至少要留一個人設');
  await env.DB.prepare('DELETE FROM personas WHERE id = ?1').bind(id).run();
  const s = await getSettings(env);
  if (s.active_persona_id === id) await setSetting(env, 'active_persona_id', 0);
  return { ok: true };
}

// ---------- 產品資料卡 ----------

interface ProductRow { id: number; title: string; facts: string; cta_hint: string | null; is_active: number; updated_at: number }

function productOut(r: ProductRow | null) {
  if (!r) return null;
  let facts: string[] = [];
  try {
    const v = JSON.parse(r.facts);
    if (Array.isArray(v)) facts = v.filter((x) => typeof x === 'string');
  } catch {
    facts = [];
  }
  return { id: r.id, title: r.title, facts, ctaHint: r.cta_hint, isActive: r.is_active === 1, updatedAt: r.updated_at };
}

async function productGet(env: Env) {
  const r = await env.DB.prepare('SELECT * FROM product_facts ORDER BY is_active DESC, id LIMIT 1').first<ProductRow>();
  return { product: productOut(r) };
}

async function productPut(env: Env, body: Record<string, unknown>) {
  const title = body.title;
  if (typeof title !== 'string' || !title.trim()) throw bad('產品要有標題');
  if (title.trim().length > 60) throw bad('標題最多 60 個字');
  const facts = strArray(body.facts, '產品事實', 30, 200);
  const cta = body.ctaHint;
  if (cta != null && typeof cta !== 'string') throw bad('導流提示要是文字');
  const ctaHint = typeof cta === 'string' && cta.trim() ? cta.trim() : null;
  if (ctaHint && ctaHint.length > 60) throw bad('導流提示最多 60 個字');
  // 跟留言草稿同一條規則：卡上有網域的話，帶到產品的留言會整則被丟掉
  if ([title, ctaHint ?? '', ...facts].some((s) => containsLinkOrDomain(s))) throw bad('產品資料卡不要放網址或網域，留言裡本來就不放');
  const isActive = body.isActive == null ? true : body.isActive;
  if (typeof isActive !== 'boolean') throw bad('啟用要是 true 或 false');

  const now = Date.now();
  const existing = await env.DB.prepare('SELECT id FROM product_facts ORDER BY is_active DESC, id LIMIT 1').first<{ id: number }>();
  let row: ProductRow | null;
  if (existing) {
    row = await env.DB.prepare(
      'UPDATE product_facts SET title = ?2, facts = ?3, cta_hint = ?4, is_active = ?5, updated_at = ?6 WHERE id = ?1 RETURNING *',
    )
      .bind(existing.id, title.trim(), JSON.stringify(facts), ctaHint, isActive ? 1 : 0, now)
      .first<ProductRow>();
  } else {
    row = await env.DB.prepare(
      'INSERT INTO product_facts (title, facts, cta_hint, is_active, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *',
    )
      .bind(title.trim(), JSON.stringify(facts), ctaHint, isActive ? 1 : 0, now)
      .first<ProductRow>();
  }
  return { product: productOut(row) };
}

// ---------- 設定 ----------

async function settingsGet(env: Env) {
  const settings = await getSettings(env);
  return { settings, editable: EDITABLE_KEYS, models: ALLOWED_MODELS, prices: MODEL_PRICES, usdToTwd: USD_TO_TWD };
}

const INTEGER_KEYS = new Set<keyof Settings>([
  'daily_cap_first14', 'daily_cap', 'hourly_cap', 'min_interval_min', 'max_interval_min', 'same_author_days',
  'reopen_grace_min', 'product_every', 'missing_pause_threshold', 'auto_pause_hours', 'push_warn_at',
  'started_at', 'active_persona_id',
]);

async function settingsPut(env: Env, body: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  const updates: [keyof Settings, Settings[keyof Settings]][] = [];
  const editable = new Set<string>(EDITABLE_KEYS as string[]);

  for (const [k, v] of Object.entries(body)) {
    if (!editable.has(k)) {
      errors[k] = `${k} 不能在後台改`;
      continue;
    }
    const key = k as keyof Settings;
    const msg = validateSetting(key, v);
    if (msg) {
      errors[k] = msg;
      continue;
    }
    if (INTEGER_KEYS.has(key) && !Number.isInteger(v)) {
      errors[k] = '要是整數';
      continue;
    }
    if (key === 'product_every' && (v as number) < 1) {
      errors[k] = '至少是 1';
      continue;
    }
    updates.push([key, v as Settings[keyof Settings]]);
  }

  if (!updates.length && !Object.keys(errors).length) throw bad('沒有要改的設定');

  const current = await getSettings(env);
  const merged: Settings = { ...current };
  for (const [k, v] of updates) (merged as unknown as Record<string, unknown>)[k] = v;

  if (merged.min_interval_min > merged.max_interval_min) {
    errors.min_interval_min = '間隔下限不能大於上限';
  }
  const personaUpdate = updates.find(([k]) => k === 'active_persona_id');
  if (personaUpdate && (personaUpdate[1] as number) > 0) {
    const p = await env.DB.prepare('SELECT is_active FROM personas WHERE id = ?1').bind(personaUpdate[1]).first<{ is_active: number }>();
    if (!p) errors.active_persona_id = '找不到這個人設';
    else if (p.is_active !== 1) errors.active_persona_id = '這個人設停用中，先啟用再設為使用中';
  }

  if (Object.keys(errors).length) {
    throw bad(Object.values(errors)[0], { errors });
  }

  for (const [k, v] of updates) await setSetting(env, k, v as never);
  return { ok: true, settings: merged };
}

// ---------- 黑名單 ----------

async function blocklistGet(env: Env) {
  const { results } = await env.DB.prepare('SELECT id, kind, value, reason, created_at FROM blocklist ORDER BY created_at DESC LIMIT 500').all<{
    id: number; kind: string; value: string; reason: string | null; created_at: number;
  }>();
  return { items: (results ?? []).map((r) => ({ id: r.id, kind: r.kind, value: r.value, reason: r.reason, createdAt: r.created_at })) };
}

async function blocklistAdd(env: Env, body: Record<string, unknown>) {
  const kind = body.kind;
  if (kind !== 'author' && kind !== 'shortcode') throw bad('種類只能是作者或貼文');
  const rawValue = body.value;
  if (typeof rawValue !== 'string' || !rawValue.trim()) throw bad('要填作者帳號或貼文網址');
  const reasonRaw = body.reason;
  if (reasonRaw != null && typeof reasonRaw !== 'string') throw bad('原因要是文字');
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim().slice(0, 100) : null;

  let value = rawValue.trim();
  const parsed = /threads\.(com|net)/i.test(value) ? parseThreadsPostUrl(value) : null;
  if (kind === 'author') {
    if (parsed) {
      if (!parsed.author) throw bad('這個網址看不出作者，請直接填 @帳號');
      value = parsed.author;
    } else {
      const m = value.match(/threads\.(?:com|net)\/@([\w.]+)/i);
      if (m) value = m[1];
    }
    value = normalizeUsername(value);
    if (!/^[a-z0-9._]{1,40}$/.test(value)) throw bad('作者帳號只能有英數字、底線和點');
  } else {
    if (parsed) value = parsed.shortcode;
    if (!/^[A-Za-z0-9_-]{5,40}$/.test(value)) throw bad('貼文請貼 Threads 網址，或填網址最後那段代碼');
  }

  try {
    const row = await env.DB.prepare('INSERT INTO blocklist (kind, value, reason, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id, kind, value, reason, created_at')
      .bind(kind, value, reason, Date.now())
      .first<{ id: number; kind: string; value: string; reason: string | null; created_at: number }>();
    return { item: row ? { id: row.id, kind: row.kind, value: row.value, reason: row.reason, createdAt: row.created_at } : null };
  } catch (err) {
    if (isUniqueError(err)) throw new HttpError(409, 'conflict', '已經在黑名單裡了');
    throw err;
  }
}

async function blocklistDelete(env: Env, id: number) {
  const r = await env.DB.prepare('DELETE FROM blocklist WHERE id = ?1').bind(id).run();
  if (!r.meta.changes) throw notFound('找不到這筆黑名單');
  return { ok: true };
}

// ---------- 暫停 ----------

async function pauseNow(env: Env, body: Record<string, unknown>) {
  const hours = body.hours == null ? 24 : body.hours;
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 720) throw bad('暫停時數要在 1 到 720 小時之間');
  const { untilAt } = await pauseFor(env, hours, '後台手動暫停', 'manual');
  return { ok: true, untilAt, pause: await activePause(env) };
}

// ---------- 用量 ----------

async function usage(env: Env) {
  const now = Date.now();
  const monthStart = taipeiMonthStart(now);
  const since30 = startOfTaipeiDay(now - 29 * DAY);

  const [byDayRes, byPurposeRes, byModelRes, jobsRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT date((created_at + ${TAIPEI_OFFSET_MS}) / 1000, 'unixepoch') AS d, SUM(cost_usd) AS c, COUNT(*) AS n
       FROM llm_usage WHERE created_at >= ?1 GROUP BY d ORDER BY d`,
    ).bind(since30),
    env.DB.prepare(
      `SELECT purpose, COUNT(*) AS n, SUM(cost_usd) AS c, SUM(input_tokens) AS it, SUM(output_tokens) AS ot
       FROM llm_usage WHERE created_at >= ?1 GROUP BY purpose ORDER BY c DESC`,
    ).bind(monthStart),
    env.DB.prepare(
      `SELECT model, COUNT(*) AS n, SUM(cost_usd) AS c FROM llm_usage WHERE created_at >= ?1 GROUP BY model ORDER BY c DESC`,
    ).bind(monthStart),
    env.DB.prepare('SELECT id, job, ok, detail, created_at FROM job_log ORDER BY id DESC LIMIT 30'),
  ]);

  const settings = await getSettings(env);
  const [monthCost, pushUsed, token] = await Promise.all([monthLlmCostUsd(env, now), monthPushCount(env, now), safeTokenStatus(env)]);
  let quota: { limit: number | null; used: number | null } = { limit: null, used: null };
  try {
    quota = await new LineClient(env).getQuota();
  } catch (err) {
    console.error('getQuota failed', err);
  }

  const dayMap = new Map<string, { c: number; n: number }>();
  for (const r of (byDayRes.results ?? []) as { d: string; c: number; n: number }[]) dayMap.set(r.d, { c: r.c ?? 0, n: r.n ?? 0 });
  const byDay: { date: string; costUsd: number; calls: number }[] = [];
  const first = taipeiDate(since30);
  for (let i = 0; i < 30; i++) {
    const date = addDays(first, i);
    const v = dayMap.get(date);
    byDay.push({ date, costUsd: v?.c ?? 0, calls: v?.n ?? 0 });
  }

  return {
    usdToTwd: USD_TO_TWD,
    llm: {
      monthCostUsd: monthCost,
      budgetUsd: settings.monthly_budget_usd,
      model: settings.llm_model,
      byDay,
      byPurpose: ((byPurposeRes.results ?? []) as { purpose: string; n: number; c: number; it: number; ot: number }[]).map((r) => ({
        purpose: r.purpose, calls: r.n, costUsd: r.c ?? 0, inputTokens: r.it ?? 0, outputTokens: r.ot ?? 0,
      })),
      byModel: ((byModelRes.results ?? []) as { model: string; n: number; c: number }[]).map((r) => ({ model: r.model, calls: r.n, costUsd: r.c ?? 0 })),
    },
    push: { usedThisMonth: pushUsed, warnAt: settings.push_warn_at, quota },
    threads: token,
    jobs: ((jobsRes.results ?? []) as { id: number; job: string; ok: number; detail: string | null; created_at: number }[]).map((r) => ({
      id: r.id, job: r.job, ok: r.ok === 1, detail: r.detail ? r.detail.slice(0, 300) : null, createdAt: r.created_at,
    })),
  };
}

// ---------- 刪除某位作者的資料 ----------

async function deleteAuthor(env: Env, body: Record<string, unknown>) {
  const raw = body.username;
  if (typeof raw !== 'string' || !raw.trim()) throw bad('要填 Threads 帳號');
  let username = raw.trim();
  const m = username.match(/threads\.(?:com|net)\/@([\w.]+)/i);
  if (m) username = m[1];
  username = normalizeUsername(username);
  if (!/^[a-z0-9._]{1,40}$/.test(username)) throw bad('帳號只能有英數字、底線和點');

  const targetsSql = 'SELECT id FROM targets WHERE lower(author_username) = ?1';
  const draftsSql = `SELECT id FROM comment_drafts WHERE target_id IN (${targetsSql})`;
  const res = await env.DB.batch([
    env.DB.prepare(`DELETE FROM link_clicks WHERE draft_id IN (${draftsSql})`).bind(username),
    env.DB.prepare(`UPDATE posted_comments SET target_id = NULL, draft_id = NULL WHERE target_id IN (${targetsSql})`).bind(username),
    env.DB.prepare(`DELETE FROM comment_drafts WHERE target_id IN (${targetsSql})`).bind(username),
    env.DB.prepare(`DELETE FROM draft_batches WHERE target_id IN (${targetsSql})`).bind(username),
    env.DB.prepare('DELETE FROM targets WHERE lower(author_username) = ?1').bind(username),
    env.DB.prepare(
      `UPDATE conversation_state SET pending_url = NULL, pending_shortcode = NULL, pending_author = NULL, pending_at = NULL, updated_at = ?2
       WHERE lower(pending_author) = ?1`,
    ).bind(username, Date.now()),
  ]);
  const n = (i: number) => res[i]?.meta?.changes ?? 0;
  const rows = { clicks: n(0), postedUnlinked: n(1), drafts: n(2), batches: n(3), targets: n(4) };
  await logJob(env, 'delete_author', true, `targets=${rows.targets} drafts=${rows.drafts} batches=${rows.batches} clicks=${rows.clicks} unlinked=${rows.postedUnlinked}`);
  return { deleted: rows.targets, rows, username };
}

// ---------- 手動執行排程 ----------

const JOB_LABEL = { hourly: '每小時比對', daily: '每日快照', morning: '早報', weekly: '每週續期與清理' } as const;
type JobName = keyof typeof JOB_LABEL;

async function runJob(env: Env, ctx: ExecutionContext, body: Record<string, unknown>) {
  const job = body.job;
  if (typeof job !== 'string' || !(job in JOB_LABEL)) throw bad('job 只能是 hourly、daily、morning、weekly');
  const name = job as JobName;
  const started = Date.now();
  try {
    let detail: unknown;
    if (name === 'hourly') detail = await runHourly(env, ctx);
    else if (name === 'daily') detail = await runDaily(env, ctx);
    else if (name === 'morning') detail = await runMorning(env);
    else detail = await runWeekly(env);
    const summary = typeof detail === 'string' ? detail : '完成';
    // 跟排程用同一個名字記，健康檢查才看得到；detail 標註是手動
    await logJob(env, name, true, `手動執行：${summary}`);
    return { ok: true, job: name, label: JOB_LABEL[name], summary, ms: Date.now() - started };
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 300);
    console.error('manual job failed', name, err);
    await logJob(env, name, false, `手動執行：${message}`);
    return { ok: false, job: name, label: JOB_LABEL[name], summary: message, ms: Date.now() - started };
  }
}
