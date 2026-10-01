// 每小時 :15：比對已送出的留言（/me/replies ↔ 開過的草稿），抓留言 1h／24h／72h 成效
// 免費版每次呼叫 ≤ 40 個對外請求：回覆最多 3 頁 + insights 最多 25 次 + 推播 ≤ 4 次
// D1 查詢壓低：多筆寫入一律用 json_each 併成一個語句
import type { Env } from '../env';
import type { Settings } from '../lib/settings';
import { getSettings, logJob } from '../lib/settings';
import { DAY, HOUR, taipeiShort, toUnixSeconds } from '../lib/time';
import { LineClient } from '../line/client';
import { activePause, pauseFor } from '../safety/pause';
import { bigramProfile, profileSimilarity } from '../safety/similarity';
import { ThreadsApiError, ThreadsClient, parseThreadsTime, type ThreadsMedia } from '../threads/client';
import { getThreadsToken } from '../threads/token';

const MATCH_MIN = 0.5;
// 回覆時間早於「開草稿」太多就不可能是這則草稿送出的（留 5 分鐘給兩邊時鐘誤差）
export const OPEN_CLOCK_SKEW_MS = 5 * 60_000;
const INSIGHT_CAP = 25;
const FETCH_CAP = 32;           // 留幾個給推播
const REPLY_PAGES = 3;
const MILESTONES: { name: '1h' | '24h' | '72h'; ms: number }[] = [
  { name: '1h', ms: HOUR },
  { name: '24h', ms: 24 * HOUR },
  { name: '72h', ms: 72 * HOUR },
];

export const RATE_LIMIT_REASON = 'Threads API 回報限流';

// ---------- 共用：推播警示、限流暫停 ----------

// 推一則警示給 Max。有 dedupeKey 時，同一個 key 在 withinMs 內只推一次（成功才算）
export async function sendAlert(env: Env, text: string, dedupeKey?: string, withinMs = DAY): Promise<boolean> {
  const job = dedupeKey ? `alert:${dedupeKey}` : 'alert';
  try {
    if (dedupeKey) {
      const seen = await env.DB.prepare('SELECT 1 AS x FROM job_log WHERE job = ?1 AND ok = 1 AND created_at >= ?2 LIMIT 1')
        .bind(job, Date.now() - withinMs)
        .first<{ x: number }>();
      if (seen) return false;
    }
    const r = await new LineClient(env).push(env.LINE_ADMIN_USER_ID, [{ type: 'text', text }], 'alert');
    await logJob(env, job, r.ok, r.ok ? `已送出：${text.slice(0, 80)}` : `送不出去（LINE push ${r.status}）`);
    return r.ok;
  } catch (err) {
    await logJob(env, job, false, String(err).slice(0, 300));
    return false;
  }
}

// 目前是否在「限流」自動暫停中（這段時間不打 Threads API）
export async function isThreadsRateLimitPaused(env: Env, now = Date.now()): Promise<boolean> {
  const r = await env.DB.prepare('SELECT 1 AS x FROM pauses WHERE cleared_at IS NULL AND until_at > ?1 AND reason = ?2 LIMIT 1')
    .bind(now, RATE_LIMIT_REASON)
    .first<{ x: number }>();
  return !!r;
}

export async function handleThreadsRateLimit(env: Env, settings: Settings): Promise<void> {
  if (await isThreadsRateLimitPaused(env)) return;
  let tail = '';
  if (settings.auto_pause_hours > 0) {
    const { untilAt } = await pauseFor(env, settings.auto_pause_hours, RATE_LIMIT_REASON, 'auto');
    tail = `自動暫停到 ${taipeiShort(untilAt)}，這段時間先不要留言。`;
  }
  await sendAlert(env, `Threads API 回報限流。${tail}`.trim(), 'threads_ratelimit', 6 * HOUR);
}

export async function alertThreadsAuth(env: Env): Promise<void> {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  await sendAlert(env, `Threads 授權失效，請到後台重新連結：${base}/`, 'threads_auth', DAY);
}

// ---------- 每小時工作 ----------

export interface MatchCandidate { id: string; text: string; target_id: number; opened_at: number }
export interface MatchReply { id: string; text: string; permalink: string | null; at: number }
export interface ReplyMatch { mediaId: string; draftId: string; targetId: number; text: string; permalink: string | null; postedAt: number; sim: number }
interface DueRow { id: number; threads_media_id: string; posted_at: number; have: string | null }

// 純函式：回覆（照時間由舊到新）↔ 開過的草稿。每則草稿最多配一則回覆，相似度 ≥ 0.5 才算。
// 回覆時間比草稿打開的時間還早（超過 5 分鐘誤差）→ 那是 Max 之前自己手打的，不算
export function matchRepliesToDrafts(replies: MatchReply[], candidates: MatchCandidate[]): ReplyMatch[] {
  const used = new Set<string>();
  const out: ReplyMatch[] = [];
  // 免費版每次只有 10 ms CPU：每段文字的 bigram 只算一次（沒比對到的回覆每小時都會再比一次，最多約 150 × 60 組）
  const candProfiles = candidates.map((c) => bigramProfile(c.text));
  for (const r of replies) {
    const text = r.text.trim();
    if (!text) continue;
    const rp = bigramProfile(text);
    let best: MatchCandidate | null = null;
    let bestSim = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (used.has(c.id)) continue;
      if (r.at < c.opened_at - OPEN_CLOCK_SKEW_MS) continue;
      // Dice 係數 ≥ 0.5 的必要條件是短的至少是長的 1/3；原文含標點與 emoji，放寬到 1/4 再用長度擋，省 CPU
      const a = text.length, b = c.text.length;
      if (Math.min(a, b) * 4 < Math.max(a, b)) continue;
      const sim = profileSimilarity(rp, candProfiles[i]);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (best && bestSim >= MATCH_MIN) {
      used.add(best.id);
      out.push({ mediaId: r.id, draftId: best.id, targetId: best.target_id, text, permalink: r.permalink, postedAt: r.at, sim: Math.round(bestSim * 1000) / 1000 });
    }
  }
  return out;
}

export async function runHourly(env: Env, _ctx: ExecutionContext): Promise<string> {
  const now = Date.now();
  const tok = await getThreadsToken(env);
  if (!tok) return '還沒連結 Threads，沒有比對';
  if (tok.expiresAt <= now) {
    await alertThreadsAuth(env);
    return 'Threads 授權過期了，沒有比對';
  }
  if (await isThreadsRateLimitPaused(env, now)) return 'Threads 限流暫停中，這次不查';

  const settings = await getSettings(env);
  const client = new ThreadsClient(env, tok.accessToken, tok.userId);
  const summary: string[] = [];

  // 1) 讀自己的回覆（72 小時內）
  let replies: ThreadsMedia[];
  try {
    replies = await client.myReplies({ sinceSec: toUnixSeconds(now - 72 * HOUR), limit: 50, maxPages: REPLY_PAGES });
  } catch (err) {
    return await stopOnError(env, settings, err, '讀回覆');
  }

  // 2) 比對：開過（opened）的草稿 ↔ 還沒記錄的回覆
  const [candRes, postedRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, text, target_id, opened_at FROM comment_drafts
        WHERE status = 'opened' AND opened_at >= ?1 ORDER BY opened_at ASC LIMIT 300`,
    ).bind(now - 72 * HOUR),
    env.DB.prepare('SELECT threads_media_id FROM posted_comments WHERE posted_at >= ?1').bind(now - 96 * HOUR),
  ]);
  const candidates = (candRes.results ?? []) as unknown as MatchCandidate[];
  const known = new Set(((postedRes.results ?? []) as { threads_media_id: string }[]).map((r) => r.threads_media_id));

  const fresh: MatchReply[] = replies
    .filter((r) => !known.has(r.id) && r.text && r.text.trim())
    .map((r) => ({ id: r.id, text: r.text!, permalink: r.permalink ?? null, at: parseThreadsTime(r.timestamp) ?? now }))
    .sort((a, b) => a.at - b.at);
  const matches = matchRepliesToDrafts(fresh, candidates);

  if (matches.length) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO posted_comments (threads_media_id, draft_id, target_id, text, permalink, posted_at, similarity, status, created_at)
         SELECT json_extract(value, '$.m'), json_extract(value, '$.d'), json_extract(value, '$.t'), json_extract(value, '$.x'),
                json_extract(value, '$.p'), json_extract(value, '$.a'), json_extract(value, '$.s'), 'live', ?2
           FROM json_each(?1)`,
      ).bind(
        JSON.stringify(matches.map((m) => ({ m: m.mediaId, d: m.draftId, t: m.targetId, x: m.text, p: m.permalink, a: m.postedAt, s: m.sim }))),
        now,
      ),
      env.DB.prepare(`UPDATE comment_drafts SET status = 'posted' WHERE id IN (SELECT value FROM json_each(?1))`).bind(
        JSON.stringify(matches.map((m) => m.draftId)),
      ),
    ]);
  }
  summary.push(`讀到 ${replies.length} 則回覆，比對到 ${matches.length} 則`);

  // 3) 成效快照：每則只抓「目前已到、還沒抓的最大里程碑」；比較早沒抓到的就跳過（晚抓的數字不準）
  const dueRes = await env.DB.prepare(
    `SELECT p.id, p.threads_media_id, p.posted_at,
            (SELECT group_concat(s.milestone) FROM reply_snapshots s WHERE s.posted_id = p.id) AS have
       FROM posted_comments p
      WHERE p.status = 'live' AND p.posted_at <= ?1 AND p.posted_at >= ?2
        AND NOT EXISTS (SELECT 1 FROM reply_snapshots s2 WHERE s2.posted_id = p.id AND s2.milestone = '72h')
      ORDER BY p.posted_at ASC LIMIT 300`,
  )
    .bind(now - HOUR, now - 14 * DAY)
    .all<DueRow>();

  const due: { row: DueRow; milestone: string; dueAt: number }[] = [];
  for (const row of dueRes.results ?? []) {
    const have = new Set((row.have ?? '').split(',').filter(Boolean));
    const age = now - row.posted_at;
    let pick: { name: string; ms: number } | null = null;
    for (const m of MILESTONES) if (age >= m.ms) pick = m;
    if (pick && !have.has(pick.name)) due.push({ row, milestone: pick.name, dueAt: row.posted_at + pick.ms });
  }
  due.sort((a, b) => a.dueAt - b.dueAt);

  const snaps: Record<string, unknown>[] = [];
  const missingIds: number[] = [];
  let stop: 'auth' | 'ratelimit' | null = null;
  let errors = 0;
  let insightCalls = 0;

  for (const d of due) {
    if (insightCalls >= INSIGHT_CAP || client.calls >= FETCH_CAP) break;
    insightCalls++;
    try {
      const m = await client.mediaInsights(d.row.threads_media_id);
      snaps.push({ p: d.row.id, m: d.milestone, v: m.views ?? null, l: m.likes ?? null, r: m.replies ?? null, rp: m.reposts ?? null, q: m.quotes ?? null, sh: m.shares ?? null });
    } catch (err) {
      if (err instanceof ThreadsApiError && err.isRateLimit) { stop = 'ratelimit'; break; }
      if (err instanceof ThreadsApiError && err.isAuth) { stop = 'auth'; break; }
      if (err instanceof ThreadsApiError && err.isNotFound) {
        // insights 查不到：再確認這則回覆本身還在不在，避免把「不支援 insights」誤判成被刪
        if (client.calls >= FETCH_CAP) break;
        try {
          const exists = await client.mediaExists(d.row.threads_media_id);
          if (exists) {
            // 回覆還在但查不到數字：記一筆空值，不要每小時重試
            snaps.push({ p: d.row.id, m: d.milestone, v: null, l: null, r: null, rp: null, q: null, sh: null });
          } else {
            missingIds.push(d.row.id);
          }
        } catch (e2) {
          if (e2 instanceof ThreadsApiError && e2.isRateLimit) { stop = 'ratelimit'; break; }
          if (e2 instanceof ThreadsApiError && e2.isAuth) { stop = 'auth'; break; }
          errors++;
        }
        continue;
      }
      errors++;
    }
  }

  const writes: D1PreparedStatement[] = [];
  if (snaps.length) {
    writes.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO reply_snapshots (posted_id, milestone, views, likes, replies, reposts, quotes, shares, captured_at)
         SELECT json_extract(value, '$.p'), json_extract(value, '$.m'), json_extract(value, '$.v'), json_extract(value, '$.l'),
                json_extract(value, '$.r'), json_extract(value, '$.rp'), json_extract(value, '$.q'), json_extract(value, '$.sh'), ?2
           FROM json_each(?1)`,
      ).bind(JSON.stringify(snaps), now),
    );
  }
  let blockIdx = -1;
  if (missingIds.length) {
    writes.push(
      env.DB.prepare(`UPDATE posted_comments SET status = 'missing', missing_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))`).bind(
        JSON.stringify(missingIds),
        now,
      ),
    );
    // 計畫 §5-B：留言被隱藏或刪除過，那位作者自動進黑名單（之後按「開 Threads 回覆」會被擋；後台可以移除）
    blockIdx = writes.length;
    writes.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO blocklist (kind, value, reason, created_at)
         SELECT DISTINCT 'author', lower(t.author_username), '留言查不到（可能被刪或被隱藏）', ?2
           FROM posted_comments p JOIN targets t ON t.id = p.target_id
          WHERE p.id IN (SELECT value FROM json_each(?1)) AND t.author_username IS NOT NULL AND t.author_username != ''
         RETURNING value`,
      ).bind(JSON.stringify(missingIds), now),
    );
  }
  const writeRes = writes.length ? await env.DB.batch(writes) : [];
  const blocked = blockIdx >= 0 ? ((writeRes[blockIdx]?.results ?? []) as { value: string }[]).map((r) => r.value) : [];
  const later = due.length - snaps.length - missingIds.length;
  summary.push(`抓了 ${snaps.length} 筆成效${later > 0 ? `（${later} 筆下次再抓）` : ''}`);
  if (missingIds.length) summary.push(`${missingIds.length} 則留言查不到了`);
  if (blocked.length) summary.push(`已把 ${blocked.map((a) => `@${a}`).join('、')} 加進黑名單`);
  if (errors) summary.push(`${errors} 次查詢失敗`);

  // 4) 一週內查不到的留言太多 → 自動暫停＋提醒（只在這次有新的查不到時觸發，避免重複暫停）
  if (missingIds.length) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM posted_comments WHERE status = 'missing' AND missing_at >= ?1`)
      .bind(now - 7 * DAY)
      .first<{ n: number }>();
    const n = c?.n ?? 0;
    if (settings.missing_pause_threshold > 0 && n >= settings.missing_pause_threshold && !(await activePause(env, now))) {
      let tail = '';
      if (settings.auto_pause_hours > 0) {
        const { untilAt } = await pauseFor(env, settings.auto_pause_hours, `一週內有 ${n} 則留言查不到了`, 'auto');
        tail = `已自動暫停到 ${taipeiShort(untilAt)}。`;
      }
      const blockNote = blocked.length ? `已把 ${blocked.map((a) => `@${a}`).join('、')} 加進黑名單。` : '';
      await sendAlert(env, `一週內有 ${n} 則留言查不到了（可能被刪或被隱藏）。${tail}${blockNote}先到 Threads 看一下帳號有沒有被限制。`);
      summary.push('已自動暫停');
    }
  }

  if (stop === 'ratelimit') {
    await handleThreadsRateLimit(env, settings);
    summary.push('Threads 回報限流，先停');
  } else if (stop === 'auth') {
    await alertThreadsAuth(env);
    summary.push('Threads 授權失效，先停');
  }

  return summary.join('；');
}

async function stopOnError(env: Env, settings: Settings, err: unknown, where: string): Promise<string> {
  if (err instanceof ThreadsApiError && err.isRateLimit) {
    await handleThreadsRateLimit(env, settings);
    return `${where}時 Threads 回報限流，先停`;
  }
  if (err instanceof ThreadsApiError && err.isAuth) {
    await alertThreadsAuth(env);
    return `${where}時 Threads 授權失效，先停`;
  }
  // 其他錯誤丟給 index.ts 記成失敗
  throw err;
}
