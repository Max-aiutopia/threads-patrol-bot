// /go/<草稿ID>：記錄點擊 → 安全檢查 → 302 轉到 Threads Web Intent；被擋就顯示原因頁
// 這頁不用登入，但只憑 16 碼隨機 id 才看得到草稿內容。
import type { Env } from '../env';
import { escapeHtml, html } from '../lib/http';
import { taipeiDate, taipeiHHMM, taipeiShort } from '../lib/time';
import { checkOpenAllowed, recordOpen } from '../safety/limits';

const ID_RE = /^[A-Za-z0-9]{16}$/;
// 連結預覽爬蟲（LINE 的 line-poker、FB、Slack…）不算點擊
const PREVIEW_BOT_RE = /(facebookexternalhit|line-poker|slackbot|twitterbot|discordbot|telegrambot|whatsapp|linkedinbot|googlebot|bingbot|crawler|spider)/i;

export async function handleGo(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  const id = url.pathname.slice('/go/'.length).replace(/\/+$/, '');
  if (!ID_RE.test(id)) return page({ title: '找不到這則草稿', lines: ['連結不完整。回 LINE 重新按一次「開 Threads 回覆」。'] }, 404);

  const ua = (req.headers.get('user-agent') ?? '').slice(0, 300);
  if (PREVIEW_BOT_RE.test(ua)) return page({ title: '開 Threads 回覆', lines: ['請在手機 LINE 裡點這個連結。'] }, 200);

  const draft = await env.DB.prepare(
    `SELECT d.text, t.author_username AS author
       FROM comment_drafts d LEFT JOIN targets t ON t.id = d.target_id
      WHERE d.id = ?1`,
  )
    .bind(id)
    .first<{ text: string; author: string | null }>();
  if (!draft) {
    return page({ title: '找不到這則草稿', lines: ['可能已經超過 90 天被清掉了。回 LINE 貼網址重新產生一批。'] }, 404);
  }

  const now = Date.now();
  const check = await checkOpenAllowed(env, id, now);

  if (check.allowed) {
    await recordOpen(env, id, now);
    ctx.waitUntil(logClick(env, id, true, null, ua, now));
    return new Response(null, {
      status: 302,
      headers: { location: check.intentUrl, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  }

  ctx.waitUntil(logClick(env, id, false, check.reason, ua, now));

  const lines: string[] = [];
  if (check.retryAt && check.retryAt > now) {
    const when = taipeiDate(check.retryAt) === taipeiDate(now) ? taipeiHHMM(check.retryAt) : taipeiShort(check.retryAt);
    lines.push(`${when} 以後可以再開（台北時間）。時間到了，回 LINE 再按一次「開 Threads 回覆」。`);
  }
  if (check.hint) lines.push(check.hint);
  return page({ title: '這則先不開', reason: check.reason, lines, draft: draft.text, author: draft.author }, 200);
}

async function logClick(env: Env, draftId: string, allowed: boolean, reason: string | null, ua: string, now: number): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO link_clicks (draft_id, allowed, reason, user_agent, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(draftId, allowed ? 1 : 0, reason, ua || null, now)
      .run();
  } catch (err) {
    console.error('link_clicks insert failed', err);
  }
}

function page(p: { title: string; reason?: string; lines: string[]; draft?: string; author?: string | null }, status: number): Response {
  const body = `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(p.title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f4ef; --ink:#1a1a1a; --muted:#6b6b6b; --line:#dcd8cf; --box:#fffdf8; --warn:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --ink:#ececec; --muted:#a0a0a0; --line:#333; --box:#1d1d1d; --warn:#ff8a80; } }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin:0; background:var(--bg); color:var(--ink); font:17px/1.7 -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif; }
  main { max-width:560px; margin:0 auto; padding:40px 16px 56px; }
  h1 { font-size:22px; line-height:1.4; margin:0 0 16px; }
  .reason { font-size:18px; font-weight:600; color:var(--warn); margin:0 0 12px; }
  p { margin:0 0 12px; }
  .muted { color:var(--muted); font-size:15px; }
  .label { color:var(--muted); font-size:14px; margin:28px 0 8px; }
  .draft { background:var(--box); border:1px solid var(--line); border-radius:10px; padding:14px 16px; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; -webkit-user-select:text; user-select:text; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(p.title)}</h1>
  ${p.reason ? `<p class="reason">${escapeHtml(p.reason)}</p>` : ''}
  ${p.lines.map((l) => `<p class="muted">${escapeHtml(l)}</p>`).join('\n  ')}
  ${p.draft !== undefined ? `<p class="label">草稿內容${p.author ? `（回覆 @${escapeHtml(p.author)}）` : ''}</p>
  <div class="draft">${escapeHtml(p.draft)}</div>` : ''}
</main>
</body>
</html>`;
  return html(body, status, {
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-robots-tag': 'noindex, nofollow',
  });
}
