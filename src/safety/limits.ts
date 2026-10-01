// /go/ 的安全檢查與額度。這些上限只擋在「開 Threads 回覆」這顆按鈕上，
// Max 自己複製文字還是繞得過去；它是替帳號裝的護欄，不是鎖。
import type { Env } from '../env';
import type { OpenCheck } from '../types';
import { getSettings, type Settings } from '../lib/settings';
import { DAY, HOUR, inWindow, startOfTaipeiDay, taipeiDate, taipeiHHMM, taipeiShort, windowEndAt } from '../lib/time';
import { buildReplyIntentUrl } from '../threads/url';
import { activePause } from './pause';
import { maxSimilarity } from './similarity';

const MINUTE = 60 * 1000;
const FIRST_DAYS = 14;
const SIMILARITY_CORPUS = 200; // 跟最近幾則已送出的留言比
const RECENT_OPENED_MS = 72 * HOUR; // 開過但還沒比對到的草稿也算進去（每小時才比對一次）

// 前 14 天用較低的上限。還沒開始（started_at = 0）也算前 14 天
export function dailyCapFor(settings: Settings, now: number): number {
  const started = settings.started_at;
  if (!started || now < started + FIRST_DAYS * DAY) return settings.daily_cap_first14;
  return settings.daily_cap;
}

// 同一天顯示 HH:MM，不同天顯示 M/D HH:MM（台北時間）
function when(ts: number, now: number): string {
  return taipeiDate(ts) === taipeiDate(now) ? taipeiHHMM(ts) : taipeiShort(ts);
}

// 某個時間點如果落在夜間時段，順延到夜間結束
function pushPastNight(ts: number, s: Settings): number {
  return inWindow(ts, s.night_start, s.night_end) ? windowEndAt(ts, s.night_start, s.night_end) : ts;
}

interface DraftRow {
  id: string;
  text: string;
  mentions_product: number;
  opened_at: number | null;
  target_id: number;
  shortcode: string;
  author: string | null;
}

export async function checkOpenAllowed(env: Env, draftId: string, now: number): Promise<OpenCheck> {
  const s = await getSettings(env);

  const [draftRes, statRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT d.id, d.text, d.mentions_product, d.opened_at, d.target_id, t.shortcode, t.author_username AS author
         FROM comment_drafts d JOIN targets t ON t.id = d.target_id
        WHERE d.id = ?1`,
    ).bind(draftId),
    // 這篇目標貼文第一次被開的時間、有沒有已經比對到送出
    env.DB.prepare(
      `SELECT MIN(opened_at) AS first_open, MAX(CASE WHEN status = 'posted' THEN 1 ELSE 0 END) AS posted
         FROM comment_drafts
        WHERE target_id = (SELECT target_id FROM comment_drafts WHERE id = ?1)`,
    ).bind(draftId),
  ]);
  const d = (draftRes.results?.[0] ?? null) as DraftRow | null;
  if (!d) return { allowed: false, reason: '找不到這則草稿' };
  const stat = (statRes.results?.[0] ?? {}) as { first_open: number | null; posted: number | null };

  // 2. 同一篇貼文：寬限時間內換別則草稿、或重開同一則，都算同一則，不重複計數
  let grace = false;
  if (stat.first_open != null) {
    if (stat.posted) return { allowed: false, reason: '這篇已經留過言了' };
    const withinGrace = now - stat.first_open <= s.reopen_grace_min * MINUTE;
    if (d.opened_at != null || withinGrace) grace = true;
    else {
      // 只是開過、還沒比對到送出：講清楚是「換草稿的時間過了」，原本那則還是可以重開
      return {
        allowed: false,
        reason: `這篇 ${when(stat.first_open, now)} 已經開過另一則，超過 ${s.reopen_grace_min} 分鐘就不能換`,
        hint: '要回就回 LINE，按原本那則的「開 Threads 回覆」。',
      };
    }
  }

  // 3. 暫停
  const pause = await activePause(env, now);
  if (pause) {
    // 時間由擋下頁統一顯示（retryAt），原因裡不重複講
    return { allowed: false, reason: `目前暫停中（${pause.reason}）`, retryAt: pause.untilAt };
  }

  // 4. 夜間
  if (inWindow(now, s.night_start, s.night_end)) {
    const end = windowEndAt(now, s.night_start, s.night_end);
    return { allowed: false, reason: '夜間不開放送出', retryAt: end };
  }

  // 其餘檢查一次查完（D1 batch 一趟來回）
  const keys: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  const add = (k: string, st: D1PreparedStatement) => {
    keys.push(k);
    stmts.push(st);
  };

  if (!grace) {
    add(
      'block',
      env.DB.prepare(
        `SELECT 1 AS hit FROM blocklist
          WHERE (kind = 'shortcode' AND value = ?1) OR (kind = 'author' AND ?2 != '' AND lower(value) = lower(?2))
          LIMIT 1`,
      ).bind(d.shortcode, d.author ?? ''),
    );
    if (d.author && s.same_author_days > 0) {
      add(
        'author',
        env.DB.prepare(
          `SELECT MAX(d.opened_at) AS last FROM comment_drafts d JOIN targets t ON t.id = d.target_id
            WHERE lower(t.author_username) = lower(?1) AND d.target_id != ?2 AND d.opened_at >= ?3`,
        ).bind(d.author, d.target_id, now - s.same_author_days * DAY),
      );
    }
    add(
      'daily',
      env.DB.prepare('SELECT COUNT(DISTINCT target_id) AS n FROM comment_drafts WHERE opened_at >= ?1').bind(
        startOfTaipeiDay(now),
      ),
    );
    add(
      'hourly',
      env.DB.prepare(
        `SELECT target_id, MIN(opened_at) AS f FROM comment_drafts
          WHERE opened_at >= ?1 GROUP BY target_id ORDER BY f ASC`,
      ).bind(now - HOUR),
    );
  }
  const productEvery = Math.floor(s.product_every);
  if (d.mentions_product && productEvery > 1) {
    // 最近 (N-1) 篇開過的目標貼文，只要有一篇開的草稿提到產品，這則就先不提
    add(
      'product',
      env.DB.prepare(
        `SELECT target_id, MAX(opened_at) AS last_open, MAX(mentions_product) AS mp
           FROM comment_drafts
          WHERE opened_at IS NOT NULL AND opened_at >= ?1 AND target_id != ?2
          GROUP BY target_id ORDER BY last_open DESC LIMIT ?3`,
      ).bind(now - 30 * DAY, d.target_id, productEvery - 1),
    );
  }
  add(
    'similar',
    env.DB.prepare(
      `SELECT text FROM (SELECT text FROM posted_comments ORDER BY posted_at DESC LIMIT ?1)
       UNION ALL
       SELECT text FROM comment_drafts WHERE opened_at >= ?2 AND target_id != ?3`,
    ).bind(SIMILARITY_CORPUS, now - RECENT_OPENED_MS, d.target_id),
  );

  const results = await env.DB.batch(stmts);
  const rows = (k: string) => {
    const i = keys.indexOf(k);
    return i < 0 ? [] : ((results[i]?.results ?? []) as Record<string, unknown>[]);
  };

  if (!grace) {
    // 5. 黑名單
    if (rows('block').length > 0) return { allowed: false, reason: '這位作者在黑名單裡' };

    // 6. 同一作者 N 天內只回一次
    const lastAuthor = rows('author')[0]?.last as number | null | undefined;
    if (lastAuthor != null) {
      return {
        allowed: false,
        reason: `${s.same_author_days} 天內回過 @${d.author} 了`,
        retryAt: pushPastNight(lastAuthor + s.same_author_days * DAY, s),
      };
    }

    // 7. 每日上限（今天台北時間開過幾篇不同的貼文）
    const cap = dailyCapFor(s, now);
    const dailyN = Number(rows('daily')[0]?.n ?? 0);
    if (dailyN >= cap) {
      return {
        allowed: false,
        reason: `今天已經 ${dailyN} 則，到上限了`,
        retryAt: pushPastNight(startOfTaipeiDay(now) + DAY, s),
      };
    }

    // 8. 每小時上限
    const hourRows = rows('hourly');
    if (s.hourly_cap > 0 && hourRows.length >= s.hourly_cap) {
      const oldest = Number(hourRows[0]?.f ?? now);
      const retryAt = pushPastNight(oldest + HOUR, s);
      return { allowed: false, reason: `一小時內已經 ${hourRows.length} 則了`, retryAt };
    }

    // 9. 兩則之間的隨機間隔
    if (s.next_allowed_at > now) {
      const m = Math.ceil((s.next_allowed_at - now) / MINUTE);
      return { allowed: false, reason: `還要等 ${m} 分鐘`, retryAt: s.next_allowed_at };
    }
  }

  // 10. 產品曝光比例
  if (rows('product').some((r) => Number(r.mp) === 1)) {
    return { allowed: false, reason: '最近才提過產品，這則先換一則沒提產品的' };
  }

  // 11. 跟之前的留言太像
  const corpus = rows('similar').map((r) => String(r.text ?? ''));
  if (maxSimilarity(d.text, corpus) >= s.similarity_block) {
    return { allowed: false, reason: '跟你之前的留言太像了' };
  }

  return { allowed: true, intentUrl: buildReplyIntentUrl(d.shortcode, d.text) };
}

// 放行後呼叫：標成已開；如果是新的一篇（不是寬限內重開），排下一則最早可開的時間
export async function recordOpen(env: Env, draftId: string, now: number): Promise<void> {
  const s = await getSettings(env);
  const row = await env.DB.prepare(
    `SELECT d.target_id, (SELECT MIN(opened_at) FROM comment_drafts WHERE target_id = d.target_id) AS first_open
       FROM comment_drafts d WHERE d.id = ?1`,
  )
    .bind(draftId)
    .first<{ target_id: number; first_open: number | null }>();
  if (!row) return;

  const upsert = (key: string, value: number) =>
    env.DB.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).bind(key, String(value), now);

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE comment_drafts
          SET status = CASE WHEN status = 'posted' THEN status ELSE 'opened' END,
              opened_at = COALESCE(opened_at, ?2)
        WHERE id = ?1`,
    ).bind(draftId, now),
  ];
  if (row.first_open == null) {
    const lo = Math.max(0, Math.min(s.min_interval_min, s.max_interval_min));
    const hi = Math.max(s.min_interval_min, s.max_interval_min);
    const minutes = lo + Math.floor(Math.random() * (hi - lo + 1));
    stmts.push(upsert('next_allowed_at', now + minutes * MINUTE));
  }
  if (!s.started_at) stmts.push(upsert('started_at', now));
  await env.DB.batch(stmts);
}

// /額度 用：今天還能開幾則、這小時開了幾則、下一則什麼時候可以開、有沒有暫停
export async function quotaStatus(env: Env, now: number): Promise<string> {
  const s = await getSettings(env);
  const [dailyRes, hourRes] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(DISTINCT target_id) AS n FROM comment_drafts WHERE opened_at >= ?1').bind(
      startOfTaipeiDay(now),
    ),
    env.DB.prepare(
      `SELECT target_id, MIN(opened_at) AS f FROM comment_drafts
        WHERE opened_at >= ?1 GROUP BY target_id ORDER BY f ASC`,
    ).bind(now - HOUR),
  ]);
  const pause = await activePause(env, now);

  const cap = dailyCapFor(s, now);
  const dailyN = Number((dailyRes.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  const hourRows = (hourRes.results ?? []) as { f: number }[];
  const left = Math.max(0, cap - dailyN);

  const lines: string[] = [];
  let capNote = '';
  if (!s.started_at) capNote = '（還沒開始，前 14 天的上限）';
  else if (now < s.started_at + FIRST_DAYS * DAY) {
    const day = Math.floor((now - s.started_at) / DAY) + 1;
    capNote = `（前 14 天的上限，今天第 ${day} 天）`;
  }
  lines.push(`今天已開 ${dailyN} 則，上限 ${cap}${capNote}，還能開 ${left} 則`);
  lines.push(`這一小時 ${hourRows.length}／${s.hourly_cap} 則`);

  if (pause) {
    lines.push(`暫停中：到 ${when(pause.untilAt, now)}（${pause.reason}）。/恢復 可以解除`);
  } else if (inWindow(now, s.night_start, s.night_end)) {
    lines.push(`現在是夜間時段，${when(windowEndAt(now, s.night_start, s.night_end), now)} 後才能開`);
  } else if (left === 0) {
    lines.push(`今天額度用完了，${when(pushPastNight(startOfTaipeiDay(now) + DAY, s), now)} 後再開`);
  } else if (s.hourly_cap > 0 && hourRows.length >= s.hourly_cap) {
    lines.push(`這小時額度用完了，${when(pushPastNight(Number(hourRows[0].f) + HOUR, s), now)} 後再開`);
  } else if (s.next_allowed_at > now) {
    const m = Math.ceil((s.next_allowed_at - now) / MINUTE);
    lines.push(`下一則：${when(s.next_allowed_at, now)} 後（還要等 ${m} 分鐘）`);
  } else {
    lines.push('下一則：現在就可以開');
  }
  lines.push(s.night_start === s.night_end ? '沒有設夜間時段' : `夜間 ${s.night_start}–${s.night_end} 不開放送出`);
  return lines.join('\n');
}
