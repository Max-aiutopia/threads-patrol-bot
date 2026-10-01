// 暫停：暫停期間 /go/ 不轉到 Threads（草稿照樣可以產）。
// 手動（/暫停）與自動（限流、留言被刪）共用同一張 pauses 表；同時有好幾筆時，以最晚結束的為準。
import type { Env } from '../env';
import { HOUR } from '../lib/time';

const MAX_PAUSE_HOURS = 24 * 30;

export async function activePause(
  env: Env,
  now: number = Date.now(),
): Promise<{ untilAt: number; reason: string; source: string } | null> {
  const r = await env.DB.prepare(
    'SELECT until_at, reason, source FROM pauses WHERE cleared_at IS NULL AND until_at > ?1 ORDER BY until_at DESC LIMIT 1',
  )
    .bind(now)
    .first<{ until_at: number; reason: string; source: string }>();
  return r ? { untilAt: r.until_at, reason: r.reason, source: r.source } : null;
}

// 回傳實際生效的結束時間：如果本來就有更晚結束的暫停，回傳那一個
export async function pauseFor(
  env: Env,
  hours: number,
  reason: string,
  source: 'manual' | 'auto',
): Promise<{ untilAt: number }> {
  const now = Date.now();
  const h = Number.isFinite(hours) && hours > 0 ? Math.min(hours, MAX_PAUSE_HOURS) : 24;
  const untilAt = now + Math.round(h * HOUR);
  const existing = await activePause(env, now);
  await env.DB.prepare('INSERT INTO pauses (until_at, reason, source, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(untilAt, (reason || '暫停').slice(0, 200), source, now)
    .run();
  return { untilAt: Math.max(untilAt, existing?.untilAt ?? 0) };
}

// 解除所有還沒解除的暫停（含自動暫停）
export async function resume(env: Env): Promise<void> {
  await env.DB.prepare('UPDATE pauses SET cleared_at = ?1 WHERE cleared_at IS NULL').bind(Date.now()).run();
}
