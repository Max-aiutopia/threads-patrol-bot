// 早報（台北 08:30 push）與 /今日 共用的摘要
import type { Env } from '../env';
import { getSettings } from '../lib/settings';
import { monthPushCount } from '../lib/repo';
import { DAY, HOUR, startOfTaipeiDay, taipeiDate, taipeiShort } from '../lib/time';
import { LineClient } from '../line/client';
import { defaultQuickReplies, textMessage } from '../line/flex';
import { dailyCapFor } from '../safety/limits';
import { activePause } from '../safety/pause';
import { tokenStatus } from '../threads/token';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

function fmt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function signed(n: number): string {
  return n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : '±0';
}

function md(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const chars = [...t];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : t;
}

// opts.morning：早報是 08:30 送的，夜間到 08:00 才結束，「今天開了幾則」幾乎一定是 0，改報昨天
export async function buildTodaySummary(env: Env, now: number = Date.now(), opts: { morning?: boolean } = {}): Promise<string> {
  const settings = await getSettings(env);
  const dayStart = startOfTaipeiDay(now);
  const openedFrom = opts.morning ? dayStart - DAY : dayStart;
  const openedTo = opts.morning ? dayStart : now + DAY;
  const today = taipeiDate(now);
  const yesterday = taipeiDate(now - DAY);

  const [dailyRes, openedRes, recentRes] = await env.DB.batch([
    env.DB.prepare('SELECT date, followers_count FROM own_daily WHERE followers_count IS NOT NULL ORDER BY date DESC LIMIT 2'),
    env.DB.prepare('SELECT COUNT(DISTINCT target_id) AS n FROM comment_drafts WHERE opened_at >= ?1 AND opened_at < ?2').bind(openedFrom, openedTo),
    env.DB.prepare(
      `SELECT p.text, p.posted_at, s.views
         FROM posted_comments p
         LEFT JOIN reply_snapshots s ON s.posted_id = p.id AND s.milestone = '24h'
        ORDER BY p.posted_at DESC LIMIT 3`,
    ),
  ]);
  const daily = (dailyRes.results ?? []) as { date: string; followers_count: number }[];
  const opened = ((openedRes.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  const recent = (recentRes.results ?? []) as { text: string; posted_at: number; views: number | null }[];

  const [tok, pause, pushUsed] = await Promise.all([tokenStatus(env), activePause(env, now), monthPushCount(env, now)]);

  const d = new Date(now + 8 * HOUR);
  const lines: string[] = [`今日 ${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAY[d.getUTCDay()]}）`];

  // 粉絲
  if (daily.length) {
    const latest = daily[0];
    const label = latest.date === today ? '今天' : latest.date === yesterday ? '昨天' : md(latest.date);
    if (daily.length > 1) lines.push(`粉絲 ${fmt(latest.followers_count)}（${label} ${signed(latest.followers_count - daily[1].followers_count)}）`);
    else lines.push(`粉絲 ${fmt(latest.followers_count)}（${label}，明天起才算得出增減）`);
  } else if (!tok.connected) {
    lines.push('還沒有資料：先到後台連結 Threads');
  } else {
    lines.push('粉絲數還沒有資料：每天 23:50 快照後才會有');
  }

  // 今天（早報：昨天）開了幾則
  if (opts.morning) lines.push(`昨天開了 ${fmt(opened)} 則；今天上限 ${fmt(dailyCapFor(settings, now))} 則`);
  else lines.push(`今天開了 ${fmt(opened)} 則，上限 ${fmt(dailyCapFor(settings, now))} 則`);
  if (pause) lines.push(`目前暫停到 ${taipeiShort(pause.untilAt)}（${pause.reason}）`);

  // 最近 3 則留言的 24 小時觀看
  if (recent.length) {
    lines.push('最近的留言（24 小時觀看）：');
    for (const r of recent) {
      let v: string;
      if (r.views !== null && r.views !== undefined) v = fmt(r.views);
      else if (r.posted_at + 24 * HOUR > now) v = '還沒滿 24 小時';
      else v = '沒抓到';
      lines.push(`・${clip(r.text, 16)}　${v}`);
    }
  } else {
    lines.push('還沒有比對到送出的留言');
  }

  // Threads 授權
  if (tok.connected && tok.daysLeft !== null) {
    lines.push(tok.daysLeft < 10 ? `Threads 授權剩 ${tok.daysLeft} 天，到後台重新連結` : `Threads 授權還有 ${tok.daysLeft} 天`);
  } else if (tok.expiresAt) {
    lines.push('Threads 授權過期了，到後台重新連結');
  } else if (daily.length) {
    lines.push('Threads 還沒連結');
  }

  // LINE 推播用量
  lines.push(
    pushUsed >= settings.push_warn_at
      ? `LINE 推播本月 ${fmt(pushUsed)} 則，快到上限了，可以先關早報`
      : `LINE 推播本月 ${fmt(pushUsed)} 則`,
  );

  return lines.join('\n');
}

export async function runMorning(env: Env): Promise<string> {
  const settings = await getSettings(env);
  if (!settings.morning_report) return '早報是關的，沒送';
  const text = await buildTodaySummary(env, Date.now(), { morning: true });
  const r = await new LineClient(env).push(env.LINE_ADMIN_USER_ID, [textMessage(text, defaultQuickReplies())], 'morning');
  if (!r.ok) throw new Error(`早報送不出去（LINE push ${r.status}）`);
  return '早報已送出';
}
