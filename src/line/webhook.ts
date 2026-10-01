// LINE webhook 入口：驗簽 → 只收 Max → 去重 → 丟進 Queue → 立刻回 200。
// LINE 要求 2 秒內回應（https://developers.line.biz/en/docs/messaging-api/check-webhook-error-statistics/），
// 所以這裡不呼叫 Claude、不回訊息，真正的處理在 handlers.ts（Queue consumer）。
import type { Env } from '../env';
import type { LineEventJob, LineWebhookBody, LineWebhookEvent } from '../types';
import { verifyLineSignature } from './signature';

// 其他事件（unfollow、join…）不處理，也就不必寫 DB
const HANDLED_TYPES = new Set(['message', 'postback', 'follow']);

function isForAdmin(e: LineWebhookEvent | null | undefined, adminId: string | undefined): e is LineWebhookEvent {
  if (!adminId || !e || typeof e !== 'object') return false;
  if (typeof e.webhookEventId !== 'string' || !e.webhookEventId) return false;
  // 只收一對一聊天：群組裡就算是 Max 講話也不理，避免回覆出現在群組
  if (e.source?.type !== 'user' || e.source.userId !== adminId) return false;
  if (e.mode === 'standby') return false;
  return HANDLED_TYPES.has(e.type);
}

export async function handleLineWebhook(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  // 一定要先拿原始字串驗簽，驗完才能 parse
  const rawBody = await req.text();
  const valid = await verifyLineSignature(rawBody, req.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET);
  if (!valid) return new Response('invalid signature', { status: 401 });

  let body: Partial<LineWebhookBody> | null;
  try {
    body = JSON.parse(rawBody) as Partial<LineWebhookBody> | null;
  } catch {
    return new Response('bad request', { status: 400 });
  }

  // events 是空陣列：LINE Console 的 Verify 按鈕，回 200 就好
  const events = Array.isArray(body?.events) ? body.events : [];
  if (!events.length) return new Response('OK');

  // 不是 Max 的事件直接略過：不回覆、不寫 DB、不進 Queue
  const adminId = (env.LINE_ADMIN_USER_ID ?? '').trim();
  const wanted = events.filter((e) => isForAdmin(e, adminId));
  if (!wanted.length) return new Response('OK');

  // 去重：重送的事件 webhookEventId 不變。INSERT OR IGNORE 沒寫進去（changes = 0）就是看過了
  const now = Date.now();
  const insert = env.DB.prepare("INSERT OR IGNORE INTO line_events (webhook_event_id, status, created_at) VALUES (?1, 'queued', ?2)");
  const results = await env.DB.batch(wanted.map((e) => insert.bind(e.webhookEventId, now)));
  const fresh = wanted.filter((_, i) => (results[i]?.meta?.changes ?? 0) > 0);
  if (!fresh.length) return new Response('OK');

  const sent = await Promise.allSettled(
    fresh.map((event) => {
      const job: LineEventJob = { kind: 'line_event', event, receivedAt: now };
      return env.JOBS.send(job);
    }),
  );
  const failed = fresh.filter((_, i) => sent[i].status === 'rejected');
  if (failed.length) {
    // 沒進 Queue 的事件把去重紀錄刪掉，LINE 重送時才會再處理；回 500 讓 LINE 知道要重送（有開重送的話）
    console.error('queue send failed', failed.length);
    try {
      const del = env.DB.prepare('DELETE FROM line_events WHERE webhook_event_id = ?1');
      await env.DB.batch(failed.map((e) => del.bind(e.webhookEventId)));
    } catch (err) {
      console.error('line_events cleanup failed', err instanceof Error ? err.message : String(err));
    }
    return new Response('queue unavailable', { status: 500 });
  }
  return new Response('OK');
}
