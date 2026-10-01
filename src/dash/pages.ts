// 公開頁（不用登入）：隱私權政策、資料刪除說明，以及 Meta 的解除授權／刪除資料 callback。
// Meta 審核人員看英文，所以兩頁都是中英對照。
import type { Env } from '../env';
import { base64UrlDecode, base64UrlEncode, hmacSha256, randomId, timingSafeEqual } from '../lib/crypto';
import { escapeHtml, html, json } from '../lib/http';
import { logJob } from '../lib/settings';

const CONTACT_EMAIL = 'janemax13@gmail.com';
const OPERATOR_ZH = '簡淵文（Max）';
const OPERATOR_EN = 'Max (簡淵文)';
const UPDATED = '2026-09-28';
const DELETION_JOB = 'meta_data_deletion';

function layout(p: { title: string; lang: string; body: string }): string {
  return `<!doctype html>
<html lang="${p.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(p.title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.css">
</head>
<body class="page-doc">
<main class="doc">
${p.body}
</main>
</body>
</html>`;
}

function langSwitch(): string {
  return `<p class="doc-lang"><a href="#zh">中文</a><span aria-hidden="true"> · </span><a href="#en">English</a></p>`;
}

// ---------- 隱私權政策 ----------

function privacyZh(): string {
  const e = escapeHtml(CONTACT_EMAIL);
  return `<article id="zh" lang="zh-Hant-TW">
<h1>隱私權政策</h1>
<p class="doc-meta">Threads 海巡機器人 · 最後更新 ${UPDATED}</p>

<h2>這是什麼</h2>
<p>Threads 海巡機器人是${OPERATOR_ZH}自己使用的工具：在 LINE 上幫他草擬 Threads 留言，並在後台看他自己帳號的數據。它不對外提供服務。系統不會自動發文、按讚或追蹤；每一則留言都是 Max 在 Threads 裡自己按送出。</p>

<h2>蒐集哪些資料</h2>
<ol>
<li><strong>Max 自己的 Threads 帳號資料</strong>，透過 Threads 官方 API 取得：帳號 ID 與使用者名稱、他自己的貼文與回覆（文字、時間、連結）、這些貼文與回覆的成效數字（觀看、讚、回覆、轉發、引用、分享），以及帳號每日的粉絲數、個人檔案瀏覽等統計。存取權杖加密後才儲存。</li>
<li><strong>Max 貼進 LINE 的公開貼文網址</strong>：作者的使用者名稱、網址，以及系統產生的 100 字內摘要。他貼的原文或截圖只用來產生草稿，不會存下來。</li>
<li><strong>留言草稿</strong>，以及按下「開 Threads 回覆」的時間與瀏覽器資訊（user agent），用來執行安全上限。</li>
<li><strong>Max 的 LINE 使用者 ID</strong>。其他人傳給這個 LINE 帳號的訊息，系統直接略過，不回覆也不儲存。</li>
<li><strong>後台登入失敗時的 IP 位址</strong>，用來防止暴力破解。</li>
</ol>

<h2>不做的事</h2>
<p>不賣資料、不做廣告、不替其他 Threads 使用者建立檔案、不追蹤或監控其他人、不抓取網頁內容。</p>

<h2>存在哪裡、誰會處理</h2>
<ul>
<li><strong>Cloudflare</strong>：主機與資料庫（Workers、D1）。</li>
<li><strong>Anthropic（Claude API）</strong>：產生留言草稿與分析文字。會收到 Max 貼的貼文內容或截圖、人設設定、產品資料卡。</li>
<li><strong>LINE（Messaging API）</strong>：傳訊息給 Max。</li>
<li><strong>Meta（Threads API）</strong>：Max 帳號資料的來源。</li>
</ul>

<h2>保存多久</h2>
<p>清理每天自動跑一次，下面是最長的保存時間。</p>
<ul>
<li>貼文摘要：最多 30 天（從寫入摘要那天算）。</li>
<li>目標貼文紀錄、留言草稿、點擊紀錄：最多 90 天；已經送出的留言所對應的貼文紀錄會保留。</li>
<li>Max 送出的留言與成效、他自己帳號的數據：保存到 Max 刪除，或 Threads 通知刪除為止。</li>
<li>LINE 事件 ID：最多 7 天。登入失敗紀錄：最多 2 天。系統工作紀錄：最多 90 天。</li>
</ul>

<h2>怎麼刪除資料</h2>
<ul>
<li><strong>Max 本人</strong>：在 Threads 帳號設定裡移除這個應用程式的授權，系統會刪除 Threads 存取權杖；透過 Threads 要求刪除資料時，會刪除權杖與所有從 Threads 取得的資料。</li>
<li><strong>其他 Threads 使用者</strong>：如果你的公開貼文網址曾被貼進這個工具，寫信到 <a href="mailto:${e}">${e}</a>，附上你的 Threads 使用者名稱，會刪除跟你有關的紀錄（網址、摘要、草稿、點擊紀錄）。Max 自己送出的留言屬於他的帳號內容，會保留，但不再連到你的貼文紀錄。</li>
<li>刪除狀態可以在 <a href="/data-deletion">資料刪除說明</a> 用確認碼查詢。</li>
</ul>

<h2>聯絡</h2>
<p>${OPERATOR_ZH} · <a href="mailto:${e}">${e}</a></p>
</article>`;
}

function privacyEn(): string {
  const e = escapeHtml(CONTACT_EMAIL);
  return `<article id="en" lang="en">
<h1>Privacy Policy</h1>
<p class="doc-meta">Threads Patrol Bot · Last updated ${UPDATED}</p>

<h2>What this is</h2>
<p>Threads Patrol Bot is a personal tool used only by ${OPERATOR_EN}. It drafts Threads reply comments for him inside LINE and shows statistics about his own Threads account on a private dashboard. It is not offered to the public. It never posts, likes or follows automatically: every reply is sent by Max himself inside the Threads app.</p>

<h2>What we collect</h2>
<ol>
<li><strong>Max's own Threads account data</strong>, through the official Threads API: account ID and username, his own posts and replies (text, time, link), their metrics (views, likes, replies, reposts, quotes, shares), and daily account statistics such as follower count and profile views. The access token is stored encrypted.</li>
<li><strong>Public post URLs that Max pastes into LINE</strong>: the author's username, the URL, and a summary of up to 100 characters. The post text or screenshot he provides is used only to generate drafts and is not stored.</li>
<li><strong>Comment drafts</strong>, and the time and browser user agent when a draft link is opened, used to enforce safety limits.</li>
<li><strong>Max's LINE user ID.</strong> Messages from anyone else are ignored and not stored.</li>
<li><strong>IP addresses of failed dashboard logins</strong>, to prevent password guessing.</li>
</ol>

<h2>What we do not do</h2>
<p>We do not sell data, run ads, build profiles of other Threads users, track or monitor anyone else, or scrape web pages.</p>

<h2>Where data is stored and who processes it</h2>
<ul>
<li><strong>Cloudflare</strong>: hosting and database (Workers, D1).</li>
<li><strong>Anthropic (Claude API)</strong>: generates comment drafts and analysis text. It receives the post text or screenshot Max submits, the persona settings and the product card.</li>
<li><strong>LINE (Messaging API)</strong>: delivers messages to Max.</li>
<li><strong>Meta (Threads API)</strong>: source of Max's account data.</li>
</ul>

<h2>Retention</h2>
<p>Cleanup runs automatically every day. These are the maximum retention periods.</p>
<ul>
<li>Post summaries: up to 30 days from when the summary was written.</li>
<li>Target post records, drafts and link-open logs: up to 90 days, except post records linked to a reply Max actually sent.</li>
<li>Replies Max sent, their metrics, and his own account statistics: kept until Max deletes them or Threads asks us to delete them.</li>
<li>LINE event IDs: up to 7 days. Failed-login records: up to 2 days. System job logs: up to 90 days.</li>
</ul>

<h2>How to delete data</h2>
<ul>
<li><strong>Max</strong>: removing this app in the Threads account settings deletes the stored access token. A data deletion request sent through Threads deletes the token and all data obtained from Threads.</li>
<li><strong>Other Threads users</strong>: if your public post URL was pasted into this tool, email <a href="mailto:${e}">${e}</a> with your Threads username. We will delete every record about you (URLs, summaries, drafts, link-open logs). Replies that Max sent belong to his own account and are kept, but no longer linked to your post.</li>
<li>You can check a deletion request with its confirmation code on the <a href="/data-deletion">data deletion page</a>.</li>
</ul>

<h2>Contact</h2>
<p>${OPERATOR_EN} · <a href="mailto:${e}">${e}</a></p>
</article>`;
}

// ---------- 資料刪除說明 ----------

type CodeStatus = { state: 'none' } | { state: 'invalid' } | { state: 'found'; at: number } | { state: 'unknown' };

async function lookupCode(env: Env, code: string | null): Promise<CodeStatus> {
  if (!code) return { state: 'none' };
  if (!/^[A-Za-z0-9]{8,32}$/.test(code)) return { state: 'invalid' };
  try {
    const r = await env.DB.prepare('SELECT created_at FROM job_log WHERE job = ?1 AND detail LIKE ?2 ORDER BY id DESC LIMIT 1')
      .bind(DELETION_JOB, `code=${code}%`)
      .first<{ created_at: number }>();
    return r ? { state: 'found', at: r.created_at } : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

function fmtTaipei(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

function statusBlock(code: string | null, s: CodeStatus): { zh: string; en: string } {
  if (s.state === 'none') return { zh: '', en: '' };
  const c = escapeHtml(code ?? '');
  if (s.state === 'found') {
    const t = escapeHtml(fmtTaipei(s.at));
    return {
      zh: `<p class="doc-status is-done" role="status">確認碼 <code>${c}</code>：已在 ${t}（台北時間）完成刪除。</p>`,
      en: `<p class="doc-status is-done" role="status">Confirmation code <code>${c}</code>: deletion completed on ${t} (Taipei time).</p>`,
    };
  }
  if (s.state === 'invalid') {
    return {
      zh: '<p class="doc-status" role="status">確認碼格式不對，請檢查一次。</p>',
      en: '<p class="doc-status" role="status">This confirmation code is not valid. Please check it again.</p>',
    };
  }
  const e = escapeHtml(CONTACT_EMAIL);
  return {
    zh: `<p class="doc-status" role="status">查不到確認碼 <code>${c}</code>。刪除紀錄保存 90 天；有問題請寫信到 <a href="mailto:${e}">${e}</a>。</p>`,
    en: `<p class="doc-status" role="status">No record for confirmation code <code>${c}</code>. Records are kept for 90 days; for questions, email <a href="mailto:${e}">${e}</a>.</p>`,
  };
}

function deletionZh(status: string): string {
  const e = escapeHtml(CONTACT_EMAIL);
  return `<article id="zh" lang="zh-Hant-TW">
<h1>資料刪除說明</h1>
<p class="doc-meta">Threads 海巡機器人 · 最後更新 ${UPDATED}</p>
${status}
<h2>Max 本人</h2>
<p>在 Threads 帳號設定裡移除這個應用程式並要求刪除資料，Meta 會通知我們。系統收到通知後會立刻刪除 Threads 存取權杖、他自己帳號的每日數據、貼文與成效、已送出留言的紀錄與成效，並回給 Meta 一組確認碼。用確認碼打開這一頁就看得到刪除狀態。</p>
<h2>其他 Threads 使用者</h2>
<p>如果你的公開貼文網址曾被貼進這個工具，寫信到 <a href="mailto:${e}">${e}</a>，附上你的 Threads 使用者名稱。我們會刪除跟你有關的紀錄（網址、摘要、草稿、點擊紀錄），並回信確認。</p>
<p><a href="/privacy">隱私權政策</a></p>
</article>`;
}

function deletionEn(status: string): string {
  const e = escapeHtml(CONTACT_EMAIL);
  return `<article id="en" lang="en">
<h1>Data Deletion</h1>
<p class="doc-meta">Threads Patrol Bot · Last updated ${UPDATED}</p>
${status}
<h2>Max (the account owner)</h2>
<p>Remove this app in the Threads account settings and request data deletion; Meta then notifies us. On that notice the system immediately deletes the Threads access token, his daily account statistics, his posts and their metrics, and the records and metrics of replies he sent, and returns a confirmation code to Meta. Open this page with the code to see the status.</p>
<h2>Other Threads users</h2>
<p>If your public post URL was pasted into this tool, email <a href="mailto:${e}">${e}</a> with your Threads username. We will delete every record about you (URLs, summaries, drafts, link-open logs) and reply to confirm.</p>
<p><a href="/privacy">Privacy Policy</a></p>
</article>`;
}

export async function handlePublicPage(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
  const url = new URL(req.url);
  if (url.pathname === '/privacy') {
    return html(layout({
      title: '隱私權政策 Privacy Policy｜Threads 海巡機器人',
      lang: 'zh-Hant-TW',
      body: `${langSwitch()}\n${privacyZh()}\n<hr class="doc-rule">\n${privacyEn()}`,
    }));
  }
  if (url.pathname === '/data-deletion') {
    const code = url.searchParams.get('code');
    const s = statusBlock(code, await lookupCode(env, code));
    return html(layout({
      title: '資料刪除 Data Deletion｜Threads 海巡機器人',
      lang: 'zh-Hant-TW',
      body: `${langSwitch()}\n${deletionZh(s.zh)}\n<hr class="doc-rule">\n${deletionEn(s.en)}`,
    }));
  }
  return html(layout({ title: '找不到頁面', lang: 'zh-Hant-TW', body: '<h1>找不到頁面</h1><p><a href="/privacy">隱私權政策</a></p>' }), 404);
}

// ---------- Meta callback ----------

interface SignedPayload {
  algorithm?: string;
  user_id?: string;
  issued_at?: number;
  expires?: number;
}

// Meta 每次通知都是當下簽的；issued_at 太舊（或跑到未來）就是重放，不照做
const SIGNED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SIGNED_FUTURE_SKEW_MS = 10 * 60 * 1000;

export function signedRequestFresh(p: SignedPayload, now = Date.now()): boolean {
  if (p.issued_at === undefined || p.issued_at === null) return true; // 官方都會帶；沒帶就不以此擋
  const t = Number(p.issued_at) * 1000;
  if (!Number.isFinite(t)) return false;
  return t <= now + SIGNED_FUTURE_SKEW_MS && now - t <= SIGNED_MAX_AGE_MS;
}

// 通知的是不是 Max 本人（存 token 時記下的 Threads user id）。'unknown'：token 沒記 user id，只能當成是
export type UserMatch = 'yes' | 'no' | 'unknown' | 'no_token';
export function userMatch(tokenUserId: string | null | undefined, hasToken: boolean, payloadUserId: unknown): UserMatch {
  if (!hasToken) return 'no_token';
  if (!tokenUserId) return 'unknown';
  if (payloadUserId === undefined || payloadUserId === null || String(payloadUserId) === '') return 'no';
  return String(tokenUserId) === String(payloadUserId) ? 'yes' : 'no';
}

// signed_request = base64url(簽章) + '.' + base64url(JSON)；簽章 = HMAC-SHA256(app secret, 編碼後的 payload 字串)
export async function verifySignedRequest(signedRequest: string, appSecret: string): Promise<SignedPayload | null> {
  if (!signedRequest || !appSecret || signedRequest.length > 8192) return null;
  const dot = signedRequest.indexOf('.');
  if (dot <= 0 || dot === signedRequest.length - 1) return null;
  const sigPart = signedRequest.slice(0, dot);
  const payloadPart = signedRequest.slice(dot + 1);
  let given: string;
  let payload: SignedPayload;
  try {
    given = base64UrlEncode(base64UrlDecode(sigPart)); // 統一成不帶 = 的 base64url 再比
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));
  } catch {
    return null;
  }
  const expected = base64UrlEncode(await hmacSha256(appSecret, payloadPart));
  if (!timingSafeEqual(given, expected)) return null;
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.algorithm !== 'string' || payload.algorithm.toUpperCase() !== 'HMAC-SHA256') return null;
  return payload;
}

async function readSignedRequest(req: Request): Promise<string> {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  const text = await req.text();
  if (text.length > 16_384) return '';
  if (ct.includes('application/json')) {
    try {
      const v = JSON.parse(text) as { signed_request?: unknown };
      return typeof v.signed_request === 'string' ? v.signed_request : '';
    } catch {
      return '';
    }
  }
  return new URLSearchParams(text).get('signed_request') ?? '';
}

export async function handleMetaCallback(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const path = new URL(req.url).pathname;
  const job = path === '/meta/deauthorize' ? 'meta_deauthorize' : DELETION_JOB;

  const payload = await verifySignedRequest(await readSignedRequest(req), env.THREADS_APP_SECRET);
  if (!payload) {
    await logJob(env, job, false, 'signed_request 驗證失敗');
    return json({ error: 'invalid_signed_request' }, 400);
  }
  if (!signedRequestFresh(payload)) {
    await logJob(env, job, false, 'signed_request 太舊（issued_at 超過 1 天），不處理');
    return json({ error: 'stale_signed_request' }, 400);
  }

  // 只記「是不是同一個人」，不記 user id 本身。
  // 通知的人不是 Max（例如之後加的測試帳號移除了 app）→ 不動 Max 的 token 與資料：我們沒有存那個人的 Threads 資料
  const tok = await env.DB.prepare("SELECT user_id FROM app_tokens WHERE provider = 'threads'").first<{ user_id: string | null }>();
  const match = userMatch(tok?.user_id, !!tok, payload.user_id);
  const isOwner = match === 'yes' || match === 'unknown';

  if (path === '/meta/deauthorize') {
    if (isOwner) {
      await env.DB.prepare("DELETE FROM app_tokens WHERE provider = 'threads'").run();
      await logJob(env, job, true, `token deleted; user_match=${match}`);
    } else {
      await logJob(env, job, true, `不是 Max 的帳號，沒有動任何資料; user_match=${match}`);
    }
    return json({ ok: true });
  }

  // 刪除資料：權杖＋所有從 Threads 拿到的資料（自己帳號的數據、貼文、已送出留言與成效）
  const code = randomId(12);
  if (isOwner) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM app_tokens WHERE provider = 'threads'"),
      env.DB.prepare('DELETE FROM own_daily'),
      env.DB.prepare('DELETE FROM own_post_snapshots'),
      env.DB.prepare('DELETE FROM own_posts'),
      env.DB.prepare('DELETE FROM reply_snapshots'),
      env.DB.prepare('DELETE FROM posted_comments'),
    ]);
    await logJob(env, DELETION_JOB, true, `code=${code}; user_match=${match}`);
  } else {
    // 還是回確認碼給 Meta：這個人在系統裡沒有任何 Threads 資料，刪除狀態＝已完成
    await logJob(env, DELETION_JOB, true, `code=${code}; user_match=${match}; 這個帳號沒有存資料，沒有刪任何東西`);
  }
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return json({ url: `${base}/data-deletion?code=${code}`, confirmation_code: code });
}
