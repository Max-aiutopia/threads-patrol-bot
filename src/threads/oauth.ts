// Threads OAuth（在後台登入之後才進得來）
// 流程來源：https://developers.facebook.com/documentation/threads/get-started/get-access-tokens-and-permissions
//          https://developers.facebook.com/documentation/threads/get-started/long-lived-tokens
import type { Env } from '../env';
import { THREADS_SCOPES, threadsRedirectUri } from '../env';
import { randomId } from '../lib/crypto';
import { escapeHtml, html, redirect } from '../lib/http';
import { getSettings, logJob, setSetting } from '../lib/settings';
import { ThreadsApiError, ThreadsClient, threadsRawGet, threadsRawPostForm } from './client';
import { saveThreadsToken } from './token';

const STATE_TTL_MS = 10 * 60 * 1000;

export async function handleThreadsAuth(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '');
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  if (p === '/auth/threads/start') return start(env);
  if (p === '/auth/threads/callback') return callback(url, env);
  return errorPage('找不到這個頁面。', undefined, 404);
}

async function start(env: Env): Promise<Response> {
  const now = Date.now();
  const state = randomId(24);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?1').bind(now - 24 * 60 * 60 * 1000),
    env.DB.prepare('INSERT INTO oauth_states (state, created_at) VALUES (?1, ?2)').bind(state, now),
  ]);
  const authUrl =
    `${env.THREADS_AUTH_URL}?client_id=${encodeURIComponent(env.THREADS_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(threadsRedirectUri(env))}` +
    `&scope=${THREADS_SCOPES.join(',')}` +
    `&response_type=code&state=${state}`;
  return redirect(authUrl);
}

async function callback(url: URL, env: Env): Promise<Response> {
  const q = url.searchParams;

  // 使用者在授權頁按了取消：?error=access_denied&error_reason=user_denied&error_description=...
  if (q.get('error')) {
    const reason = q.get('error_reason') === 'user_denied' ? '你在 Threads 授權頁按了取消。' : 'Threads 沒有完成授權。';
    await logJob(env, 'threads_oauth', false, `authorize error: ${q.get('error')} ${q.get('error_reason') ?? ''}`.trim());
    return errorPage(reason, '要連結的話，回後台再按一次「連結 Threads」。');
  }

  const state = q.get('state') ?? '';
  const rawCode = q.get('code') ?? '';
  if (!state || !/^[A-Za-z0-9]{8,64}$/.test(state)) return errorPage('授權連結少了驗證碼，或格式不對。', '回後台重新按一次「連結 Threads」。', 400);

  // 驗證並刪掉 state（同一個 batch：先讀再刪，只能用一次）
  const [sel] = await env.DB.batch<{ created_at: number }>([
    env.DB.prepare('SELECT created_at FROM oauth_states WHERE state = ?1').bind(state),
    env.DB.prepare('DELETE FROM oauth_states WHERE state = ?1').bind(state),
  ]);
  const row = sel.results?.[0];
  if (!row) return errorPage('這個授權連結已經用過或不存在。', '回後台重新按一次「連結 Threads」。', 400);
  if (Date.now() - row.created_at > STATE_TTL_MS) return errorPage('授權連結過期了（超過 10 分鐘）。', '回後台重新按一次「連結 Threads」。', 400);

  // 官方：redirect 會在 code 後面加 #_，不是 code 的一部分
  const code = rawCode.replace(/#_$/, '');
  if (!code) return errorPage('Threads 沒有回傳授權碼。', '回後台重新按一次「連結 Threads」。', 400);

  let step = '用授權碼換 token';
  try {
    // 1) code → 短效 token（1 小時）
    const short = await threadsRawPostForm(env, '/oauth/access_token', {
      client_id: env.THREADS_APP_ID,
      client_secret: env.THREADS_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: threadsRedirectUri(env),
      code,
    });
    const shortToken = typeof short.access_token === 'string' ? short.access_token : '';
    const shortUserId = short.user_id !== undefined && short.user_id !== null ? String(short.user_id) : null;
    if (!shortToken) throw new Error('短效 token 回應沒有 access_token');

    // 2) 短效 → 長效（60 天）
    step = '換長效 token';
    const long = await threadsRawGet(env, '/access_token', {
      grant_type: 'th_exchange_token',
      client_secret: env.THREADS_APP_SECRET,
      access_token: shortToken,
    });
    const longToken = typeof long.access_token === 'string' ? long.access_token : '';
    if (!longToken) throw new Error('長效 token 回應沒有 access_token');
    const expiresIn = Number(long.expires_in);

    // 3) 取帳號名稱
    step = '讀取帳號';
    const me = await new ThreadsClient(env, longToken, shortUserId).me();

    step = '儲存 token';
    await saveThreadsToken(env, {
      accessToken: longToken,
      userId: me.id || shortUserId,
      username: me.username || null,
      expiresInSec: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 60 * 24 * 60 * 60,
      scopes: THREADS_SCOPES.join(','),
    });

    const s = await getSettings(env);
    if (!s.started_at) await setSetting(env, 'started_at', Date.now());

    await logJob(env, 'threads_oauth', true, me.username ? `connected @${me.username}` : 'connected');
    return redirect('/#settings?threads=connected');
  } catch (err) {
    const detail = err instanceof ThreadsApiError
      ? `HTTP ${err.status}${err.code ? ` / code ${err.code}` : ''}：${err.message}`
      : err instanceof Error ? err.message : String(err);
    await logJob(env, 'threads_oauth', false, `${step} 失敗：${detail}`);
    return errorPage(`連結 Threads 沒有成功，卡在「${step}」。`, '授權碼只能用一次、1 小時內有效。回後台重新按一次「連結 Threads」；一直失敗的話，看後台「用量」的工作紀錄。', 502, detail);
  }
}

function errorPage(message: string, hint?: string, status = 400, detail?: string): Response {
  const body = `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>連結 Threads</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f4ef; --ink:#1a1a1a; --muted:#6b6b6b; --line:#dcd8cf; --accent:#1f4fd6; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --ink:#ececec; --muted:#a0a0a0; --line:#333; --accent:#8fb0ff; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.7 -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif; }
  main { max-width:520px; margin:0 auto; padding:48px 16px; }
  h1 { font-size:20px; margin:0 0 12px; }
  p { margin:0 0 12px; }
  .muted { color:var(--muted); font-size:14px; }
  code { display:block; white-space:pre-wrap; word-break:break-all; font-size:12px; color:var(--muted); border-top:1px solid var(--line); padding-top:12px; margin-top:20px; }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(message)}</h1>
  ${hint ? `<p class="muted">${escapeHtml(hint)}</p>` : ''}
  <p><a href="/#settings">回後台</a></p>
  ${detail ? `<code>${escapeHtml(detail.slice(0, 400))}</code>` : ''}
</main>
</body>
</html>`;
  return html(body, status, { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
}
