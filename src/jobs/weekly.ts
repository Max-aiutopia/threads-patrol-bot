// 台北週一 03:00：Threads token 續期 ＋ 清理。清理另外每天 23:50 也跑一次（index.ts），
// 保存天數才對得上隱私權政策（/privacy「保存多久」）。每天跑、門檻比政策少一天，實際最久就是政策寫的天數。
import type { Env } from '../env';
import { DAY, HOUR } from '../lib/time';
import { refreshThreadsToken, tokenStatus } from '../threads/token';
import { sendAlert } from './hourly';

// 跟 /privacy 的「保存多久」一致（改這裡要一起改 src/dash/pages.ts 與後台「資料與隱私」）
export const RETENTION_DAYS = {
  summary: 30, // 貼文摘要
  records: 90, // 目標貼文、草稿、點擊紀錄、工作紀錄
  lineEvents: 7,
  loginAttempts: 2, // 最近 15 分鐘的要留著算限流，所以最久 2 天（登入時也會順手刪掉 1 天以前的）
} as const;

export async function runCleanup(env: Env, now = Date.now()): Promise<string> {
  // 每天跑一次：刪「比政策少一天」以前的，實際保存最久剛好是政策寫的天數
  const before = (days: number) => now - Math.max(0, days - 1) * DAY;
  const dRec = before(RETENTION_DAYS.records);
  const labels = ['摘要', '點擊', '草稿', '批次', '貼文紀錄', 'LINE 事件', '登入失敗', 'OAuth 暫存', '對話暫存', '工作紀錄'];
  // 一個 batch；順序重要：先刪草稿，才刪空掉的 batch 與沒人引用的 target
  const res = await env.DB.batch([
    // 摘要保留 30 天：看「寫入摘要」的時間（summary_at），按鈕重產、重貼網址都不會延長
    env.DB.prepare(
      'UPDATE targets SET summary = NULL, summary_at = NULL WHERE summary IS NOT NULL AND COALESCE(summary_at, created_at) < ?1',
    ).bind(before(RETENTION_DAYS.summary)),
    env.DB.prepare('DELETE FROM link_clicks WHERE created_at < ?1').bind(dRec),
    // 已送出的留言對到的草稿留著（後台要看人設與第幾則）
    env.DB.prepare(
      'DELETE FROM comment_drafts WHERE created_at < ?1 AND id NOT IN (SELECT draft_id FROM posted_comments WHERE draft_id IS NOT NULL)',
    ).bind(dRec),
    env.DB.prepare('DELETE FROM draft_batches WHERE created_at < ?1 AND id NOT IN (SELECT batch_id FROM comment_drafts)').bind(dRec),
    env.DB.prepare(
      `DELETE FROM targets WHERE updated_at < ?1
         AND id NOT IN (SELECT target_id FROM posted_comments WHERE target_id IS NOT NULL)
         AND id NOT IN (SELECT target_id FROM comment_drafts)
         AND id NOT IN (SELECT target_id FROM draft_batches)`,
    ).bind(dRec),
    env.DB.prepare('DELETE FROM line_events WHERE created_at < ?1').bind(before(RETENTION_DAYS.lineEvents)),
    env.DB.prepare('DELETE FROM login_attempts WHERE created_at < ?1').bind(before(RETENTION_DAYS.loginAttempts)),
    env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?1').bind(now - DAY),
    env.DB.prepare(
      `UPDATE conversation_state SET pending_url = NULL, pending_shortcode = NULL, pending_author = NULL, pending_at = NULL, updated_at = ?2
        WHERE pending_at IS NOT NULL AND pending_at < ?1`,
    ).bind(now - HOUR, now), // 「先貼網址」的暫存只有 10 分鐘有效；網址本身另外記在 targets
    env.DB.prepare('DELETE FROM job_log WHERE created_at < ?1').bind(dRec),
  ]);
  const parts = res.map((r, i) => ({ label: labels[i], n: r.meta?.changes ?? 0 })).filter((x) => x.n > 0);
  return parts.length ? `清掉 ${parts.map((x) => `${x.label} ${x.n}`).join('、')}` : '沒有過期資料';
}

export async function runWeekly(env: Env): Promise<string> {
  const now = Date.now();
  const summary: string[] = [];
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');

  // 1) token 續期
  const before = await tokenStatus(env);
  if (before.expiresAt === null) {
    summary.push('Threads 還沒連結');
  } else if (!before.connected) {
    await sendAlert(env, `Threads 授權過期了，到後台重新連結：${base}/`, 'threads_token', 3 * DAY);
    summary.push('Threads 授權過期了');
  } else {
    const r = await refreshThreadsToken(env);
    if (!r.ok) {
      await sendAlert(env, `Threads 授權續期失敗（${r.error}）。還剩 ${before.daysLeft ?? 0} 天，到後台重新連結：${base}/`, 'threads_token', 3 * DAY);
      summary.push('Threads 授權續期失敗');
    } else {
      const daysLeft = Math.floor((r.expiresAt - now) / DAY);
      summary.push(`Threads 授權續期完成，剩 ${daysLeft} 天`);
      if (daysLeft < 10) {
        await sendAlert(env, `Threads 授權剩 ${daysLeft} 天，到後台重新連結：${base}/`, 'threads_token', 3 * DAY);
      }
    }
  }

  // 2) 清理（每天也會跑；這裡再跑一次，手動執行「每週」時也清得到）
  summary.push(await runCleanup(env, now));
  return summary.join('；');
}
