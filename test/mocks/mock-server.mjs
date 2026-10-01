// 本機 mock：一個 Node http server 同時假扮 LINE、Threads、Anthropic 三家 API。
// 只給測試用，不需要任何套件。
//
// 用法
//   獨立啟動：node test/mocks/mock-server.mjs --port 0      （印出 MOCK_READY http://127.0.0.1:<port>）
//   程式內：  import { startMockServer } from './mock-server.mjs'; const m = await startMockServer();
//
// 控制端點
//   GET  /__health               → {ok:true}
//   GET  /__calls?service=&since= → {calls:[...]}  每一個 API 呼叫的紀錄（method, path, query, headers 子集, body, status）
//   POST /__reset                → 清空紀錄、設定回預設
//   GET  /__config               → 目前設定
//   POST /__config  {..}         → 深度合併進設定（陣列整個取代）。例：{"anthropic":{"queue":["refusal"]}}
//
// 紀錄裡不存 Authorization / x-api-key / client_secret 的值，只記「有沒有、對不對」。

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// 1x1 透明 PNG
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Threads 回傳的時間格式：2026-09-28T04:34:00+0000
export function graphTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

// 20 則假留言（台灣口語、沒有網址、彼此不像）。每次呼叫輪流取 5 則
export const COMMENT_POOL = [
  '這個流程我也卡過，最後是把步驟先寫成清單才順',
  '想問一下，你們是一開始就全自動，還是先半自動跑一陣子？',
  '看完默默去檢查自己的報價單，好像真的可以省一半時間',
  '同意，工具其實不是重點，重點是有沒有人願意維護它',
  '第三點很實用，我之前都漏掉交接那一步',
  '笑死，我的自動化最後都變成手動複製貼上',
  '補充一個：每週固定回頭看數據，比一直換工具有用',
  '這種小改善最有感，省下來的時間可以拿去陪家人',
  '請問遇到例外狀況的時候，你們是怎麼處理的？',
  '我自己的做法是先拿一個小流程試，跑順了再擴大',
  '標題就戳到我了，每週三小時真的不是小數字',
  '原來大家都有這個困擾，看留言區覺得被安慰到',
  '好奇這套做法在小團隊也適用嗎？我們只有三個人',
  '有種看到自己上個月的樣子，那時候也是一直加班對資料',
  '這篇先收藏，下週開會拿來跟同事討論',
  '我覺得最難的是第一步，願意承認現在的流程有問題',
  '如果能再分享一下失敗的經驗就更好了，那通常最有用',
  '感覺可以再加一個檢查點，避免資料錯了沒人發現',
  '身邊朋友也在試類似的方法，回饋都說比想像中簡單',
  '這讓我想到以前手動對帳對到半夜的日子',
];

export function defaultConfig() {
  return {
    line: {
      channelAccessToken: null, // 設了就檢查 Authorization: Bearer <這個值>，不對回 401
      replyStatus: null,        // 強制 reply 回這個狀態碼（例 400 = token 過期）
      pushStatus: null,         // 強制 push 回這個狀態碼（例 429 = 本月額度用完）
      pushFailTimes: 0,         // 前 N 次 push 回 500（測「同一把 retry key 重試」）
      loadingStatus: null,
      quota: { type: 'limited', value: 200 },
      consumption: null,        // null = 用 mock 收過的 push 次數
      contentStatus: null,
      contentSize: null,        // 設數字 = 回傳這麼大的假圖（測 >5MB 拒收）
      strict: true,             // 檢查訊息數、altText、按鈕長度等 LINE 限制，違規回 400
    },
    threads: {
      appId: null,              // 設了就檢查 client_id
      user: { id: '1234567890123', username: 'e2e_max' },
      shortToken: 'THQVe2eShortToken0001',
      longToken: 'THQVe2eLongToken0001',
      longExpiresIn: 5183944,
      refreshExpiresIn: 5184000,
      rejectCodes: ['bad'],     // 這些 code 換 token 會失敗
      replies: [],              // /me/replies 回傳的資料（ThreadsMedia 陣列）
      threads: [],              // /me/threads 回傳的資料
      insights: {},             // mediaId → {views, likes, replies, reposts, quotes, shares}
      notFoundIds: [],          // 這些 mediaId 查 insights 回「不存在」
      errorMode: null,          // 'rate_limit' | 'auth' | 'server'：所有 Graph API 都回這種錯
      userInsights: {
        viewsSeries: [120, 80],
        likes: 12, replies: 3, reposts: 1, quotes: 0,
        clicks: [{ value: 4, link_url: 'https://example.com/a' }],
        followers_count: 321,
      },
      checkToken: true,         // 只接受 mock 自己發出去的 token
    },
    anthropic: {
      apiKey: null,             // 設了就檢查 x-api-key
      mode: 'ok',               // ok | skip | refusal | invalid | max_tokens | error | dupes | urls | empty
      queue: [],                // 優先用掉的模式，一次一個，例 ['refusal']
      errorStatus: 500,
      delayMs: 0,
      strict: true,             // 模擬 API 硬規則（sampling 參數、budget_tokens、Haiku 帶 effort、prefill）
      usage: { input_tokens: 1950, output_tokens: 1040, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      comments: null,           // 直接指定 5 則 [{text, mentions_product}]
      skipReason: '貼文內容跟個人危機有關',
    },
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src ?? {})) {
    if (isPlainObject(v) && isPlainObject(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

function freshState() {
  return {
    config: defaultConfig(),
    calls: [],
    seq: 0,
    usedReplyTokens: new Set(),
    acceptedRetryKeys: new Map(), // retryKey → requestId
    pushAccepted: 0,
    pushFailed: 0,
    issuedTokens: new Set(),
    refreshCount: 0,
    anthropicCalls: 0,
    commentCalls: 0,
  };
}

// ---------------------------------------------------------------------------
// 共用

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf ? body : body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const h = { ...headers };
  if (!isBuf && typeof body !== 'string' && body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  res.writeHead(status, h);
  res.end(payload);
  return status;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(buf, contentType) {
  if (!buf.length) return null;
  const s = buf.toString('utf8');
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(s));
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const SECRET_FIELDS = new Set(['client_secret']);

function maskSecrets(obj) {
  if (!isPlainObject(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = SECRET_FIELDS.has(k) && v ? '***' : v;
  return out;
}

function headerSubset(req) {
  const h = req.headers;
  const out = {};
  for (const k of ['content-type', 'x-line-retry-key', 'anthropic-version', 'anthropic-beta', 'user-agent']) {
    if (h[k] !== undefined) out[k] = h[k];
  }
  if (h.authorization !== undefined) out.authorization = h.authorization.startsWith('Bearer ') ? 'Bearer ***' : '***';
  if (h['x-api-key'] !== undefined) out['x-api-key'] = '***';
  return out;
}

function lineError(message, details) {
  return details ? { message, details } : { message };
}

function byteLen(v) {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

// 走訪 flex / 訊息 JSON，檢查 LINE 的長度限制。回傳違規清單
function lineMessageProblems(messages) {
  const problems = [];
  if (!Array.isArray(messages) || messages.length === 0) problems.push('messages 必須是 1–5 個');
  else if (messages.length > 5) problems.push(`messages 超過 5 個（${messages.length}）`);
  for (const [i, m] of (Array.isArray(messages) ? messages : []).entries()) {
    if (!m || typeof m.type !== 'string') {
      problems.push(`messages[${i}] 沒有 type`);
      continue;
    }
    if (m.type === 'text') {
      if (typeof m.text !== 'string' || m.text.length === 0) problems.push(`messages[${i}].text 是空的`);
      else if (m.text.length > 5000) problems.push(`messages[${i}].text 超過 5000 字`);
    }
    if (m.type === 'flex') {
      if (typeof m.altText !== 'string' || !m.altText) problems.push(`messages[${i}].altText 是空的`);
      else if (m.altText.length > 400) problems.push(`messages[${i}].altText 超過 400 字`);
      const c = m.contents;
      if (!c || (c.type !== 'bubble' && c.type !== 'carousel')) problems.push(`messages[${i}].contents 要是 bubble 或 carousel`);
      if (c?.type === 'carousel') {
        if (!Array.isArray(c.contents) || c.contents.length === 0) problems.push('carousel 沒有 bubble');
        else if (c.contents.length > 12) problems.push(`carousel 超過 12 個 bubble（${c.contents.length}）`);
        if (byteLen(c) > 50 * 1024) problems.push('carousel JSON 超過 50 KB');
      }
      if (c?.type === 'bubble' && byteLen(c) > 30 * 1024) problems.push('bubble JSON 超過 30 KB');
    }
    if (m.type === 'template' && m.altText && m.altText.length > 400) problems.push(`messages[${i}].altText 超過 400 字`);
    const qr = m.quickReply?.items;
    if (qr !== undefined) {
      if (!Array.isArray(qr) || qr.length > 13) problems.push(`messages[${i}].quickReply 超過 13 顆`);
    }
    if (Array.isArray(messages) && m.quickReply && i !== messages.length - 1) {
      // LINE 只顯示最後一則的 quick reply；不算錯，只是沒用
    }
    walk(m, (o) => {
      if (o.type === 'uri' && 'uri' in o) {
        if (typeof o.uri !== 'string' || o.uri.length > 1000) problems.push(`uri action 超過 1000 字`);
      }
      if (o.type === 'postback' && 'data' in o) {
        if (typeof o.data !== 'string' || o.data.length > 300) problems.push('postback data 超過 300 字');
        if (o.displayText !== undefined && String(o.displayText).length > 300) problems.push('postback displayText 超過 300 字');
      }
      if (o.type === 'clipboard' && 'clipboardText' in o) {
        if (typeof o.clipboardText !== 'string' || o.clipboardText.length > 1000) problems.push('clipboardText 超過 1000 字');
      }
      if (o.type === 'message' && 'text' in o && o.label !== undefined) {
        if (String(o.text).length > 300) problems.push('message action text 超過 300 字');
      }
    });
  }
  return problems;
}

function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const x of node) walk(x, visit);
  } else if (isPlainObject(node)) {
    visit(node);
    for (const v of Object.values(node)) walk(v, visit);
  }
}

// ---------------------------------------------------------------------------
// LINE

function handleLine(state, req, res, url, body, rec) {
  const cfg = state.config.line;
  const reqId = randomUUID();
  const H = { 'x-line-request-id': reqId };
  const p = url.pathname;
  rec.requestId = reqId; // 回給 Worker 的 x-line-request-id，e2e 用來比對 line_push_log.request_id

  const auth = req.headers.authorization;
  rec.auth = !auth ? 'missing' : cfg.channelAccessToken && auth !== `Bearer ${cfg.channelAccessToken}` ? 'bad' : 'ok';
  if (rec.auth !== 'ok') {
    return send(res, 401, lineError('Authentication failed. Confirm that the access token in the authorization header is valid.'), H);
  }

  if (req.method === 'POST' && p === '/v2/bot/message/reply') {
    if (cfg.replyStatus) return send(res, cfg.replyStatus, lineError(cfg.replyStatus === 400 ? 'Invalid reply token' : 'forced error'), H);
    if (!body || typeof body.replyToken !== 'string' || !body.replyToken) return send(res, 400, lineError('Invalid reply token'), H);
    if (state.usedReplyTokens.has(body.replyToken)) return send(res, 400, lineError('Invalid reply token'), H);
    if (cfg.strict) {
      const problems = lineMessageProblems(body.messages);
      if (problems.length) return send(res, 400, lineError('The request body has errors', problems.map((m) => ({ message: m }))), H);
    }
    state.usedReplyTokens.add(body.replyToken);
    return send(res, 200, { sentMessages: body.messages.map(() => ({ id: String(Date.now()), quoteToken: 'q_' + randomUUID() })) }, H);
  }

  if (req.method === 'POST' && p === '/v2/bot/message/push') {
    const retryKey = req.headers['x-line-retry-key'];
    if (retryKey && state.acceptedRetryKeys.has(retryKey)) {
      return send(res, 409, lineError('The retry key is already accepted'), { ...H, 'x-line-accepted-request-id': state.acceptedRetryKeys.get(retryKey) });
    }
    if (cfg.pushStatus) {
      state.pushFailed++;
      const msg = cfg.pushStatus === 429 ? 'You have reached your monthly limit.' : 'forced error';
      return send(res, cfg.pushStatus, lineError(msg), H);
    }
    if (state.pushFailed < cfg.pushFailTimes) {
      state.pushFailed++;
      return send(res, 500, lineError('Internal server error'), H);
    }
    if (!body || typeof body.to !== 'string' || !body.to) return send(res, 400, lineError('The property, \'to\', in the request body is invalid'), H);
    if (cfg.strict) {
      const problems = lineMessageProblems(body.messages);
      if (problems.length) return send(res, 400, lineError('The request body has errors', problems.map((m) => ({ message: m }))), H);
    }
    if (retryKey) state.acceptedRetryKeys.set(retryKey, reqId);
    state.pushAccepted++;
    return send(res, 200, { sentMessages: body.messages.map(() => ({ id: String(Date.now()), quoteToken: 'q_' + randomUUID() })) }, H);
  }

  if (req.method === 'POST' && p === '/v2/bot/chat/loading/start') {
    if (cfg.loadingStatus) return send(res, cfg.loadingStatus, lineError('forced error'), H);
    const s = body?.loadingSeconds;
    if (!body || typeof body.chatId !== 'string') return send(res, 400, lineError('chatId is required'), H);
    if (s !== undefined && (typeof s !== 'number' || s < 5 || s > 60 || s % 5 !== 0)) {
      return send(res, 400, lineError('The value of loadingSeconds must be a multiple of 5 between 5 and 60'), H);
    }
    return send(res, 202, {}, H);
  }

  if (req.method === 'GET' && p === '/v2/bot/message/quota') return send(res, 200, cfg.quota, H);
  if (req.method === 'GET' && p === '/v2/bot/message/quota/consumption') {
    return send(res, 200, { totalUsage: cfg.consumption ?? state.pushAccepted }, H);
  }

  const m = p.match(/^\/v2\/bot\/message\/([^/]+)\/content$/);
  if (req.method === 'GET' && m) {
    if (cfg.contentStatus) return send(res, cfg.contentStatus, lineError('Not found'), H);
    let buf = Buffer.from(TINY_PNG_BASE64, 'base64');
    if (cfg.contentSize && cfg.contentSize > buf.length) buf = Buffer.concat([buf, Buffer.alloc(cfg.contentSize - buf.length)]);
    return send(res, 200, buf, { ...H, 'content-type': 'image/png', 'content-length': String(buf.length) });
  }

  return send(res, 404, lineError('Not found'), H);
}

// ---------------------------------------------------------------------------
// Threads（Graph API 風格）

function graphError(message, code, type = 'OAuthException', subcode) {
  const e = { message, type, code, fbtrace_id: 'mock' + Math.random().toString(36).slice(2, 10) };
  if (subcode !== undefined) e.error_subcode = subcode;
  return { error: e };
}

function pickFields(obj, fieldsParam) {
  if (!fieldsParam) return { id: obj.id };
  const fields = String(fieldsParam).split(',').map((s) => s.trim()).filter(Boolean);
  const out = { id: obj.id };
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

function hashNum(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function mediaInsightValues(state, id) {
  const o = state.config.threads.insights[id];
  if (o) return o;
  const h = hashNum(id);
  return { views: 100 + (h % 900), likes: h % 20, replies: h % 5, reposts: h % 3, quotes: h % 2, shares: h % 4 };
}

function paginate(list, url, origin) {
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 25));
  const after = url.searchParams.get('after');
  const start = after ? Number(Buffer.from(after, 'base64').toString('utf8')) || 0 : 0;
  const page = list.slice(start, start + limit);
  const paging = { cursors: { before: Buffer.from(String(start)).toString('base64'), after: Buffer.from(String(start + page.length)).toString('base64') } };
  if (start + page.length < list.length) {
    const next = new URL(url.pathname + url.search, origin);
    next.searchParams.set('after', paging.cursors.after);
    paging.next = next.toString();
  }
  return { page, paging };
}

function filterSince(list, url) {
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  return list.filter((x) => {
    const t = Date.parse(x.timestamp) / 1000;
    if (since && t < Number(since)) return false;
    if (until && t > Number(until)) return false;
    return true;
  });
}

function handleThreads(state, req, res, url, body, rec) {
  const cfg = state.config.threads;
  // 版本前綴可有可無：/v1.0/me 與 /me 都收
  const p = url.pathname.replace(/^\/v\d+\.\d+(?=\/)/, '');
  const q = url.searchParams;
  const origin = `http://${req.headers.host}`;

  // THREADS_AUTH_URL 指到這裡時：假裝使用者按了同意，導回 redirect_uri
  if (req.method === 'GET' && p === '/oauth/authorize') {
    const redirectUri = q.get('redirect_uri');
    if (!redirectUri || !q.get('client_id')) return send(res, 400, graphError('Missing redirect_uri or client_id', 100));
    const to = new URL(redirectUri);
    to.searchParams.set('code', 'abc');
    if (q.get('state')) to.searchParams.set('state', q.get('state'));
    return send(res, 302, '', { location: to.toString() + '#_' });
  }

  if (cfg.errorMode) {
    if (cfg.errorMode === 'rate_limit') return send(res, 400, graphError('Application request limit reached', 4, 'OAuthException'));
    if (cfg.errorMode === 'auth') return send(res, 400, graphError('Error validating access token: Session has expired', 190, 'OAuthException', 463));
    return send(res, 500, graphError('An unknown error has occurred.', 1, 'OAuthException'));
  }

  // code → 短效 token
  if (p === '/oauth/access_token') {
    if (req.method !== 'POST') return send(res, 400, graphError('Unsupported get request.', 100));
    const f = { ...Object.fromEntries(q), ...(isPlainObject(body) ? body : {}) };
    rec.oauthCode = f.code ?? null;
    if (!f.client_id || !f.client_secret || !f.redirect_uri || !f.code) return send(res, 400, graphError('Missing required parameter', 100));
    if (cfg.appId && String(f.client_id) !== String(cfg.appId)) return send(res, 400, graphError('Invalid client_id', 101));
    if (f.grant_type !== 'authorization_code') return send(res, 400, graphError('Invalid grant_type', 100));
    if (cfg.rejectCodes.includes(f.code) || String(f.code).includes('#')) {
      return send(res, 400, graphError('Error validating verification code.', 100, 'OAuthException', 36008));
    }
    state.issuedTokens.add(cfg.shortToken);
    return send(res, 200, { access_token: cfg.shortToken, token_type: 'bearer', user_id: Number(cfg.user.id) });
  }

  // 取得目前這次請求帶的 token（query 或 Authorization header）
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = q.get('access_token') || bearer || null;
  rec.tokenVia = q.get('access_token') ? 'query' : bearer ? 'header' : 'none';
  rec.token = token; // mock 自己發的假 token，不是機密

  const tokenOk = () => !cfg.checkToken || (token && state.issuedTokens.has(token));
  const badToken = () => send(res, 400, graphError('Invalid OAuth access token - Cannot parse access token', 190));

  // 短效 → 長效
  if (req.method === 'GET' && p === '/access_token') {
    if (q.get('grant_type') !== 'th_exchange_token') return send(res, 400, graphError('Invalid grant_type', 100));
    if (!q.get('client_secret')) return send(res, 400, graphError('Missing client_secret', 100));
    if (!tokenOk()) return badToken();
    state.issuedTokens.add(cfg.longToken);
    return send(res, 200, { access_token: cfg.longToken, token_type: 'bearer', expires_in: cfg.longExpiresIn });
  }

  // 長效續期
  if (req.method === 'GET' && p === '/refresh_access_token') {
    if (q.get('grant_type') !== 'th_refresh_token') return send(res, 400, graphError('Invalid grant_type', 100));
    if (!tokenOk()) return badToken();
    state.refreshCount++;
    const t = `${cfg.longToken}R${state.refreshCount}`;
    state.issuedTokens.add(t);
    return send(res, 200, { access_token: t, token_type: 'bearer', expires_in: cfg.refreshExpiresIn });
  }

  if (req.method !== 'GET') return send(res, 400, graphError('Unsupported request', 100));
  if (!tokenOk()) return badToken();

  const userIds = new Set(['me', String(cfg.user.id)]);
  const seg = p.split('/').filter(Boolean);

  if (seg.length === 1 && userIds.has(seg[0])) {
    return send(res, 200, pickFields({ id: String(cfg.user.id), username: cfg.user.username, name: 'E2E Max' }, q.get('fields') || 'id'));
  }

  if (seg.length === 2 && userIds.has(seg[0]) && (seg[1] === 'replies' || seg[1] === 'threads')) {
    const src = seg[1] === 'replies' ? cfg.replies : cfg.threads;
    const list = filterSince(src, url);
    const { page, paging } = paginate(list, url, origin);
    return send(res, 200, { data: page.map((x) => pickFields(x, q.get('fields'))), paging });
  }

  if (seg.length === 2 && userIds.has(seg[0]) && seg[1] === 'threads_insights') {
    const metrics = (q.get('metric') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!metrics.length) return send(res, 400, graphError('The parameter metric is required', 100));
    const ui = cfg.userInsights;
    const uid = String(cfg.user.id);
    const data = [];
    for (const name of metrics) {
      const base = { name, period: 'day', title: name, description: `mock ${name}`, id: `${uid}/insights/${name}/day` };
      if (name === 'views') {
        const until = Number(q.get('until')) || Math.floor(Date.now() / 1000);
        data.push({ ...base, values: ui.viewsSeries.map((v, i) => ({ value: v, end_time: graphTime((until - (ui.viewsSeries.length - 1 - i) * 86400) * 1000) })) });
      } else if (name === 'clicks') {
        data.push({ ...base, link_total_values: ui.clicks });
      } else if (name in ui) {
        data.push({ ...base, total_value: { value: ui[name] } });
      } else {
        return send(res, 400, graphError(`(#100) metric[${name}] must be one of the following values: views, likes, replies, reposts, quotes, clicks, followers_count, follower_demographics`, 100));
      }
    }
    return send(res, 200, { data });
  }

  if (seg.length === 2 && seg[1] === 'insights') {
    const id = seg[0];
    if (cfg.notFoundIds.includes(id)) {
      return send(res, 400, graphError(`Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`, 100, 'GraphMethodException', 33));
    }
    const metrics = (q.get('metric') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!metrics.length) return send(res, 400, graphError('The parameter metric is required', 100));
    const vals = mediaInsightValues(state, id);
    const data = [];
    for (const name of metrics) {
      if (!(name in vals)) return send(res, 400, graphError(`(#100) metric[${name}] must be one of the following values: views, likes, replies, reposts, quotes, shares`, 100));
      data.push({ name, period: 'lifetime', values: [{ value: vals[name] }], title: name, description: `mock ${name}`, id: `${id}/insights/${name}/lifetime` });
    }
    return send(res, 200, { data });
  }

  return send(res, 400, graphError(`Unsupported get request. Object with ID '${seg[0] ?? ''}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`, 100, 'GraphMethodException', 33));
}

// ---------------------------------------------------------------------------
// Anthropic

function anthropicError(status, type, message) {
  return { type: 'error', error: { type, message }, request_id: 'req_mock_' + Math.random().toString(36).slice(2, 12) };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n');
}

function systemText(system) {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

export function detectPurpose(body) {
  const props = body?.output_config?.format?.schema?.properties;
  if (isPlainObject(props)) {
    if ('comments' in props) return 'comments';
    if ('keywords' in props) return 'keywords';
    if ('topics' in props) return 'topics';
  }
  const all = systemText(body?.system) + '\n' + (body?.messages ?? []).map((m) => contentText(m.content)).join('\n');
  if (/topics|主題/.test(all) && !/comments|留言/.test(all)) return 'topics';
  if (/keywords|關鍵字/.test(all) && !/comments|留言/.test(all)) return 'keywords';
  return 'comments';
}

function anthropicRuleProblems(body, req, isBeta) {
  const problems = [];
  const model = String(body.model || '');
  const beta = String(req.headers['anthropic-beta'] || '');
  if (/^claude-(opus|sonnet)-5/.test(model)) {
    for (const k of ['temperature', 'top_p', 'top_k']) if (body[k] !== undefined) problems.push(`${k} is not supported on ${model}`);
    if (body.thinking && body.thinking.budget_tokens !== undefined) problems.push(`thinking.budget_tokens is not supported on ${model}`);
  }
  if (/^claude-haiku-4-5/.test(model) && body.output_config && body.output_config.effort !== undefined) {
    problems.push('output_config.effort is not supported on claude-haiku-4-5');
  }
  if (body.fallbacks !== undefined && (!isBeta || !beta.includes('server-side-fallback'))) {
    problems.push('fallbacks: Extra inputs are not permitted (needs the server-side-fallback beta)');
  }
  const msgs = body.messages;
  if (Array.isArray(msgs) && msgs.length && msgs[msgs.length - 1]?.role === 'assistant') {
    problems.push('This model does not support assistant message prefill. The conversation must end with a user message.');
  }
  const fmt = body.output_config?.format;
  if (fmt !== undefined && (fmt.type !== 'json_schema' || !isPlainObject(fmt.schema))) {
    problems.push('output_config.format must be {type:"json_schema", schema:{...}}');
  }
  return problems;
}

function findIndexes(text) {
  const set = new Set();
  const re = /(?:^|\n)\s*[[#(（]?\s*(\d{1,3})\s*[\]).:：、）]/g;
  let m;
  while ((m = re.exec(text))) set.add(Number(m[1]));
  const arr = [...set].sort((a, b) => a - b);
  return arr.length ? arr : [0, 1, 2, 3, 4, 5, 6, 7];
}

function buildComments(state, cfg, mode, body) {
  if (Array.isArray(cfg.comments)) return cfg.comments;
  const n = state.commentCalls++;
  const all = systemText(body.system) + '\n' + (body.messages ?? []).map((m) => contentText(m.content)).join('\n');
  const short = /shorter|再短/.test(all);
  const pool = short ? COMMENT_POOL.filter((t) => t.length <= 40) : COMMENT_POOL;
  const out = [];
  for (let i = 0; i < 5; i++) {
    const text = pool[(n * 5 + i) % pool.length];
    out.push({ text, mentions_product: i === 2 || i === 4 });
  }
  if (mode === 'dupes') return out.map((c, i) => ({ text: out[0].text + (i ? '！' : ''), mentions_product: false }));
  if (mode === 'urls') return out.map((c, i) => ({ ...c, text: i % 2 ? `${c.text} https://example.com/x` : `${c.text} 看 maxstudio.biz` }));
  if (mode === 'empty') return [];
  return out;
}

async function handleAnthropic(state, req, res, url, body, rec) {
  const cfg = state.config.anthropic;
  const H = { 'request-id': 'req_mock_' + Math.random().toString(36).slice(2, 12) };
  const isBeta = url.searchParams.get('beta') === 'true';
  rec.beta = isBeta;

  if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
    return send(res, 404, anthropicError(404, 'not_found_error', `Not found: ${req.method} ${url.pathname}`), H);
  }
  const key = req.headers['x-api-key'];
  rec.auth = !key ? 'missing' : cfg.apiKey && key !== cfg.apiKey ? 'bad' : 'ok';
  if (rec.auth !== 'ok') return send(res, 401, anthropicError(401, 'authentication_error', 'invalid x-api-key'), H);
  if (!req.headers['anthropic-version']) return send(res, 400, anthropicError(400, 'invalid_request_error', 'anthropic-version header is required'), H);
  if (!isPlainObject(body)) return send(res, 400, anthropicError(400, 'invalid_request_error', 'body must be JSON'), H);
  if (!body.model || typeof body.max_tokens !== 'number' || !Array.isArray(body.messages) || !body.messages.length) {
    return send(res, 400, anthropicError(400, 'invalid_request_error', 'model, max_tokens and messages are required'), H);
  }
  if (body.stream) return send(res, 400, anthropicError(400, 'invalid_request_error', 'mock does not support stream: true'), H);
  if (cfg.strict) {
    const problems = anthropicRuleProblems(body, req, isBeta);
    if (problems.length) {
      rec.ruleProblems = problems;
      return send(res, 400, anthropicError(400, 'invalid_request_error', problems.join('; ')), H);
    }
  }

  state.anthropicCalls++;
  const mode = cfg.queue.length ? cfg.queue.shift() : cfg.mode;
  const purpose = detectPurpose(body);
  rec.mode = mode;
  rec.purpose = purpose;
  if (cfg.delayMs) await new Promise((r) => setTimeout(r, cfg.delayMs));

  if (mode === 'error') {
    const st = cfg.errorStatus || 500;
    const type = st === 429 ? 'rate_limit_error' : st === 529 ? 'overloaded_error' : 'api_error';
    return send(res, st, anthropicError(st, type, 'mock forced error'), H);
  }

  const base = {
    id: 'msg_mock_' + state.anthropicCalls,
    type: 'message',
    role: 'assistant',
    model: body.model,
    stop_sequence: null,
    stop_details: null,
    usage: { ...cfg.usage },
  };

  if (mode === 'refusal') {
    return send(res, 200, { ...base, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: null } }, H);
  }
  if (mode === 'invalid') {
    return send(res, 200, { ...base, content: [{ type: 'text', text: '這不是 JSON {' }], stop_reason: 'end_turn' }, H);
  }

  let data;
  if (purpose === 'comments') {
    if (mode === 'skip') data = { skip: true, skip_reason: cfg.skipReason, summary: '貼文內容涉及個人危機', comments: [] };
    else data = { skip: false, skip_reason: '', summary: '作者分享用 AI 把報價流程自動化、每週省下時間的經驗', comments: buildComments(state, cfg, mode, body) };
  } else if (purpose === 'keywords') {
    data = {
      keywords: [
        { keyword: 'AI 自動化', why: '觀看最高的三篇都在講這個' },
        { keyword: '報價單', why: '實際案例型貼文按讚多' },
        { keyword: '工作流程', why: '留言區常有人追問細節' },
        { keyword: '省時間', why: '標題有具體時數的表現較好' },
        { keyword: '小團隊', why: '讀者多是 3–10 人的公司' },
        { keyword: '數據追蹤', why: '有附數字的貼文轉發多' },
        { keyword: '交接', why: '談交接的貼文收藏多' },
      ],
    };
  } else {
    const idx = findIndexes((body.messages ?? []).map((m) => contentText(m.content)).join('\n'));
    const names = ['AI 工具實測', '流程自動化', '接案心得', '生活碎念'];
    data = { topics: names.map((name, t) => ({ name, post_indexes: idx.filter((_, i) => i % names.length === t) })) };
  }

  const text = JSON.stringify(data);
  if (mode === 'max_tokens') {
    return send(res, 200, { ...base, content: [{ type: 'text', text: text.slice(0, Math.floor(text.length / 2)) }], stop_reason: 'max_tokens' }, H);
  }
  return send(res, 200, { ...base, content: [{ type: 'text', text }], stop_reason: 'end_turn' }, H);
}

// ---------------------------------------------------------------------------
// 伺服器

function serviceOf(pathname) {
  if (pathname.startsWith('/__')) return 'control';
  if (pathname.startsWith('/v2/bot/')) return 'line';
  if (pathname.startsWith('/v1/messages') || pathname.startsWith('/v1/')) return 'anthropic';
  return 'threads';
}

export async function startMockServer({ host = '127.0.0.1', port = 0, log = false } = {}) {
  const state = freshState();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const service = serviceOf(url.pathname);
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return send(res, 400, { error: 'bad body' });
    }
    const body = parseBody(raw, req.headers['content-type']);

    if (service === 'control') {
      if (url.pathname === '/__health') return send(res, 200, { ok: true });
      if (url.pathname === '/__calls' && req.method === 'GET') {
        const svc = url.searchParams.get('service');
        const since = Number(url.searchParams.get('since') || 0);
        return send(res, 200, { calls: state.calls.filter((c) => (!svc || c.service === svc) && c.seq > since) });
      }
      if (url.pathname === '/__reset' && req.method === 'POST') {
        const fresh = freshState();
        Object.assign(state, fresh);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/__config') {
        if (req.method === 'POST') {
          if (!isPlainObject(body)) return send(res, 400, { error: 'JSON object required' });
          deepMerge(state.config, body);
        }
        return send(res, 200, { config: state.config });
      }
      return send(res, 404, { error: 'unknown control endpoint' });
    }

    const rec = {
      seq: ++state.seq,
      at: Date.now(),
      service,
      method: req.method,
      path: url.pathname,
      query: maskSecrets(Object.fromEntries(url.searchParams)),
      headers: headerSubset(req),
      body: Buffer.isBuffer(body) ? `<${raw.length} bytes>` : maskSecrets(body),
      status: 0,
    };
    state.calls.push(rec);
    try {
      if (service === 'line') rec.status = handleLine(state, req, res, url, body, rec);
      else if (service === 'anthropic') rec.status = await handleAnthropic(state, req, res, url, body, rec);
      else rec.status = handleThreads(state, req, res, url, body, rec);
    } catch (err) {
      rec.status = 500;
      rec.error = String(err?.stack || err);
      if (!res.headersSent) send(res, 500, { error: 'mock crashed', detail: String(err) });
    }
    if (log) console.log(`[mock] ${rec.status} ${rec.method} ${rec.path}`);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}`;

  return {
    port: actualPort,
    url,
    server,
    state,
    calls: (service) => state.calls.filter((c) => !service || c.service === service),
    reset: () => Object.assign(state, freshState()),
    setConfig: (patch) => deepMerge(state.config, patch),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// 直接執行：node test/mocks/mock-server.mjs [--port N] [--host H] [--log]
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const get = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const m = await startMockServer({ host: get('--host', '127.0.0.1'), port: Number(get('--port', '0')), log: args.includes('--log') });
  console.log(`MOCK_READY ${m.url}`);
  const stop = async () => {
    await m.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
