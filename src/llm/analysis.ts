// /關鍵字、/主題：只用 Max 自己帳號的貼文與數據（own_posts + 最新一次 own_post_snapshots）。
// 模型只負責歸納與分類；數字（篇數、平均觀看、中位數）全部由程式算，不讓模型編。
import type { Env } from '../env';
import { getSettings } from '../lib/settings';
import { DAY } from '../lib/time';
import { callClaudeJson, overBudget } from './claude';
import {
  KEYWORDS_SCHEMA,
  KEYWORDS_SYSTEM,
  TOPICS_SCHEMA,
  TOPICS_SYSTEM,
  buildKeywordsUserText,
  buildTopicsUserText,
  type AnalysisPost,
  type RawKeywordsOutput,
  type RawTopicsOutput,
} from './prompts';

const NOT_ENOUGH = '資料還不夠：至少要有 5 篇有數據的貼文。先到後台連結 Threads，等每日快照跑過一次。';
const MIN_POSTS = 5;
const MAX_POSTS = 60;

interface PostRow {
  media_id: string;
  text: string;
  posted_at: number;
  views: number | null;
  likes: number | null;
}

// 近 90 天、有文字、至少有一次快照的貼文，附最新快照的數字
async function loadPosts(env: Env, now: number): Promise<PostRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.media_id, p.text, p.posted_at, s.views, s.likes
       FROM own_posts p
       JOIN own_post_snapshots s
         ON s.media_id = p.media_id
        AND s.date = (SELECT MAX(date) FROM own_post_snapshots WHERE media_id = p.media_id)
      WHERE p.posted_at >= ?1 AND p.text IS NOT NULL AND TRIM(p.text) != ''
      ORDER BY p.posted_at DESC
      LIMIT ?2`,
  )
    .bind(now - 90 * DAY, MAX_POSTS)
    .all<PostRow>();
  return (results ?? []).map((r) => ({ ...r, text: String(r.text).slice(0, 400) }));
}

export function fmtInt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function clipChars(s: string, n: number): string {
  const c = Array.from(s.trim());
  return c.length > n ? c.slice(0, n).join('') : c.join('');
}

function llmFailText(message: string): string {
  return `這次分析沒成功（${message}），等一下再試一次。`;
}

async function budgetText(env: Env, settings: Awaited<ReturnType<typeof getSettings>>): Promise<string | null> {
  const over = await overBudget(env, settings);
  return over ? `本月 Claude 已花 US$${over.spentUsd.toFixed(2)}，到上限 US$${over.budgetUsd.toFixed(2)} 了，分析先停。` : null;
}

// ---------- /關鍵字 ----------

export async function analyzeKeywords(env: Env): Promise<string> {
  const now = Date.now();
  const settings = await getSettings(env);
  const rows = await loadPosts(env, now);
  if (rows.length < MIN_POSTS) return NOT_ENOUGH;
  const b = await budgetText(env, settings);
  if (b) return b;

  // 照觀看排，同觀看再看讚
  const sorted = [...rows].sort((a, c) => (c.views ?? 0) - (a.views ?? 0) || (c.likes ?? 0) - (a.likes ?? 0));
  const posts: AnalysisPost[] = sorted.map((r, i) => ({ idx: i + 1, text: r.text, views: r.views, likes: r.likes }));

  const r = await callClaudeJson<RawKeywordsOutput>(env, {
    purpose: 'keywords',
    system: KEYWORDS_SYSTEM,
    content: [{ type: 'text', text: buildKeywordsUserText(posts) }],
    schema: KEYWORDS_SCHEMA,
    maxTokens: 6000,
    effort: 'low',
    settings,
  });
  if (!r.ok) return llmFailText(r.message);

  const seen = new Set<string>();
  const items: { keyword: string; why: string }[] = [];
  for (const k of Array.isArray(r.data?.keywords) ? r.data.keywords : []) {
    const keyword = clipChars(String(k?.keyword ?? '').replace(/^[#＃]+/, ''), 20);
    const why = clipChars(String(k?.why ?? '').replace(/\s+/g, ' '), 40);
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    items.push({ keyword, why });
    if (items.length >= 8) break;
  }
  if (items.length === 0) return llmFailText('沒有整理出關鍵字');

  const lines = [`從你近 90 天表現好的貼文整理出的關鍵字（共看了 ${rows.length} 篇）：`];
  items.forEach((k, i) => lines.push(`${i + 1}. ${k.keyword}${k.why ? `　${k.why}` : ''}`));
  lines.push('');
  lines.push(`用法：/海巡 ${items[0].keyword}`);
  return lines.join('\n');
}

// ---------- /主題 ----------

export interface TopicStat {
  name: string;
  mediaIds: string[];
  count: number;
  avgViews: number;
  underWritten: boolean; // 表現好但寫太少
}

// 純函式：模型給的分類 → 每個主題的篇數、平均觀看、是否「表現好但寫太少」。
// 每篇只算一次（先出現的主題優先）；編號超出範圍的丟掉；沒分到貼文的主題丟掉。
export function computeTopicStats(
  raw: { name: string; post_indexes: number[] }[],
  posts: { mediaId: string; views: number | null }[],
): TopicStat[] {
  const used = new Set<number>();
  const topics: { name: string; idxs: number[] }[] = [];
  const names = new Set<string>();
  for (const t of Array.isArray(raw) ? raw : []) {
    const name = clipChars(String(t?.name ?? '').replace(/\s+/g, ' '), 12);
    if (!name) continue;
    const idxs: number[] = [];
    for (const v of Array.isArray(t?.post_indexes) ? t.post_indexes : []) {
      const i = Number(v);
      if (!Number.isInteger(i) || i < 1 || i > posts.length || used.has(i)) continue;
      used.add(i);
      idxs.push(i);
    }
    if (idxs.length === 0) continue;
    const existing = names.has(name) ? topics.find((x) => x.name === name) : undefined;
    if (existing) existing.idxs.push(...idxs);
    else {
      names.add(name);
      topics.push({ name, idxs });
    }
  }

  const stats = topics.map((t) => {
    const views = t.idxs.map((i) => posts[i - 1].views ?? 0);
    return {
      name: t.name,
      mediaIds: t.idxs.map((i) => posts[i - 1].mediaId),
      count: t.idxs.length,
      avgViews: views.reduce((a, b) => a + b, 0) / views.length,
      underWritten: false,
    };
  });
  const medCount = median(stats.map((s) => s.count));
  const medAvg = median(stats.map((s) => s.avgViews));
  const maxCount = Math.max(0, ...stats.map((s) => s.count));
  // 「表現好但寫太少」：平均觀看 ≥ 中位數、篇數 ≤ 中位數，而且不是寫最多的那幾個
  // （各主題篇數一樣多時，沒有誰算「寫太少」）
  for (const s of stats) s.underWritten = s.avgViews >= medAvg && s.count <= medCount && s.count < maxCount;
  return stats.sort((a, b) => b.avgViews - a.avgViews);
}

export async function analyzeTopics(env: Env): Promise<string> {
  const now = Date.now();
  const settings = await getSettings(env);
  const rows = await loadPosts(env, now);
  if (rows.length < MIN_POSTS) return NOT_ENOUGH;
  const b = await budgetText(env, settings);
  if (b) return b;

  const posts: AnalysisPost[] = rows.map((r, i) => ({ idx: i + 1, text: r.text, views: r.views, likes: r.likes }));
  const r = await callClaudeJson<RawTopicsOutput>(env, {
    purpose: 'topics',
    system: TOPICS_SYSTEM,
    content: [{ type: 'text', text: buildTopicsUserText(posts) }],
    schema: TOPICS_SCHEMA,
    maxTokens: 6000,
    effort: 'low',
    settings,
  });
  if (!r.ok) return llmFailText(r.message);

  const stats = computeTopicStats(
    Array.isArray(r.data?.topics) ? r.data.topics : [],
    rows.map((x) => ({ mediaId: x.media_id, views: x.views })),
  );
  if (stats.length < 2) return llmFailText('主題分不出來');

  // 寫回 own_posts.topic：先清掉這批貼文的舊主題，再每個主題一條 UPDATE（D1 單次最多 100 個參數，60 篇夠用）
  try {
    const allIds = rows.map((x) => x.media_id);
    const ph = (n: number, start: number) => Array.from({ length: n }, (_, i) => `?${i + start}`).join(',');
    const stmts = [
      env.DB.prepare(`UPDATE own_posts SET topic = NULL, updated_at = ?1 WHERE media_id IN (${ph(allIds.length, 2)})`).bind(
        now,
        ...allIds,
      ),
      ...stats.map((s) =>
        env.DB.prepare(`UPDATE own_posts SET topic = ?1, updated_at = ?2 WHERE media_id IN (${ph(s.mediaIds.length, 3)})`).bind(
          s.name,
          now,
          ...s.mediaIds,
        ),
      ),
    ];
    await env.DB.batch(stmts);
  } catch (err) {
    console.error('own_posts topic update failed', String(err));
  }

  const lines = [`你的貼文主題（近 90 天，${rows.length} 篇有數據，依平均觀看排）：`];
  for (const s of stats) {
    lines.push(`・${s.name}　${s.count} 篇｜平均觀看 ${fmtInt(s.avgViews)}${s.underWritten ? '　← 表現好但寫太少' : ''}`);
  }
  const under = stats.filter((s) => s.underWritten).map((s) => s.name);
  lines.push('');
  lines.push(under.length ? `可以多寫：${under.join('、')}` : '目前沒有「表現好但寫太少」的主題。');
  lines.push('平均觀看用的是每篇最新一次快照的數字。');
  return lines.join('\n');
}
