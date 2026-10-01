// 後台登入：密碼 → 簽章 cookie。沒有使用者帳號，只有 Max 一個人。
//
// 防暴力破解（2026-09 資安審查後改寫）：
// - 比對密碼「之前」先用一個語句原子地占一個名額，同一個 IP 同時送一大批請求也只有 5 個會被拿去比對
// - IPv6 以前 64 bits（/64）當一個 IP 算：一般主機一次就配一整個 /64，逐個位址算等於沒限
// - 全站上限：15 分鐘內所有來源加起來失敗 30 次，就全部擋 15 分鐘，並用 LINE 通知 Max 一次
// 登出：session 裡簽了一個 epoch，登出時把 epoch 加 1，舊 cookie 全部失效（所有裝置都要重新登入）。
import type { Env } from '../env';
import { base64UrlDecode, base64UrlEncode, hmacSha256, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { clientIp, escapeHtml, html, json } from '../lib/http';
import { logJob } from '../lib/settings';
import { LineClient } from '../line/client';

const COOKIE_NAME = 'sess';
const SESSION_VERSION = 1;
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const EPOCH_KEY = 'session_epoch'; // settings 表裡的一列，不在 EDITABLE_KEYS，後台改不到
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILS = 5;
const GLOBAL_MAX_FAILS = 30;
const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const GLOBAL_ALERT_JOB = 'alert:login_global';
const GLOBAL_ALERT_WITHIN_MS = 6 * 60 * 60 * 1000;
const MIN_PASSWORD_LEN = 12;
const MIN_SECRET_LEN = 16;
const MAX_INPUT_LEN = 512;

const dec = new TextDecoder();
const enc = new TextEncoder();

// 只有本機 http://127.0.0.1、localhost 開發時不加 Secure（不然瀏覽器不存 cookie）。
// 看請求本身，不看 PUBLIC_BASE_URL：設定寫錯時要往安全的方向錯
function isLocalHttp(req: Request): boolean {
  const u = new URL(req.url);
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}

function secureFlag(req: Request): string {
  return isLocalHttp(req) ? '' : '; Secure';
}

function sessionSecretOk(env: Env): boolean {
  return typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length >= MIN_SECRET_LEN;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function signPayload(env: Env, payloadB64: string): Promise<string> {
  return base64UrlEncode(await hmacSha256(env.SESSION_SECRET, payloadB64));
}

async function currentEpoch(env: Env): Promise<number> {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(EPOCH_KEY).first<{ value: string }>();
  const n = Number(r?.value ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

async function makeSessionCookie(env: Env, req: Request, now: number, epoch: number): Promise<string> {
  const payload = base64UrlEncode(enc.encode(JSON.stringify({ exp: now + SESSION_TTL_MS, v: SESSION_VERSION, e: epoch })));
  const sig = await signPayload(env, payload);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${payload}.${sig}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secureFlag(req)}`;
}

function clearSessionCookie(req: Request): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secureFlag(req)}`;
}

export async function getSession(req: Request, env: Env): Promise<{ exp: number } | null> {
  if (!sessionSecretOk(env)) return null;
  const raw = readCookie(req, COOKIE_NAME);
  if (!raw || raw.length > 1024) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = await signPayload(env, payload);
  if (!timingSafeEqual(sig, expected)) return null;
  let data: unknown;
  try {
    data = JSON.parse(dec.decode(base64UrlDecode(payload)));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { exp, v, e } = data as { exp?: unknown; v?: unknown; e?: unknown };
  if (typeof exp !== 'number' || v !== SESSION_VERSION) return null;
  if (exp <= Date.now()) return null;
  // 登出過就失效（epoch 對不上）。舊版 cookie 沒有 e，當成 0
  const epoch = typeof e === 'number' ? e : 0;
  try {
    if (epoch !== (await currentEpoch(env))) return null;
  } catch (err) {
    console.error('session epoch read failed', String(err));
    return null; // 讀不到就當沒登入（寧可擋錯）
  }
  return { exp };
}

// 非 GET 的 /api/*：Origin 要是自己，而且 body 是 JSON（HTML 表單送不出 application/json，擋掉跨站表單）
export function sameOriginOk(req: Request, env: Env): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const origin = req.headers.get('origin');
  if (!origin || !originMatches(origin, req, env)) return false;
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  return ct.split(';')[0].trim() === 'application/json';
}

function originMatches(origin: string, req: Request, env: Env): boolean {
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(env.PUBLIC_BASE_URL).origin);
  } catch {
    // PUBLIC_BASE_URL 設錯時退回只比對請求本身的 host
  }
  allowed.add(new URL(req.url).origin);
  return allowed.has(origin);
}

// ---------- 限流用的 IP key ----------

// 展開 IPv6 成 8 組 16 bits；看不懂就回 null
function expandIPv6(ip: string): number[] | null {
  let s = ip.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  // 結尾是內嵌的 IPv4（::ffff:1.2.3.4）→ 換成兩組 hex
  const v4 = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const b = v4.slice(2, 6).map(Number);
    if (b.some((x) => x > 255)) return null;
    s = `${v4[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

// IPv4 原樣；IPv6 取前 64 bits；IPv4-mapped IPv6 當成 IPv4
export function rateKeyForIp(ip: string): string {
  const raw = (ip || '').trim();
  if (!raw) return 'unknown';
  if (!raw.includes(':')) return raw.slice(0, 64);
  const g = expandIPv6(raw);
  if (!g) return raw.toLowerCase().slice(0, 64);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

// ---------- 登入 ----------

function isJsonRequest(req: Request): boolean {
  return (req.headers.get('content-type') || '').toLowerCase().includes('application/json');
}

async function readPassword(req: Request): Promise<string> {
  try {
    if (isJsonRequest(req)) {
      const body = (await req.json()) as { password?: unknown };
      return typeof body?.password === 'string' ? body.password : '';
    }
    const text = await req.text();
    const v = new URLSearchParams(text).get('password');
    return v ?? '';
  } catch {
    return '';
  }
}

function pageShell(title: string, inner: string, status: number): Response {
  const body = `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}｜Threads 海巡</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.css">
</head>
<body class="page-login">
<main class="login">
  <h1 class="login-title">Threads 海巡</h1>
  ${inner}
</main>
</body>
</html>`;
  return html(body, status, { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" });
}

function messagePage(title: string, message: string, status: number): Response {
  return pageShell(
    title,
    `<p class="login-sub">${escapeHtml(title)}</p>
  <p class="login-msg" role="alert">${escapeHtml(message)}</p>
  <p><a class="btn btn-quiet" href="/login">回登入頁</a></p>`,
    status,
  );
}

function fail(req: Request, status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  if (isJsonRequest(req)) return json({ error: code, message }, status, extra);
  if (code === 'wrong_password') {
    return new Response(null, { status: 303, headers: { location: '/login?e=1', 'cache-control': 'no-store' } });
  }
  const title = code === 'rate_limited' ? '暫時不能登入' : code === 'forbidden' ? '無法登入' : '後台設定有問題';
  const res = messagePage(title, message, status);
  for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
  return res;
}

// 全站鎖住時通知 Max 一次（6 小時內只推一次）。用一個語句原子地「搶」通知權，大量請求同時進來也只會推一則
async function alertGlobalLockOnce(env: Env, now: number, total: number): Promise<void> {
  try {
    const claim = await env.DB.prepare(
      `INSERT INTO job_log (job, ok, detail, created_at)
       SELECT ?1, 1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM job_log WHERE job = ?1 AND created_at >= ?4)
       RETURNING id`,
    )
      .bind(GLOBAL_ALERT_JOB, `後台 15 分鐘內登入失敗 ${total} 次，全部鎖住`, now, now - GLOBAL_ALERT_WITHIN_MS)
      .first<{ id: number }>();
    if (!claim) return;
    const text = `後台 15 分鐘內有 ${total} 次登入失敗，先全部鎖住 15 分鐘，你自己也暫時登不進去。不是你打錯的話，用 wrangler secret put DASH_PASSWORD 換一組密碼。`;
    const r = await new LineClient(env).push(env.LINE_ADMIN_USER_ID, [{ type: 'text', text }], 'alert');
    if (!r.ok) await logJob(env, GLOBAL_ALERT_JOB, false, `push ${r.status}`);
  } catch (err) {
    console.error('login alert failed', String(err));
  }
}

export async function handleLogin(req: Request, env: Env): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  // 登入表單本身也擋跨站送出（瀏覽器送表單一定會帶 Origin）
  const origin = req.headers.get('origin');
  if (origin && origin !== 'null' && !originMatches(origin, req, env)) {
    return fail(req, 403, 'forbidden', '請從後台登入頁登入。');
  }

  if (typeof env.DASH_PASSWORD !== 'string' || env.DASH_PASSWORD.length < MIN_PASSWORD_LEN) {
    return fail(req, 503, 'misconfigured', `後台密碼 DASH_PASSWORD 沒設定或太短，至少要 ${MIN_PASSWORD_LEN} 個字。用 wrangler secret put DASH_PASSWORD 重設。`);
  }
  if (!sessionSecretOk(env)) {
    return fail(req, 503, 'misconfigured', `SESSION_SECRET 沒設定或太短，至少要 ${MIN_SECRET_LEN} 個字（建議 32 bytes 隨機字串）。`);
  }

  const key = rateKeyForIp(clientIp(req));
  const now = Date.now();
  const since = now - RATE_WINDOW_MS;

  // 1) 先占名額，再比對密碼。一個語句做完「數＋寫」，D1 一次只跑一個語句，所以不會有兩個請求同時通過檢查。
  //    占到的這一列就是這次的紀錄：密碼錯就留著（算一次失敗），對了就連同這個 IP 的舊紀錄一起刪掉
  const [, claimRes] = await env.DB.batch<{ id: number }>([
    env.DB.prepare('DELETE FROM login_attempts WHERE created_at < ?1').bind(now - ATTEMPT_RETENTION_MS),
    env.DB.prepare(
      `INSERT INTO login_attempts (ip, created_at)
       SELECT ?1, ?2
        WHERE (SELECT COUNT(*) FROM login_attempts WHERE ip = ?1 AND created_at >= ?3) < ?4
          AND (SELECT COUNT(*) FROM login_attempts WHERE created_at >= ?3) < ?5
       RETURNING rowid AS id`,
    ).bind(key, now, since, RATE_MAX_FAILS, GLOBAL_MAX_FAILS),
  ]);

  if (!claimRes.results?.length) {
    const c = await env.DB.prepare(
      `SELECT SUM(CASE WHEN ip = ?1 THEN 1 ELSE 0 END) AS mine, COUNT(*) AS total,
              MIN(CASE WHEN ip = ?1 THEN created_at END) AS mine_first, MIN(created_at) AS first
         FROM login_attempts WHERE created_at >= ?2`,
    )
      .bind(key, since)
      .first<{ mine: number | null; total: number; mine_first: number | null; first: number | null }>();
    const perIp = (c?.mine ?? 0) >= RATE_MAX_FAILS;
    const start = (perIp ? c?.mine_first : c?.first) ?? now;
    const retryMs = Math.max(60_000, start + RATE_WINDOW_MS - now);
    const minutes = Math.ceil(retryMs / 60_000);
    const headers = { 'retry-after': String(Math.ceil(retryMs / 1000)) };
    if (perIp) return fail(req, 429, 'rate_limited', `密碼錯太多次了，${minutes} 分鐘後再試。`, headers);
    await alertGlobalLockOnce(env, now, c?.total ?? GLOBAL_MAX_FAILS);
    return fail(req, 429, 'rate_limited', `最近登入失敗的次數太多，後台先鎖住，${minutes} 分鐘後再試。`, headers);
  }

  // 2) 比對密碼
  const input = (await readPassword(req)).slice(0, MAX_INPUT_LEN);
  const ok = input.length > 0 && timingSafeEqual(await sha256Hex(input), await sha256Hex(env.DASH_PASSWORD));
  if (!ok) return fail(req, 401, 'wrong_password', '密碼不對。');

  const [, epochRes] = await env.DB.batch<{ value: string }>([
    env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?1').bind(key),
    env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind(EPOCH_KEY),
  ]);
  const epochRaw = Number(epochRes.results?.[0]?.value ?? 0);
  const epoch = Number.isInteger(epochRaw) && epochRaw >= 0 ? epochRaw : 0;
  const cookie = await makeSessionCookie(env, req, now, epoch);
  if (isJsonRequest(req)) return json({ ok: true }, 200, { 'set-cookie': cookie });
  return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie, 'cache-control': 'no-store' } });
}

// ---------- 登出 ----------

// GET 只顯示一顆登出按鈕（不改任何狀態）；POST 才真的登出。POST 要同源，跨站表單送不進來
export async function handleLogout(req: Request, env: Env): Promise<Response> {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return pageShell(
      '登出',
      `<p class="login-sub">要登出後台嗎？所有裝置都會一起登出。</p>
  <form method="post" action="/logout"><button class="btn" type="submit">登出</button></form>
  <p class="login-foot"><a href="/">回後台</a></p>`,
      200,
    );
  }
  if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const origin = req.headers.get('origin');
  if (origin && !originMatches(origin, req, env)) {
    return messagePage('無法登出', '請從後台頁面按「登出」。', 403);
  }
  // 沒登入的請求不動 epoch（不然任何人都能一直把 Max 踢出去）
  if (await getSession(req, env)) {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, '1', ?2)
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at`,
    )
      .bind(EPOCH_KEY, Date.now())
      .run();
  }
  return new Response(null, {
    status: 303,
    headers: { location: '/login', 'set-cookie': clearSessionCookie(req), 'cache-control': 'no-store' },
  });
}
