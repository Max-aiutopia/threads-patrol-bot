// 入口：HTTP 路由、Queue consumer、排程。各功能實作在子資料夾，這裡只分派。
import type { Env } from './env';
import type { Job } from './types';
import { json, redirect } from './lib/http';
import { logJob } from './lib/settings';

import { handleLineWebhook } from './line/webhook';
import { processLineEvent } from './line/handlers';
import { handleGo } from './threads/go';
import { handleThreadsAuth } from './threads/oauth';
import { runHourly } from './jobs/hourly';
import { runDaily, processSnapshotChunk } from './jobs/daily';
import { runMorning } from './jobs/morning';
import { runCleanup, runWeekly } from './jobs/weekly';
import { getSession, handleLogin, handleLogout } from './dash/auth';
import { handleApi } from './dash/api';
import { handlePublicPage, handleMetaCallback } from './dash/pages';

// 不用登入就能看的靜態檔
const PUBLIC_ASSETS = new Set(['/login', '/login.html', '/favicon.ico', '/favicon.svg']);

// 靜態檔（後台頁、登入頁）補上防嵌入、防猜型別的標頭。不限制 script／style 來源，免得擋到 Google Fonts 與登入頁的小段 script
async function serveAsset(env: Env, req: Request): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  const out = new Response(res.body, res);
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('x-frame-options', 'DENY');
  out.headers.set('referrer-policy', 'same-origin');
  if ((out.headers.get('content-type') ?? '').includes('text/html')) {
    out.headers.set('content-security-policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  }
  return out;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    try {
      // ---- 公開端點 ----
      if (p === '/line/webhook') {
        if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
        return await handleLineWebhook(req, env, ctx);
      }
      if (p.startsWith('/go/')) return await handleGo(req, env, ctx);
      if (p === '/privacy' || p === '/data-deletion') return await handlePublicPage(req, env);
      if (p === '/meta/deauthorize' || p === '/meta/data-deletion') return await handleMetaCallback(req, env);
      if (p === '/healthz') return json({ ok: true });
      if (p === '/login' && req.method === 'POST') return await handleLogin(req, env);
      if (p === '/logout') return await handleLogout(req, env); // GET 只顯示確認頁；POST（同源）才登出
      if (PUBLIC_ASSETS.has(p) || p.startsWith('/assets/')) {
        // 原封不動交給 assets：它會把 /login 對到 login.html；若改寫成 /login.html，
        // assets 預設會 307 回 /login，瀏覽器就無限轉址
        return await serveAsset(env, req);
      }

      // ---- 以下都要登入 ----
      const session = await getSession(req, env);
      if (!session) {
        if (p.startsWith('/api/')) return json({ error: 'unauthorized' }, 401);
        return redirect('/login');
      }
      if (p.startsWith('/api/')) return await handleApi(req, env, ctx);
      if (p.startsWith('/auth/threads/')) return await handleThreadsAuth(req, env);
      return await serveAsset(env, req);
    } catch (err) {
      console.error('fetch error', p, err);
      return json({ error: 'internal_error' }, 500);
    }
  },

  async queue(batch: MessageBatch<Job>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        if (job.kind === 'line_event') await processLineEvent(job, env, ctx);
        else if (job.kind === 'snapshot_posts') await processSnapshotChunk(job, env);
        msg.ack();
      } catch (err) {
        console.error('job failed', job.kind, err);
        await logJob(env, `queue:${job.kind}`, false, String(err));
        // LINE 事件不重試：reply token 只能用一次，重試只會造成重複或錯誤回覆
        if (job.kind === 'line_event') msg.ack();
        else msg.retry();
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = controller.cron;
    const run = async (name: string, fn: () => Promise<unknown>) => {
      try {
        const detail = await fn();
        await logJob(env, name, true, typeof detail === 'string' ? detail : undefined);
      } catch (err) {
        console.error('cron failed', name, err);
        await logJob(env, name, false, String(err));
      }
    };
    if (cron === '15 * * * *') await run('hourly', () => runHourly(env, ctx));
    else if (cron === '50 15 * * *') {
      await run('daily', () => runDaily(env, ctx));
      // 清理每天跑（保存天數要對得上隱私權政策）；沒連結 Threads 也照跑
      await run('cleanup', () => runCleanup(env));
    }
    else if (cron === '30 0 * * *') await run('morning', () => runMorning(env));
    else if (cron === '0 19 * * SUN') await run('weekly', () => runWeekly(env));
    else console.warn('unknown cron', cron);
  },
} satisfies ExportedHandler<Env, Job>;
