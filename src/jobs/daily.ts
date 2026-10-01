// 台北 23:50 每日快照：帳號 insights → own_daily；自己的貼文 → own_posts；每篇貼文 insights 拆成 Queue 工作
// 免費版每次呼叫 ≤ 40 個對外請求：這支最多 2（帳號 insights）+ 3（貼文分頁）次；每篇的 insights 交給 Queue，每則 ≤ 25 次
import type { Env } from '../env';
import type { SnapshotPostsJob } from '../types';
import { getSettings, logJob } from '../lib/settings';
import { DAY, startOfTaipeiDay, taipeiDate, toUnixSeconds } from '../lib/time';
import { ThreadsApiError, ThreadsClient, parseThreadsTime, type ThreadsMedia } from '../threads/client';
import { getThreadsToken } from '../threads/token';
import { alertThreadsAuth, handleThreadsRateLimit, isThreadsRateLimitPaused } from './hourly';

const POST_PAGES = 3;
const CHUNK = 25;
const UPSERT_ROWS = 100;        // 每個語句最多幾篇（json 參數別太大）
const TEXT_MAX = 500;           // Threads 貼文上限 500 字

function fmtInt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export async function runDaily(env: Env, _ctx: ExecutionContext): Promise<string> {
  const now = Date.now();
  const tok = await getThreadsToken(env);
  if (!tok) return '還沒連結 Threads，沒有快照';
  if (tok.expiresAt <= now) {
    await alertThreadsAuth(env);
    return 'Threads 授權過期了，沒有快照';
  }
  if (await isThreadsRateLimitPaused(env, now)) return 'Threads 限流暫停中，這次不抓';

  const settings = await getSettings(env);
  const client = new ThreadsClient(env, tok.accessToken, tok.userId);
  const date = taipeiDate(now);
  const [, mm, dd] = date.split('-');
  const summary: string[] = [];
  const head = () => `${Number(mm)}/${Number(dd)} 快照：${summary.join('，') || '沒有資料'}`;

  const onFatal = async (err: unknown, where: string): Promise<string | null> => {
    if (err instanceof ThreadsApiError && err.isRateLimit) {
      await handleThreadsRateLimit(env, settings);
      return `${head()}；${where}時 Threads 回報限流，先停`;
    }
    if (err instanceof ThreadsApiError && err.isAuth) {
      await alertThreadsAuth(env);
      return `${head()}；${where}時 Threads 授權失效，先停`;
    }
    return null;
  };

  // 1) 帳號 insights（今天 00:00 到現在，台北）
  const untilSec = toUnixSeconds(now);
  const sinceSec = Math.min(toUnixSeconds(startOfTaipeiDay(now)), untilSec - 60);
  try {
    const u = await client.userInsights({ sinceSec, untilSec });
    await env.DB.prepare(
      `INSERT INTO own_daily (date, followers_count, views, likes, replies, reposts, quotes, clicks, captured_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(date) DO UPDATE SET
         followers_count = COALESCE(excluded.followers_count, own_daily.followers_count),
         views = COALESCE(excluded.views, own_daily.views),
         likes = COALESCE(excluded.likes, own_daily.likes),
         replies = COALESCE(excluded.replies, own_daily.replies),
         reposts = COALESCE(excluded.reposts, own_daily.reposts),
         quotes = COALESCE(excluded.quotes, own_daily.quotes),
         clicks = COALESCE(excluded.clicks, own_daily.clicks),
         captured_at = excluded.captured_at`,
    )
      .bind(date, u.followersCount ?? null, u.views ?? null, u.likes ?? null, u.replies ?? null, u.reposts ?? null, u.quotes ?? null, u.clicks ?? null, now)
      .run();
    summary.push(u.followersCount != null ? `粉絲 ${fmtInt(u.followersCount)}` : '粉絲數沒抓到');
    // 個人檔案瀏覽的時間序列有幾段（Threads 以美西時間切天；上線第一週看這個決定要不要改算法）
    if (u.viewsBuckets != null && u.viewsBuckets > 1) summary.push(`主頁觀看是 ${u.viewsBuckets} 段加總`);
  } catch (err) {
    const stop = await onFatal(err, '抓帳號數據');
    if (stop) return stop;
    // 其他錯誤：記下來，繼續抓貼文
    await logJob(env, 'daily:user_insights', false, String(err).slice(0, 500));
    summary.push('帳號數據沒抓到');
  }

  // 2) 自己的貼文（30 天內，最多 3 頁），跳過回覆與轉發別人的貼文
  const posts: ThreadsMedia[] = [];
  let after: string | undefined;
  try {
    for (let i = 0; i < POST_PAGES; i++) {
      const page = await client.myThreads({ sinceSec: toUnixSeconds(now - 30 * DAY), limit: 100, after });
      posts.push(...page.data);
      after = page.next;
      if (!after) break;
    }
  } catch (err) {
    const stop = await onFatal(err, '抓貼文');
    if (stop) return stop;
    await logJob(env, 'daily:threads', false, String(err).slice(0, 500));
    summary.push('貼文只抓到一部分');
  }

  const rows = posts
    .filter((m) => m.is_reply !== true && m.media_type !== 'REPOST_FACADE')
    .map((m) => ({
      id: m.id,
      sc: m.shortcode ?? null,
      pl: m.permalink ?? null,
      tx: m.text ? m.text.slice(0, TEXT_MAX) : null,
      mt: m.media_type ?? null,
      at: parseThreadsTime(m.timestamp) ?? now,
    }));

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += UPSERT_ROWS) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO own_posts (media_id, shortcode, permalink, text, media_type, posted_at, updated_at)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.sc'), json_extract(value, '$.pl'), json_extract(value, '$.tx'),
                json_extract(value, '$.mt'), json_extract(value, '$.at'), ?2
           FROM json_each(?1) WHERE true
         ON CONFLICT(media_id) DO UPDATE SET
           shortcode = excluded.shortcode, permalink = excluded.permalink, text = excluded.text,
           media_type = excluded.media_type, posted_at = excluded.posted_at, updated_at = excluded.updated_at`,
      ).bind(JSON.stringify(rows.slice(i, i + UPSERT_ROWS)), now),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  summary.push(`貼文 ${fmtInt(rows.length)} 篇`);

  // 3) 30 天內的貼文拆成 ≤ 25 篇一則的 Queue 工作（用 DB 的清單，API 這次少抓到的也照樣快照）
  const { results } = await env.DB.prepare('SELECT media_id FROM own_posts WHERE posted_at >= ?1 ORDER BY posted_at DESC LIMIT 500')
    .bind(now - 30 * DAY)
    .all<{ media_id: string }>();
  const ids = (results ?? []).map((r) => r.media_id);
  const jobs: { body: SnapshotPostsJob }[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    jobs.push({ body: { kind: 'snapshot_posts', date, mediaIds: ids.slice(i, i + CHUNK) } });
  }
  // sendBatch 一次最多 100 則
  for (let i = 0; i < jobs.length; i += 100) await env.JOBS.sendBatch(jobs.slice(i, i + 100));
  if (jobs.length) summary.push(`成效分 ${jobs.length} 批在背景抓`);

  return head();
}

export async function processSnapshotChunk(job: SnapshotPostsJob, env: Env): Promise<void> {
  const now = Date.now();
  const tok = await getThreadsToken(env);
  if (!tok || tok.expiresAt <= now) return;
  if (await isThreadsRateLimitPaused(env, now)) return;

  const client = new ThreadsClient(env, tok.accessToken, tok.userId);
  const ids = (job.mediaIds ?? []).filter((x) => typeof x === 'string' && x).slice(0, CHUNK);
  const snaps: Record<string, unknown>[] = [];
  let fatal: ThreadsApiError | null = null;
  let errors = 0;

  // 5 個一組並行，其他錯誤只跳過那一篇
  for (let i = 0; i < ids.length && !fatal; i += 5) {
    const group = ids.slice(i, i + 5);
    const res = await Promise.allSettled(group.map((id) => client.mediaInsights(id)));
    res.forEach((r, k) => {
      if (r.status === 'fulfilled') {
        const m = r.value;
        snaps.push({ id: group[k], v: m.views ?? null, l: m.likes ?? null, r: m.replies ?? null, rp: m.reposts ?? null, q: m.quotes ?? null, sh: m.shares ?? null });
      } else {
        const e = r.reason;
        if (e instanceof ThreadsApiError && (e.isRateLimit || e.isAuth)) fatal = fatal ?? e;
        else errors++;
      }
    });
  }

  if (snaps.length) {
    await env.DB.prepare(
      `INSERT INTO own_post_snapshots (media_id, date, views, likes, replies, reposts, quotes, shares, captured_at)
       SELECT json_extract(value, '$.id'), ?2, json_extract(value, '$.v'), json_extract(value, '$.l'), json_extract(value, '$.r'),
              json_extract(value, '$.rp'), json_extract(value, '$.q'), json_extract(value, '$.sh'), ?3
         FROM json_each(?1) WHERE true
       ON CONFLICT(media_id, date) DO UPDATE SET
         views = excluded.views, likes = excluded.likes, replies = excluded.replies, reposts = excluded.reposts,
         quotes = excluded.quotes, shares = excluded.shares, captured_at = excluded.captured_at`,
    )
      .bind(JSON.stringify(snaps), job.date, now)
      .run();
  }

  // 不丟錯：丟錯會讓 Queue 重試，限流時重試只會更糟
  const f = fatal as ThreadsApiError | null;
  if (f?.isRateLimit) await handleThreadsRateLimit(env, await getSettings(env));
  else if (f?.isAuth) await alertThreadsAuth(env);
  if (errors || f) {
    const stopNote = f ? `；Threads ${f.isRateLimit ? '回報限流' : '授權失效'}，先停` : '';
    await logJob(env, 'queue:snapshot_posts', !f, `存了 ${snaps.length}／${ids.length} 篇，${errors} 篇失敗${stopNote}`);
  }
}
