#!/usr/bin/env node
// E2E：在本機把整支 Worker 跑起來（wrangler dev --local），外部 API 全部指到 mock，跑 SPEC §5 的情境。
//
//   npm run test:e2e              一般跑法
//   node test/e2e/run.mjs --verbose   同時印出 wrangler dev 的輸出
//
// 流程：挑空的 port → 在 .e2e/ 寫假 secret → 本機套 migration → 起 mock 與 wrangler dev → 跑情境 → 關掉所有子程序。
// 不連任何外部服務（wrangler 的遙測也關掉）。狀態檔留在 .e2e/ 方便除錯，下次跑會先清掉。

import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer, TINY_PNG_BASE64, graphTime } from '../mocks/mock-server.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRANGLER = path.join(APP, 'node_modules', '.bin', 'wrangler');
const E2E_DIR = path.join(APP, '.e2e');
const STATE = path.join(E2E_DIR, 'state');
const DEV_VARS = path.join(E2E_DIR, '.dev.vars');
const DEV_LOG = path.join(E2E_DIR, 'wrangler-dev.log');
const VERBOSE = process.argv.includes('--verbose');
const OVERALL_TIMEOUT_MS = 8 * 60_000;

const ADMIN = 'U_admin';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// 假 secret：每次跑都重新產生，只存在 .e2e/.dev.vars（已 gitignore）
const SECRETS = {
  LINE_CHANNEL_SECRET: 'e2e-line-secret-' + randomBytes(8).toString('hex'),
  LINE_CHANNEL_ACCESS_TOKEN: 'e2e-line-token-' + randomBytes(8).toString('hex'),
  LINE_ADMIN_USER_ID: ADMIN,
  THREADS_APP_ID: '1234567890',
  THREADS_APP_SECRET: 'e2e-threads-secret-' + randomBytes(8).toString('hex'),
  ANTHROPIC_API_KEY: 'sk-ant-e2e-' + randomBytes(8).toString('hex'),
  DASH_PASSWORD: 'correct-horse-battery',
  SESSION_SECRET: randomBytes(32).toString('base64'),
  TOKEN_ENC_KEY: randomBytes(32).toString('base64'),
};

// ---------------------------------------------------------------------------
// 子程序管理：全部用獨立 process group，結束時整組砍掉（wrangler 底下還有 workerd）

const children = new Set();
let devProc = null;
let devExited = null; // 結束時記下 exit code
let devLogBuf = '';
let mock = null;
let cleaningUp = false;

function childEnv() {
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0' };
  // 確保不會碰到遠端帳號，也不會把本機環境變數灌進 Worker
  for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CLOUDFLARE_INCLUDE_PROCESS_ENV']) delete env[k];
  return env;
}

function spawnTracked(cmd, args, opts = {}) {
  const cp = spawn(cmd, args, { cwd: APP, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...opts });
  children.add(cp);
  cp.on('exit', () => children.delete(cp));
  return cp;
}

function killGroup(cp, signal) {
  try {
    process.kill(-cp.pid, signal);
  } catch {
    try {
      cp.kill(signal);
    } catch {
      /* 已經結束 */
    }
  }
}

async function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const cp of children) killGroup(cp, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (children.size && Date.now() < deadline) await sleep(100);
  for (const cp of children) killGroup(cp, 'SIGKILL');
  if (mock) await mock.close().catch(() => {});
}

process.on('exit', () => {
  for (const cp of children) killGroup(cp, 'SIGKILL');
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    console.error(`\n收到 ${sig}，關閉子程序…`);
    await cleanup();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}
process.on('uncaughtException', async (err) => {
  console.error('未預期的錯誤：', err);
  await cleanup();
  process.exit(1);
});
process.on('unhandledRejection', async (err) => {
  console.error('未處理的 Promise 錯誤：', err);
  await cleanup();
  process.exit(1);
});

// ---------------------------------------------------------------------------
// 小工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(avoid = []) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => (avoid.includes(port) ? freePort(avoid).then(resolve, reject) : resolve(port)));
    });
  });
}

// 跑一個指令並收集輸出（非同步，不會卡住同一個行程裡的 mock server）
function run(cmd, args, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const cp = spawnTracked(cmd, args);
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d) => (stdout += d));
    cp.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => killGroup(cp, 'SIGKILL'), timeoutMs);
    cp.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

async function waitFor(fn, { timeout = 25_000, interval = 150, what = '條件成立' } = {}) {
  const end = Date.now() + timeout;
  let lastErr;
  while (Date.now() < end) {
    if (devExited !== null) throw new Error(`wrangler dev 已經結束（exit ${devExited}），看 .e2e/wrangler-dev.log`);
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if (e?.fatal) throw e;
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`等不到${what}（${timeout} ms）${lastErr ? `；最後的錯誤：${lastErr.message}` : ''}`);
}

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// 用 wrangler d1 execute 讀寫本機 D1（跟 wrangler dev 同一個 --persist-to）
async function d1(sql) {
  const r = await run(WRANGLER, ['d1', 'execute', 'patrol-db', '--local', '--persist-to', STATE, '--json', '--command', sql]);
  if (r.code !== 0) throw new Error(`d1 execute 失敗：${sql}\n${(r.stderr || r.stdout).slice(-1500)}`);
  const i = r.stdout.search(/^\s*\[/m);
  if (i < 0) throw new Error(`d1 execute 沒有 JSON 輸出：${r.stdout.slice(-500)}`);
  const parsed = JSON.parse(r.stdout.slice(i));
  return parsed[parsed.length - 1]?.results ?? [];
}
const d1one = async (sql) => (await d1(sql))[0] ?? null;

function taipeiDateOf(ms) {
  return new Date(ms + 8 * HOUR).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// HTTP 對 Worker

let BASE = '';

async function http(method, p, { body, headers = {}, cookie, ip } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (ip) h['cf-connecting-ip'] = ip;
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') payload = body;
    else {
      payload = JSON.stringify(body);
      h['content-type'] ??= 'application/json';
    }
  }
  const res = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 不是 JSON */
  }
  return { status: res.status, text, json, headers: res.headers, setCookies: res.headers.getSetCookie?.() ?? [] };
}

function sessionCookie(setCookies) {
  for (const c of setCookies) {
    const m = c.match(/^sess=([^;]*)/);
    if (m && m[1] && !/max-age=0/i.test(c) && !/expires=thu, 01 jan 1970/i.test(c)) return `sess=${m[1]}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// LINE webhook

function sign(body) {
  return createHmac('sha256', SECRETS.LINE_CHANNEL_SECRET).update(body).digest('base64');
}

function webhookBody(events) {
  return JSON.stringify({ destination: 'U0e2e0bot0destination0000000000', events });
}

async function postWebhook(events, { raw, signature } = {}) {
  const body = raw ?? webhookBody(events);
  const headers = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-line-signature'] = signature ?? sign(body);
  const res = await fetch(`${BASE}/line/webhook`, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

let evn = 0;
function baseEvent(type, { userId = ADMIN, ts = Date.now(), id } = {}) {
  evn++;
  const tag = `${Date.now().toString(36)}${String(evn).padStart(3, '0')}`;
  return {
    type,
    mode: 'active',
    timestamp: ts,
    source: { type: 'user', userId },
    webhookEventId: id ?? `01E2E${tag.toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`,
    deliveryContext: { isRedelivery: false },
    replyToken: `rt${tag}${randomBytes(6).toString('hex')}`,
  };
}
const msgId = () => `4687895778${String(evn).padStart(8, '0')}`;
const textEvent = (text, o) => {
  const e = baseEvent('message', o);
  return { ...e, message: { id: msgId(), type: 'text', text, quoteToken: 'qt' + e.replyToken } };
};
const imageEvent = (o) => {
  const e = baseEvent('message', o);
  return { ...e, message: { id: msgId(), type: 'image', contentProvider: { type: 'line' }, quoteToken: 'qt' + e.replyToken } };
};
const postbackEvent = (data, o) => ({ ...baseEvent('postback', o), postback: { data } });

// ---------------------------------------------------------------------------
// 讀 mock 的呼叫紀錄

const seqNow = () => mock.state.seq;
const callsSince = (seq, service) => mock.state.calls.filter((c) => c.seq > seq && (!service || c.service === service));

// 找這個事件的回覆：用它的 reply token 回成功，或（token 過期時）push 給 Max
async function waitForAnswer(ev, sinceSeq, timeout = 25_000) {
  return waitFor(
    () =>
      mock.state.calls.find(
        (c) =>
          c.service === 'line' &&
          c.status === 200 &&
          ((c.path === '/v2/bot/message/reply' && c.body?.replyToken === ev.replyToken) ||
            (c.path === '/v2/bot/message/push' && c.seq > sinceSeq && c.body?.to === ADMIN)),
      ),
    { timeout, what: `LINE 回覆（事件 ${ev.webhookEventId}）` },
  );
}

const messagesOf = (call) => (Array.isArray(call?.body?.messages) ? call.body.messages : []);
const flexCarousel = (call) => messagesOf(call).find((m) => m.type === 'flex' && m.contents?.type === 'carousel') ?? null;
const allText = (call) => JSON.stringify(messagesOf(call));

function walk(node, visit) {
  if (Array.isArray(node)) node.forEach((x) => walk(x, visit));
  else if (node && typeof node === 'object') {
    visit(node);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}
function uriActions(node) {
  const out = [];
  walk(node, (o) => {
    if (o.type === 'uri' && typeof o.uri === 'string') out.push(o.uri);
  });
  return out;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' ? b.text : '')).join('\n');
}
function systemOf(body) {
  if (typeof body?.system === 'string') return body.system;
  if (Array.isArray(body?.system)) return body.system.map((b) => b?.text ?? '').join('\n');
  return '';
}
function userTurnOf(body) {
  const users = (body?.messages ?? []).filter((m) => m.role === 'user');
  return users.map((m) => textOfContent(m.content)).join('\n');
}
function imageBlocksOf(body) {
  const out = [];
  for (const m of body?.messages ?? []) if (Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'image') out.push(b);
  return out;
}

// ---------------------------------------------------------------------------
// 情境框架

const results = [];
const ctx = {}; // 情境之間共用的資料（A/B 兩篇貼文的草稿、登入 cookie…）

class Skip extends Error {}
function need(cond, msg) {
  if (!cond) throw new Skip(msg);
}

async function scenario(id, title, fn) {
  const checks = [];
  const check = (name, cond, detail) => {
    checks.push({ name, ok: !!cond, detail: cond ? undefined : detail });
    return !!cond;
  };
  const t0 = Date.now();
  let error = null;
  try {
    await fn(check);
  } catch (e) {
    error = e;
  }
  const ok = !error && checks.length > 0 && checks.every((c) => c.ok);
  const ms = Date.now() - t0;
  results.push({ id, title, ok, ms });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(3)} ${title}  (${(ms / 1000).toFixed(1)}s)`);
  for (const c of checks) {
    if (!c.ok) console.log(`      ✗ ${c.name}${c.detail !== undefined ? `：${typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail).slice(0, 600)}` : ''}`);
    else if (VERBOSE) console.log(`      ✓ ${c.name}`);
  }
  if (error) console.log(`      ${error instanceof Skip ? '略過（前置條件不成立）' : '錯誤'}：${error.message}`);
}

// ---------------------------------------------------------------------------
// 啟動

function tail(file, n = 60) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-n).join('\n');
  } catch {
    return '(沒有 log)';
  }
}

async function setup() {
  if (!fs.existsSync(WRANGLER)) throw new Error(`找不到 ${WRANGLER}，先跑 npm install`);
  fs.rmSync(E2E_DIR, { recursive: true, force: true });
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(DEV_VARS, Object.entries(SECRETS).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n', { mode: 0o600 });

  // mock（同一個行程裡，直接讀它的紀錄）
  mock = await startMockServer({ host: '127.0.0.1', port: 0 });
  mock.setConfig({
    line: { channelAccessToken: SECRETS.LINE_CHANNEL_ACCESS_TOKEN },
    anthropic: { apiKey: SECRETS.ANTHROPIC_API_KEY },
    threads: { appId: SECRETS.THREADS_APP_ID },
  });

  const devPort = await freePort([8799, mock.port]);
  const inspectorPort = await freePort([8799, mock.port, devPort]);
  BASE = `http://127.0.0.1:${devPort}`;

  console.log(`mock  ${mock.url}`);
  console.log(`dev   ${BASE}（inspector ${inspectorPort}）`);
  console.log(`state ${path.relative(APP, STATE)}`);

  // migrations
  const mig = await run(WRANGLER, ['d1', 'migrations', 'apply', 'patrol-db', '--local', '--persist-to', STATE]);
  if (mig.code !== 0) throw new Error(`migration 失敗：\n${(mig.stderr || mig.stdout).slice(-2000)}`);
  const applied = (mig.stdout.match(/\d{4}_[\w-]+\.sql/g) ?? []).filter((v, i, a) => a.indexOf(v) === i);
  console.log(`migrations 已套用：${applied.join('、') || '(看不出來)'}`);

  // 關掉夜間禁送（start = end），不然半夜跑 /go/ 情境一定被擋
  await d1(
    "INSERT INTO settings (key, value, updated_at) VALUES ('night_start', '00:00', 0), ('night_end', '00:00', 0) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const personas = await d1one('SELECT COUNT(*) AS c FROM personas');
  if (!personas?.c) console.log('注意：personas 是空的（migrations/0002_seed.sql 還沒有？），產生留言的情境會失敗');

  const vars = {
    PUBLIC_BASE_URL: BASE,
    LINE_API_BASE: mock.url,
    LINE_DATA_API_BASE: mock.url,
    THREADS_API_BASE: mock.url,
    THREADS_AUTH_URL: `${mock.url}/oauth/authorize`,
    CLAUDE_API_BASE: mock.url,
  };
  const args = [
    'dev', '--local',
    '--ip', '127.0.0.1',
    '--port', String(devPort),
    '--inspector-port', String(inspectorPort),
    '--persist-to', STATE,
    '--env-file', DEV_VARS,
    '--test-scheduled',
    '--show-interactive-dev-session=false',
    '--log-level', 'info',
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
  ];
  const logStream = fs.createWriteStream(DEV_LOG);
  devProc = spawnTracked(WRANGLER, args);
  devProc.stdout.pipe(logStream, { end: false });
  devProc.stderr.pipe(logStream, { end: false });
  const keep = (d) => {
    devLogBuf = (devLogBuf + d).slice(-20_000);
  };
  devProc.stdout.on('data', keep);
  devProc.stderr.on('data', keep);
  if (VERBOSE) {
    devProc.stdout.on('data', (d) => process.stdout.write(`[dev] ${d}`));
    devProc.stderr.on('data', (d) => process.stderr.write(`[dev] ${d}`));
  }
  devProc.on('exit', (code) => {
    devExited = code ?? -1;
  });

  const t0 = Date.now();
  await waitFor(
    async () => {
      if (/Build failed|Could not resolve|No matching export|\[ERROR\] .*(error|failed)/i.test(devLogBuf)) {
        throw Object.assign(new Error('wrangler dev 編譯失敗'), { fatal: true });
      }
      const r = await fetch(`${BASE}/healthz`).catch(() => null);
      return r && r.status === 200;
    },
    { timeout: 120_000, interval: 400, what: 'wrangler dev 啟動（/healthz 回 200）' },
  ).catch((e) => {
    throw new Error(`${e.message}\n--- wrangler dev log ---\n${tail(DEV_LOG)}`);
  });
  console.log(`wrangler dev 已就緒（${((Date.now() - t0) / 1000).toFixed(1)}s）\n`);
}

// ---------------------------------------------------------------------------
// 情境

const POST_A = '今天把報價單流程交給 AI 自動化，以前每週要花三小時對資料，現在十分鐘搞定。重點是先把步驟寫清楚。';
const SC_A = 'E2EA0001';
const SC_B = 'E2EB0002';
const SC_C = 'E2EC0003';
const SC_D = 'E2ED0004';

async function draftsOfTarget(shortcode) {
  const batch = await d1one(
    `SELECT b.id, b.variant, b.target_id FROM draft_batches b JOIN targets t ON t.id = b.target_id WHERE t.shortcode = ${sq(shortcode)} ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1`,
  );
  if (!batch) return null;
  const drafts = await d1(`SELECT id, idx, text, mentions_product, status, target_id FROM comment_drafts WHERE batch_id = ${sq(batch.id)} ORDER BY idx`);
  return { batchId: batch.id, variant: batch.variant, targetId: batch.target_id, drafts };
}

async function s1(check) {
  const ev = textEvent('/說明');
  const body = webhookBody([ev]);
  const good = sign(body);
  const bad = (good[0] === 'A' ? 'B' : 'A') + good.slice(1);
  const r1 = await postWebhook(null, { raw: body, signature: bad });
  check('簽章錯誤 → 401', r1.status === 401, r1.status);
  const r2 = await postWebhook(null, { raw: body, signature: null });
  check('沒有 x-line-signature → 401', r2.status === 401, r2.status);
  const r3 = await postWebhook([]);
  check('Verify（events: []、簽章正確）→ 200', r3.status === 200, r3.status);
  const row = await d1one(`SELECT COUNT(*) AS c FROM line_events WHERE webhook_event_id = ${sq(ev.webhookEventId)}`);
  check('簽章錯誤的事件沒寫進 DB', row?.c === 0, row);
}

async function s2(check) {
  const seq0 = seqNow();
  const evX = textEvent(`https://www.threads.com/@e2e_mallory/post/E2EX0000\n這是陌生人傳來的貼文原文，bot 應該完全不理`, { userId: 'U_stranger' });
  const r = await postWebhook([evX]);
  check('陌生人的事件也回 200（LINE 要求）', r.status === 200, r.status);
  // 屏障：管理員傳一則 /說明，等它回了再檢查陌生人那則
  const barrier = textEvent('/說明');
  await postWebhook([barrier]);
  const ans = await waitForAnswer(barrier, seq0);
  check('管理員的 /說明 有回（屏障）', !!ans);
  check('說明文字有列出指令', allText(ans).includes('/海巡'), allText(ans).slice(0, 200));
  await sleep(1500); // 負向檢查：給可能的延遲處理一點時間
  const line = callsSince(seq0, 'line');
  check('沒有回陌生人', !line.some((c) => c.body?.replyToken === evX.replyToken || c.body?.to === 'U_stranger' || c.body?.chatId === 'U_stranger'),
    line.map((c) => c.path));
  check('沒有呼叫 Anthropic', callsSince(seq0, 'anthropic').length === 0, callsSince(seq0, 'anthropic').length);
  const row = await d1one(`SELECT COUNT(*) AS c FROM line_events WHERE webhook_event_id = ${sq(evX.webhookEventId)}`);
  check('陌生人的事件沒進 line_events', row?.c === 0, row);
}

async function s4(check) {
  const seq0 = seqNow();
  const ev = textEvent('/說明');
  const body = webhookBody([ev]);
  const a = await postWebhook(null, { raw: body });
  const b = await postWebhook(null, { raw: body });
  check('兩次都回 200', a.status === 200 && b.status === 200, [a.status, b.status]);
  await waitForAnswer(ev, seq0);
  const barrier = textEvent('/說明');
  await postWebhook([barrier]);
  await waitForAnswer(barrier, seq0);
  await sleep(1500);
  const replies = callsSince(seq0, 'line').filter((c) => c.path === '/v2/bot/message/reply' && c.body?.replyToken === ev.replyToken);
  check('同一個 webhookEventId 只回覆一次', replies.length === 1, replies.length);
  const pushes = callsSince(seq0, 'line').filter((c) => c.path === '/v2/bot/message/push');
  check('也沒有改用 push 補送', pushes.length === 0, pushes.length);
  const row = await d1one(`SELECT COUNT(*) AS c FROM line_events WHERE webhook_event_id = ${sq(ev.webhookEventId)}`);
  check('line_events 只有一列', row?.c === 1, row);
}

async function s3(check) {
  const seq0 = seqNow();
  const ev = textEvent(`https://www.threads.com/@e2e_alice/post/${SC_A}?xmt=AQGzE2E\n${POST_A}`);
  const r = await postWebhook([ev]);
  check('webhook 回 200', r.status === 200, r.status);
  const ans = await waitForAnswer(ev, seq0);
  const anth = callsSince(seq0, 'anthropic').filter((c) => c.status === 200);
  check('Anthropic 只被呼叫一次', anth.length === 1, anth.length);
  const bad = callsSince(seq0, 'anthropic').filter((c) => c.status !== 200);
  check('Anthropic 請求沒有違反 API 規則（400）', bad.length === 0, bad.map((c) => c.ruleProblems ?? c.status));
  if (anth[0]) {
    const req = anth[0].body;
    const sys = systemOf(req);
    const user = userTurnOf(req);
    check('原文沒有放進 system prompt', !sys.includes('每週要花三小時對資料'), sys.slice(0, 200));
    check('原文在 user turn 的 <post>…</post> 裡', /<post(\s[^>]*)?>[\s\S]*每週要花三小時對資料[\s\S]*<\/post>/.test(user), user.slice(0, 300));
    check('有要求 JSON schema 輸出（output_config.format）', req.output_config?.format?.type === 'json_schema', req.output_config);
  }
  const loading = callsSince(seq0, 'line').find((c) => c.path === '/v2/bot/chat/loading/start');
  check('有先顯示等待動畫（loading/start，chatId = Max）', loading?.body?.chatId === ADMIN, loading?.body);
  if (loading && anth[0]) check('等待動畫在呼叫 Claude 之前', loading.seq < anth[0].seq);
  const flex = flexCarousel(ans);
  check('回覆是 flex carousel', !!flex, messagesOf(ans).map((m) => m.type));
  check('carousel 有 6 個 bubble（5 則 + 控制卡）', flex?.contents?.contents?.length === 6, flex?.contents?.contents?.length);

  const target = await d1one(`SELECT id, author_username, url FROM targets WHERE shortcode = ${sq(SC_A)}`);
  check('targets 有這篇（作者 e2e_alice）', target?.author_username === 'e2e_alice', target);
  const nb = await d1one(`SELECT COUNT(*) AS c FROM draft_batches WHERE target_id = ${target?.id ?? -1}`);
  const nd = await d1one(`SELECT COUNT(*) AS c FROM comment_drafts WHERE target_id = ${target?.id ?? -1}`);
  check('D1 有 1 個 batch', nb?.c === 1, nb);
  check('D1 有 5 則草稿', nd?.c === 5, nd);
  const A = await draftsOfTarget(SC_A);
  if (A && flex) {
    const goLinks = uriActions(flex).filter((u) => u.includes('/go/'));
    const expected = A.drafts.map((d) => `${BASE}/go/${d.id}`);
    check('卡片上的 /go/ 連結對應 D1 的草稿 id', expected.every((u) => goLinks.some((g) => g === u || g.startsWith(u + '?'))), { goLinks, expected });
    check('草稿 id 是 16 字英數', A.drafts.every((d) => /^[A-Za-z0-9]{16}$/.test(d.id)), A.drafts.map((d) => d.id));
  }
  ctx.A = A;
}

async function s5(check) {
  const seq0 = seqNow();
  const ev1 = textEvent(`https://www.threads.com/@e2e_bob/post/${SC_B}`);
  await postWebhook([ev1]);
  const a1 = await waitForAnswer(ev1, seq0);
  check('只貼網址 → 請他貼原文或傳截圖', /截圖|原文/.test(allText(a1)), allText(a1).slice(0, 200));
  check('只貼網址的回覆有「取消」快速按鈕', messagesOf(a1).some((m) => (m.quickReply?.items ?? []).some((it) => it.action?.text === '取消')), messagesOf(a1).map((m) => m.quickReply));
  check('這時還沒呼叫 Anthropic', callsSince(seq0, 'anthropic').length === 0);

  // 貼完網址後順手回一個字（「好」）→ 不叫 Claude，網址照樣記著
  const seqShort = seqNow();
  const evShort = textEvent('好');
  await postWebhook([evShort]);
  const aShort = await waitForAnswer(evShort, seqShort);
  check('短字「好」→ 回「太短」提示', /太短/.test(allText(aShort)), allText(aShort).slice(0, 200));
  check('短字「好」→ 沒有呼叫 Anthropic', callsSince(seqShort, 'anthropic').length === 0, callsSince(seqShort, 'anthropic').length);
  const pend = await d1one(`SELECT pending_shortcode FROM conversation_state WHERE user_id = ${sq(ADMIN)}`);
  check('短字之後網址還記著', pend?.pending_shortcode === SC_B, pend);

  const seq1 = seqNow();
  const ev2 = imageEvent();
  await postWebhook([ev2]);
  const a2 = await waitForAnswer(ev2, seq1);
  const content = callsSince(seq1, 'line').find((c) => c.path === `/v2/bot/message/${ev2.message.id}/content`);
  check('有跟 LINE 抓圖片內容（mock 回 PNG）', content?.status === 200, callsSince(seq1, 'line').map((c) => c.path));
  const anth = callsSince(seq1, 'anthropic').filter((c) => c.status === 200);
  check('Anthropic 被呼叫一次', anth.length === 1, anth.length);
  const imgs = anth[0] ? imageBlocksOf(anth[0].body) : [];
  check('請求裡有 base64 image block', imgs.length === 1 && imgs[0].source?.type === 'base64', imgs.map((b) => b.source?.type));
  check('image block 是那張 PNG', imgs[0]?.source?.media_type === 'image/png' && imgs[0]?.source?.data === TINY_PNG_BASE64, imgs[0]?.source?.media_type);
  const flex = flexCarousel(a2);
  check('回覆 flex carousel 6 個 bubble', flex?.contents?.contents?.length === 6, messagesOf(a2).map((m) => m.type));
  const B = await draftsOfTarget(SC_B);
  check('D1 有 5 則草稿（作者 e2e_bob）', B?.drafts?.length === 5, B?.drafts?.length);
  const t = await d1one(`SELECT author_username FROM targets WHERE shortcode = ${sq(SC_B)}`);
  check('targets 作者是 e2e_bob', t?.author_username === 'e2e_bob', t);
  ctx.B = B;
}

async function s6(check) {
  need(ctx.A?.drafts?.length >= 2 && ctx.B?.drafts?.length >= 1, '需要情境 3、5 產生的草稿');
  const noProduct = (list) => list.filter((d) => !d.mentions_product);
  const [A1, A2] = noProduct(ctx.A.drafts).length >= 2 ? noProduct(ctx.A.drafts) : ctx.A.drafts;
  const B1 = noProduct(ctx.B.drafts)[0] ?? ctx.B.drafts[0];

  const r1 = await http('GET', `/go/${A1.id}`);
  check('/go/<A1> → 302', r1.status === 302, `${r1.status} ${r1.text.slice(0, 200)}`);
  const loc1 = r1.headers.get('location') ?? '';
  let u1 = null;
  try {
    u1 = new URL(loc1);
  } catch {
    /* 不是網址 */
  }
  check('導到 https://www.threads.com/intent/post', u1?.origin === 'https://www.threads.com' && u1?.pathname === '/intent/post', loc1);
  check('reply_post_shortcode 是 A 的短碼', u1?.searchParams.get('reply_post_shortcode') === SC_A, loc1);
  check('text 是草稿原文', u1?.searchParams.get('text') === A1.text, loc1);

  const r2 = await http('GET', `/go/${B1.id}`);
  check('馬上開另一篇（B）→ 200 擋下頁', r2.status === 200, r2.status);
  check('擋下頁寫「還要等」', r2.text.includes('還要等'), r2.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  check('擋下頁仍看得到草稿原文', r2.text.includes(B1.text.slice(0, 10)));

  const r3 = await http('GET', `/go/${A2.id}`);
  check('同一篇（A）換一則草稿，寬限時間內 → 302', r3.status === 302, `${r3.status} ${r3.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`);
  const loc3 = r3.headers.get('location') ?? '';
  check('第二則也導到 A 的回覆框', loc3.includes(`reply_post_shortcode=${SC_A}`), loc3);

  const r4 = await http('GET', '/go/short');
  check('格式不對的 id → 404', r4.status === 404, r4.status);

  const d = await d1one(`SELECT status, opened_at FROM comment_drafts WHERE id = ${sq(A1.id)}`);
  check('A1 狀態變 opened 且有 opened_at', d?.status === 'opened' && d?.opened_at > 0, d);
  const clicks = await d1(`SELECT draft_id, allowed FROM link_clicks WHERE draft_id IN (${[A1.id, A2.id, B1.id].map(sq).join(',')})`);
  check('link_clicks：A1、A2 放行，B1 擋下', clicks.some((c) => c.draft_id === A1.id && c.allowed === 1) && clicks.some((c) => c.draft_id === A2.id && c.allowed === 1) && clicks.some((c) => c.draft_id === B1.id && c.allowed === 0), clicks);
  const na = await d1one("SELECT value FROM settings WHERE key = 'next_allowed_at'");
  check('next_allowed_at 設在未來', Number(na?.value) > Date.now(), na);
  ctx.A1 = A1;
}

async function s7(check) {
  need(ctx.A?.batchId, '需要情境 3 的 batch');
  const seq0 = seqNow();
  const ev = postbackEvent(`action=shorter&batch=${ctx.A.batchId}`);
  await postWebhook([ev]);
  const ans = await waitForAnswer(ev, seq0);
  const anth = callsSince(seq0, 'anthropic').filter((c) => c.status === 200);
  check('Anthropic 被呼叫一次', anth.length === 1, anth.length);
  if (anth[0]) {
    const all = systemOf(anth[0].body) + '\n' + userTurnOf(anth[0].body);
    check('請求帶上一批草稿當參考', ctx.A.drafts.some((d) => all.includes(d.text)), userTurnOf(anth[0].body).slice(0, 300));
    check('請求沒有違反 API 規則', callsSince(seq0, 'anthropic').every((c) => c.status === 200), callsSince(seq0, 'anthropic').map((c) => c.ruleProblems ?? c.status));
  }
  const nb = await draftsOfTarget(SC_A);
  check('新的 batch variant = shorter', nb?.variant === 'shorter' && nb?.batchId !== ctx.A.batchId, nb && { variant: nb.variant, batchId: nb.batchId });
  check('新草稿有存（≥ 3 則）', (nb?.drafts?.length ?? 0) >= 3, nb?.drafts?.length);
  check('回覆 flex carousel', !!flexCarousel(ans), messagesOf(ans).map((m) => m.type));
}

async function s8(check) {
  const seq0 = seqNow();
  const ev = textEvent('/說明', { ts: Date.now() - 60_000 });
  await postWebhook([ev]);
  const push = await waitFor(
    () => callsSince(seq0, 'line').find((c) => c.path === '/v2/bot/message/push' && c.body?.to === ADMIN && c.status === 200),
    { what: 'push 給 Max' },
  );
  check('用 push 送出', !!push);
  check('push 帶 X-Line-Retry-Key', /^[0-9a-f-]{16,}$/i.test(push?.headers?.['x-line-retry-key'] ?? ''), push?.headers);
  check('沒有拿過期的 reply token 去 reply', !callsSince(seq0, 'line').some((c) => c.path === '/v2/bot/message/reply' && c.body?.replyToken === ev.replyToken));
  const row = await waitFor(
    () => d1one(`SELECT purpose, ok, status_code, request_id, retry_key FROM line_push_log WHERE retry_key = ${sq(push?.headers?.['x-line-retry-key'] ?? '')}`),
    { what: 'line_push_log 這一列', interval: 400 },
  ).catch(() => null);
  check('line_push_log 有記一列（purpose late_reply、ok 1）', row?.purpose === 'late_reply' && row?.ok === 1, row);
  check('request_id 是 LINE 回的 x-line-request-id', row?.request_id === push?.requestId, { db: row?.request_id, line: push?.requestId });
}

async function s12(check) {
  // skip：敏感內容
  const seq0 = seqNow();
  mock.setConfig({ anthropic: { queue: ['skip'] } });
  const evC = textEvent(`https://www.threads.com/@e2e_carol/post/${SC_C}\n（e2e 測試：mock 會回 skip）最近心情很低落，不知道還能跟誰說`);
  await postWebhook([evC]);
  const aC = await waitForAnswer(evC, seq0);
  check('skip：回文字、不是卡片', !flexCarousel(aC) && messagesOf(aC).some((m) => m.type === 'text'), messagesOf(aC).map((m) => m.type));
  check('skip：說明不產留言', /不產|敏感/.test(allText(aC)), allText(aC).slice(0, 200));

  // refusal
  const seq1 = seqNow();
  mock.setConfig({ anthropic: { queue: ['refusal'] } });
  const evD = textEvent(`https://www.threads.com/@e2e_dave/post/${SC_D}\n（e2e 測試：mock 會回 refusal）這是一篇普通的貼文內容，講工作流程`);
  await postWebhook([evD]);
  const aD = await waitForAnswer(evD, seq1);
  check('refusal：回文字錯誤訊息、不是卡片', !flexCarousel(aD) && messagesOf(aD).some((m) => m.type === 'text' && m.text?.length > 0), messagesOf(aD).map((m) => m.type));
  check('refusal：沒有把英文錯誤原文丟給使用者', !/APIError|stop_reason|refusal|undefined/i.test(allText(aD)), allText(aD).slice(0, 200));

  const n = await d1one(
    `SELECT (SELECT COUNT(*) FROM comment_drafts d JOIN targets t ON t.id = d.target_id WHERE t.shortcode IN (${sq(SC_C)}, ${sq(SC_D)})) AS drafts, ` +
      `(SELECT COUNT(*) FROM draft_batches b JOIN targets t ON t.id = b.target_id WHERE t.shortcode IN (${sq(SC_C)}, ${sq(SC_D)})) AS batches`,
  );
  check('兩篇都沒有存草稿', n?.drafts === 0 && n?.batches === 0, n);
  const u = await d1one("SELECT COUNT(*) AS c FROM llm_usage WHERE stop_reason = 'refusal'");
  check('refusal 也記了 llm_usage（有 usage 就記）', u?.c >= 1, u);
}

async function s13(check) {
  const evs = [];
  for (const text of ['/額度', '/今日', '/人設', '/海巡 AI 工具']) {
    const seq0 = seqNow();
    const ev = textEvent(text);
    await postWebhook([ev]);
    const ans = await waitForAnswer(ev, seq0).catch((e) => {
      check(`${text} 有回覆`, false, e.message);
      return null;
    });
    if (!ans) continue;
    evs.push(ev);
    check(`${text} 有回覆`, messagesOf(ans).length > 0);
    const s = allText(ans);
    check(`${text} 回覆不是錯誤堆疊`, !/Error:|TypeError|undefined|NaN/.test(s), s.slice(0, 200));
    if (text === '/人設') check('/人設 有人設選單（postback action=persona&id=）', /action=persona&id=\d+/.test(s), s.slice(0, 300));
    if (text === '/海巡 AI 工具') {
      const uris = uriActions(messagesOf(ans));
      check('/海巡 給 Threads 搜尋按鈕', uris.some((u) => u.includes('threads.com/search') && u.includes(encodeURIComponent('AI 工具'))), uris);
    }
  }
  const kw = await d1one(`SELECT current_keyword FROM conversation_state WHERE user_id = ${sq(ADMIN)}`);
  check('/海巡 有記下目前關鍵字', kw?.current_keyword === 'AI 工具', kw);
  const kl = await d1one("SELECT COUNT(*) AS c FROM keyword_log WHERE keyword = 'AI 工具' AND source = 'patrol_cmd'");
  check('keyword_log 有 patrol_cmd 紀錄', kl?.c >= 1, kl);
  if (evs.length) {
    const rows = await waitFor(
      async () => {
        const r = await d1(`SELECT webhook_event_id, status FROM line_events WHERE webhook_event_id IN (${evs.map((e) => sq(e.webhookEventId)).join(',')})`);
        return r.length === evs.length && r.every((x) => x.status !== 'queued') ? r : null;
      },
      { what: 'line_events 狀態更新', interval: 500, timeout: 10_000 },
    ).catch(() => null);
    check('這幾個事件的 line_events 狀態都是 done', rows?.every((x) => x.status === 'done'), rows);
  }
}

async function s10(check) {
  const IP_OK = '10.77.0.1';
  const IP_BAD = '10.77.0.99';
  const r0 = await http('GET', '/api/overview');
  check('沒登入 GET /api/overview → 401', r0.status === 401, r0.status);
  // 登入頁本身要能打開（曾經因為改寫成 /login.html 而被 assets 307 回 /login，無限轉址）
  const lp = await http('GET', '/login');
  check('GET /login → 200 登入頁', lp.status === 200 && lp.text.includes('name="password"'), `${lp.status} ${lp.headers.get('location') ?? ''}`);
  const root0 = await http('GET', '/');
  check('沒登入 GET / → 轉到 /login', root0.status === 302 && (root0.headers.get('location') ?? '').endsWith('/login'), `${root0.status} ${root0.headers.get('location')}`);

  // 先用正確密碼登入（在暴力破解測試之前，避免被自己的限流鎖住）
  const form = (pw) => `password=${encodeURIComponent(pw)}`;
  const formHeaders = { 'content-type': 'application/x-www-form-urlencoded', origin: BASE };
  const ok = await http('POST', '/login', { body: form(SECRETS.DASH_PASSWORD), headers: formHeaders, ip: IP_OK });
  const cookie = sessionCookie(ok.setCookies);
  check('正確密碼 → 發 sess cookie', !!cookie, { status: ok.status, setCookies: ok.setCookies.map((c) => c.replace(/=([^;]{6})[^;]*/, '=$1…')) });
  check('cookie 有 HttpOnly、SameSite=Lax', ok.setCookies.some((c) => c.startsWith('sess=') && /httponly/i.test(c) && /samesite=lax/i.test(c)), ok.setCookies.map((c) => c.replace(/=([^;]{6})[^;]*/, '=$1…')));
  if (cookie) {
    const ov = await http('GET', '/api/overview', { cookie });
    check('登入後 GET /api/overview → 200 JSON', ov.status === 200 && ov.json && typeof ov.json === 'object', `${ov.status} ${ov.text.slice(0, 200)}`);
    const home = await http('GET', '/', { cookie });
    check('登入後 GET / → 200 後台頁', home.status === 200 && home.text.includes('/assets/app.js'), `${home.status} ${home.headers.get('location') ?? ''}`);

    const badOrigin = await http('PUT', '/api/settings', { cookie, body: { push_warn_at: 151 }, headers: { origin: 'http://evil.example' } });
    check('PUT /api/settings 來源不對 → 403', badOrigin.status === 403, badOrigin.status);
    const good = await http('PUT', '/api/settings', { cookie, body: { push_warn_at: 151 }, headers: { origin: BASE } });
    check('PUT /api/settings 來源正確 → 200', good.status === 200, `${good.status} ${good.text.slice(0, 200)}`);
    const after = await http('GET', '/api/settings', { cookie });
    check('設定真的改了（push_warn_at = 151）', after.json?.settings?.push_warn_at === 151, after.json?.settings?.push_warn_at);
    const notJson = await http('PUT', '/api/settings', { cookie, body: 'push_warn_at=152', headers: { origin: BASE, 'content-type': 'application/x-www-form-urlencoded' } });
    check('PUT 不是 JSON → 被擋（CSRF）', notJson.status >= 400 && notJson.status < 500, notJson.status);
    ctx.cookie = cookie;
  }

  // 暴力破解：同一個 IP 錯 5 次後第 6 次 → 429
  const statuses = [];
  let leaked = false;
  for (let i = 0; i < 6; i++) {
    const r = await http('POST', '/login', { body: form(`wrong-password-${i}`), headers: formHeaders, ip: IP_BAD });
    statuses.push(r.status);
    if (sessionCookie(r.setCookies)) leaked = true;
  }
  check('錯誤密碼都沒拿到 cookie', !leaked, statuses);
  check('前 5 次錯誤還沒被鎖（不是 429）', statuses.slice(0, 5).every((st) => st !== 429), statuses);
  check('第 6 次錯誤 → 429', statuses[5] === 429, statuses);
  const locked = await http('POST', '/login', { body: form(SECRETS.DASH_PASSWORD), headers: formHeaders, ip: IP_BAD });
  check('被鎖的 IP 用對的密碼也進不去（429）', locked.status === 429 && !sessionCookie(locked.setCookies), locked.status);

  // ---- 登出：舊 cookie 要失效；GET 與跨站 POST 不能把人登出 ----
  if (ctx.cookie) {
    const old = ctx.cookie;
    const g = await http('GET', '/logout', { cookie: old });
    check('GET /logout 只顯示確認頁（200，有 POST 表單）', g.status === 200 && /method="post"/.test(g.text), g.status);
    const x = await http('POST', '/logout', { cookie: old, body: '', headers: { origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' } });
    check('跨站 POST /logout → 403', x.status === 403, x.status);
    const still = await http('GET', '/api/overview', { cookie: old });
    check('GET 與跨站 POST 之後 session 還有效', still.status === 200, still.status);
    const out = await http('POST', '/logout', { cookie: old, body: '', headers: { origin: BASE, 'content-type': 'application/x-www-form-urlencoded' } });
    check('同源 POST /logout → 303 到 /login、清 cookie', out.status === 303 && (out.headers.get('location') ?? '').endsWith('/login') && out.setCookies.some((c) => /^sess=;/.test(c) && /max-age=0/i.test(c)), `${out.status} ${out.headers.get('location')}`);
    const after = await http('GET', '/api/overview', { cookie: old });
    check('登出後舊 cookie 打 /api/overview → 401', after.status === 401, after.status);
    // 重新登入，後面的情境要用
    const again = await http('POST', '/login', { body: form(SECRETS.DASH_PASSWORD), headers: formHeaders, ip: IP_OK });
    const fresh = sessionCookie(again.setCookies);
    check('重新登入拿到新 cookie', !!fresh && fresh !== old, again.status);
    const okNow = fresh ? await http('GET', '/api/overview', { cookie: fresh }) : { status: 0 };
    check('新 cookie 可以用', okNow.status === 200, okNow.status);
    if (fresh) ctx.cookie = fresh;
  }

  // ---- 同一個 IP 同時送一大批：最多只有 5 個會被拿去比對密碼 ----
  const jsonLogin = (pw, ip) => http('POST', '/login', { body: { password: pw }, headers: { origin: BASE }, ip });
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => jsonLogin(`burst-guess-${i}`, '10.77.1.1')));
  const evaluated = burst.filter((r) => r.status === 401).length;
  check('同時送 20 個錯誤密碼：被比對的 ≤ 5 個（其餘 429）', evaluated <= 5 && burst.filter((r) => r.status === 429).length >= 15, burst.map((r) => r.status).join(','));

  // ---- IPv6：同一個 /64 換位址也算同一個來源 ----
  const v6 = [];
  for (let i = 1; i <= 6; i++) v6.push((await jsonLogin(`v6-guess-${i}`, `2001:db8:1:2::${i}`)).status);
  check('同一個 /64 換 6 個位址：第 6 次 → 429', v6.slice(0, 5).every((st) => st === 401) && v6[5] === 429, v6);
  const otherNet = await jsonLogin('v6-other', '2001:db8:1:3::1');
  check('另一個 /64 不受影響（401）', otherNet.status === 401, otherNet.status);

  // ---- 全站上限：15 分鐘內所有來源加起來失敗 30 次 → 全部擋，LINE 通知一次 ----
  const seqAlert = seqNow();
  let globalHit = null;
  for (let i = 1; i <= 40 && !globalHit; i++) {
    const r = await jsonLogin(`spray-${i}`, `10.77.2.${i}`);
    if (r.status === 429) globalHit = { i, r };
  }
  check('換很多 IP 猜密碼，累計到上限後新的 IP 也被擋（429）', !!globalHit && /鎖住/.test(globalHit?.r?.json?.message ?? ''), globalHit && { i: globalHit.i, body: globalHit.r.json });
  const lockedOk = await http('POST', '/login', { body: form(SECRETS.DASH_PASSWORD), headers: formHeaders, ip: '10.77.3.1' });
  check('全站鎖住時，對的密碼也進不去', lockedOk.status === 429 && !sessionCookie(lockedOk.setCookies), lockedOk.status);
  await Promise.all(Array.from({ length: 5 }, (_, i) => jsonLogin(`spray-more-${i}`, `10.77.4.${i + 1}`)));
  const alerts = await waitFor(
    () => {
      const a = callsSince(seqAlert, 'line').filter((c) => c.path === '/v2/bot/message/push' && JSON.stringify(c.body?.messages ?? []).includes('登入失敗'));
      return a.length ? a : null;
    },
    { what: '全站鎖住的 LINE 警示', timeout: 8000 },
  ).catch(() => []);
  await sleep(800);
  const alertsAll = callsSince(seqAlert, 'line').filter((c) => c.path === '/v2/bot/message/push' && JSON.stringify(c.body?.messages ?? []).includes('登入失敗'));
  check('全站鎖住時 LINE 只通知一次', alerts.length >= 1 && alertsAll.length === 1, alertsAll.length);
}

async function s11(check) {
  need(ctx.cookie, '需要情境 10 的登入 cookie');
  const cookie = ctx.cookie;

  async function startFlow() {
    const r = await http('GET', '/auth/threads/start', { cookie });
    const loc = r.headers.get('location') ?? '';
    let u = null;
    try {
      u = new URL(loc);
    } catch {
      /* 不是網址 */
    }
    return { r, loc, u, state: u?.searchParams.get('state') ?? null };
  }

  const s = await startFlow();
  check('/auth/threads/start → 302', s.r.status === 302, `${s.r.status} ${s.r.text.slice(0, 200)}`);
  check('導到 THREADS_AUTH_URL（mock）', s.loc.startsWith(`${mock.url}/oauth/authorize?`), s.loc);
  check('帶 client_id', s.u?.searchParams.get('client_id') === SECRETS.THREADS_APP_ID, s.loc);
  check('redirect_uri = PUBLIC_BASE_URL/auth/threads/callback', s.u?.searchParams.get('redirect_uri') === `${BASE}/auth/threads/callback`, s.u?.searchParams.get('redirect_uri'));
  check('scope 是三個唯讀權限', s.u?.searchParams.get('scope') === 'threads_basic,threads_read_replies,threads_manage_insights', s.u?.searchParams.get('scope'));
  check('response_type=code、有 state', s.u?.searchParams.get('response_type') === 'code' && !!s.state, s.loc);
  need(s.state, '沒有 state');

  const seq0 = seqNow();
  const cb = await http('GET', `/auth/threads/callback?code=abc&state=${encodeURIComponent(s.state)}`, { cookie });
  check('callback → 302 到 /#settings?threads=connected', cb.status === 302 && (cb.headers.get('location') ?? '').includes('threads=connected'), `${cb.status} ${cb.headers.get('location')} ${cb.text.slice(0, 200)}`);
  const tcalls = callsSince(seq0, 'threads');
  const tokenCall = tcalls.find((c) => c.path.endsWith('/oauth/access_token'));
  check('用 POST 表單換短效 token', tokenCall?.method === 'POST' && tokenCall?.body?.grant_type === 'authorization_code' && tokenCall?.body?.client_secret === '***', tokenCall && { method: tokenCall.method, body: tokenCall.body });
  check('換長效 token（th_exchange_token）', tcalls.some((c) => c.path.endsWith('/access_token') && !c.path.includes('oauth') && c.query.grant_type === 'th_exchange_token' && c.status === 200), tcalls.map((c) => `${c.method} ${c.path} ${c.status}`));

  const reuse = await http('GET', `/auth/threads/callback?code=abc&state=${encodeURIComponent(s.state)}`, { cookie });
  check('同一個 state 不能用第二次', reuse.status !== 302 || !(reuse.headers.get('location') ?? '').includes('threads=connected'), reuse.status);

  // code 結尾的 #_ 要去掉
  const s2 = await startFlow();
  if (s2.state) {
    const seq1 = seqNow();
    const cb2 = await http('GET', `/auth/threads/callback?code=${encodeURIComponent('abc#_')}&state=${encodeURIComponent(s2.state)}`, { cookie });
    const tc = callsSince(seq1, 'threads').find((c) => c.path.endsWith('/oauth/access_token'));
    check('code 結尾的 #_ 有去掉再送出', tc?.oauthCode === 'abc' && cb2.status === 302, { code: tc?.oauthCode, status: cb2.status });
  }

  const tok = await d1one("SELECT user_id, username, ciphertext, iv, expires_at, refreshed_at FROM app_tokens WHERE provider = 'threads'");
  const longToken = mock.state.config.threads.longToken;
  check('app_tokens 有存', !!tok, tok);
  check('存的是密文（≠ token、也不含 token）', tok && tok.ciphertext !== longToken && !String(tok.ciphertext).includes(longToken) && !!tok.iv, tok && { ciphertext: String(tok.ciphertext).slice(0, 12) + '…' });
  check('username 是 me() 回的', tok?.username === 'e2e_max', tok?.username);
  check('expires_at ≈ 現在 + expires_in', tok && Math.abs(tok.expires_at - (Date.now() + mock.state.config.threads.longExpiresIn * 1000)) < 5 * 60_000, tok?.expires_at);

  // 讓 token 看起來已經 25 小時、10 天後到期，再跑每週排程續期
  const now = Date.now();
  await d1(`UPDATE app_tokens SET refreshed_at = ${now - 25 * HOUR}, expires_at = ${now + 10 * DAY} WHERE provider = 'threads'`);
  const seq2 = seqNow();
  const sch = await http('GET', `/__scheduled?cron=${encodeURIComponent('0 19 * * SUN').replace(/%20/g, '+')}`);
  check('weekly 排程跑得起來', sch.status === 200, `${sch.status} ${sch.text.slice(0, 200)}`);
  const refreshCall = await waitFor(() => callsSince(seq2, 'threads').find((c) => c.path.endsWith('/refresh_access_token')), { what: 'refresh_access_token 呼叫', timeout: 15_000 }).catch(() => null);
  check('有呼叫 refresh_access_token（th_refresh_token）', refreshCall?.query?.grant_type === 'th_refresh_token' && refreshCall?.status === 200, refreshCall && { query: refreshCall.query, status: refreshCall.status });
  check('續期用的是解密後的原 token', refreshCall?.token === longToken, refreshCall?.token === longToken ? 'ok' : '不一樣');
  const after = await waitFor(
    async () => {
      const t = await d1one("SELECT expires_at FROM app_tokens WHERE provider = 'threads'");
      return t && t.expires_at > now + 50 * DAY ? t : null;
    },
    { what: 'expires_at 延長', interval: 500, timeout: 10_000 },
  ).catch(() => null);
  check('expires_at 延長到 50 天以上', !!after, after);
  ctx.threadsConnected = !!tok;
}

async function s9(check) {
  need(ctx.A1, '需要情境 6 開過的草稿');
  const now = Date.now();
  const REPLY_ID = '18090000000000001';
  const EARLY_ID = '18090000000000003';
  // 回覆要在「開草稿」之後才算數：把 A 這篇的草稿改成 2 小時 10 分前打開（回覆是 2 小時前）
  await d1(`UPDATE comment_drafts SET opened_at = ${now - 130 * 60_000}, created_at = ${now - 3 * HOUR} WHERE target_id = ${ctx.A.targetId} AND opened_at IS NOT NULL`);
  // 反例：B 的一則草稿 10 分鐘前才打開，但 Threads 上一樣文字的回覆是 3 小時前發的 → 那是 Max 之前自己打的，不能算
  const B2 = ctx.B?.drafts?.[1] ?? null;
  if (B2) await d1(`UPDATE comment_drafts SET status = 'opened', opened_at = ${now - 10 * 60_000} WHERE id = ${sq(B2.id)}`);
  mock.setConfig({
    threads: {
      insights: { [REPLY_ID]: { views: 321, likes: 7, replies: 2, reposts: 1, quotes: 0, shares: 3 } },
      replies: [
        { id: REPLY_ID, text: ctx.A1.text, timestamp: graphTime(now - 2 * HOUR), permalink: 'https://www.threads.com/@e2e_max/post/E2ER0001', shortcode: 'E2ER0001', is_reply: true, media_type: 'TEXT_POST' },
        { id: '18090000000000002', text: '跟草稿完全無關的一般回覆，謝謝大家今天來參加', timestamp: graphTime(now - 3 * HOUR), permalink: 'https://www.threads.com/@e2e_max/post/E2ER0002', shortcode: 'E2ER0002', is_reply: true, media_type: 'TEXT_POST' },
        ...(B2 ? [{ id: EARLY_ID, text: B2.text, timestamp: graphTime(now - 3 * HOUR), permalink: 'https://www.threads.com/@e2e_max/post/E2ER0003', shortcode: 'E2ER0003', is_reply: true, media_type: 'TEXT_POST' }] : []),
      ],
    },
  });
  const seq0 = seqNow();
  const sch = await http('GET', `/__scheduled?cron=${encodeURIComponent('15 * * * *').replace(/%20/g, '+')}`);
  check('hourly 排程跑得起來', sch.status === 200, `${sch.status} ${sch.text.slice(0, 200)}`);
  const repliesCall = callsSince(seq0, 'threads').find((c) => /\/(me|\d+)\/replies$/.test(c.path));
  check('有查 /me/replies', !!repliesCall, callsSince(seq0, 'threads').map((c) => c.path));
  if (repliesCall) {
    const since = Number(repliesCall.query.since);
    check('since 用 unix 秒、約 72 小時前', since < 1e11 && Math.abs(since - Math.floor((now - 72 * HOUR) / 1000)) < 600, repliesCall.query.since);
    check('fields 有要 text 與 timestamp', /text/.test(repliesCall.query.fields ?? '') && /timestamp/.test(repliesCall.query.fields ?? ''), repliesCall.query.fields);
  }
  const pc = await waitFor(() => d1one(`SELECT id, draft_id, target_id, posted_at, similarity, status FROM posted_comments WHERE threads_media_id = ${sq(REPLY_ID)}`), {
    what: 'posted_comments 那一列',
    interval: 500,
    timeout: 15_000,
  }).catch(() => null);
  check('posted_comments 有比對到 A1', pc?.draft_id === ctx.A1.id, pc);
  check('posted_at 是留言的時間（2 小時前）', pc && Math.abs(pc.posted_at - (now - 2 * HOUR)) < 5000, pc?.posted_at);
  check('similarity ≥ 0.5', pc && pc.similarity >= 0.5, pc?.similarity);
  const other = await d1one("SELECT COUNT(*) AS c FROM posted_comments WHERE threads_media_id = '18090000000000002'");
  check('無關的回覆沒有被當成海巡留言', other?.c === 0, other);
  if (B2) {
    const early = await d1one(`SELECT COUNT(*) AS c FROM posted_comments WHERE threads_media_id = ${sq(EARLY_ID)}`);
    check('草稿打開「之前」就發的回覆不算送出（文字一樣也不算）', early?.c === 0, early);
    const b2 = await d1one(`SELECT status FROM comment_drafts WHERE id = ${sq(B2.id)}`);
    check('那則草稿還是 opened（沒被標成 posted）', b2?.status === 'opened', b2);
  }
  const draft = await d1one(`SELECT status FROM comment_drafts WHERE id = ${sq(ctx.A1.id)}`);
  check('A1 草稿狀態變 posted', draft?.status === 'posted', draft);
  if (pc) {
    const snap = await waitFor(() => d1one(`SELECT milestone, views, likes FROM reply_snapshots WHERE posted_id = ${pc.id} AND milestone = '1h'`), {
      what: 'reply_snapshots 1h',
      interval: 500,
      timeout: 10_000,
    }).catch(() => null);
    check("reply_snapshots 有 '1h'", !!snap, snap);
    check('1h 快照的觀看數是 insights 回的 321', snap?.views === 321 && snap?.likes === 7, snap);
    const later = await d1one(`SELECT COUNT(*) AS c FROM reply_snapshots WHERE posted_id = ${pc.id} AND milestone IN ('24h', '72h')`);
    check('還沒到的 24h／72h 沒有提早抓', later?.c === 0, later);
  }
}

// 附加：留言查不到 → 標 missing，作者自動進黑名單（計畫 §5-B）
async function sMissing(check) {
  need(ctx.threadsConnected && ctx.B?.targetId, '需要 Threads 已連結、情境 5 的貼文 B');
  const now = Date.now();
  const MID = '18090000000000099';
  await d1(
    `INSERT INTO posted_comments (threads_media_id, draft_id, target_id, text, permalink, posted_at, similarity, status, created_at) ` +
      `VALUES (${sq(MID)}, NULL, ${ctx.B.targetId}, 'e2e 查不到的留言', NULL, ${now - 25 * HOUR}, 1, 'live', ${now})`,
  );
  mock.setConfig({ threads: { notFoundIds: [MID] } });
  const sch = await http('GET', `/__scheduled?cron=${encodeURIComponent('15 * * * *').replace(/%20/g, '+')}`);
  check('hourly 排程跑得起來', sch.status === 200, sch.status);
  const row = await waitFor(async () => {
    const r = await d1one(`SELECT status FROM posted_comments WHERE threads_media_id = ${sq(MID)}`);
    return r?.status === 'missing' ? r : null;
  }, { what: 'posted_comments 標成 missing', interval: 500, timeout: 10_000 }).catch(() => null);
  check('查不到的留言標成 missing', row?.status === 'missing', row);
  const bl = await d1one("SELECT kind, value, reason FROM blocklist WHERE kind = 'author' AND value = 'e2e_bob'");
  check('那位作者自動進黑名單', !!bl && /查不到/.test(bl.reason ?? ''), bl);
  const pause = await d1one('SELECT COUNT(*) AS c FROM pauses WHERE cleared_at IS NULL AND until_at > ' + Date.now());
  check('只有 1 則查不到，還沒到自動暫停門檻', pause?.c === 0, pause);
  mock.setConfig({ threads: { notFoundIds: [] } });
}

// 附加：Claude 回 500 → 自己重試一次就成功（SDK 不再自動重試，逾時也不重送）
async function sRetry(check) {
  const seq0 = seqNow();
  mock.setConfig({ anthropic: { queue: ['error'], errorStatus: 500 } });
  const ev = textEvent(`https://www.threads.com/@e2e_erin/post/E2EE0005\n（e2e 測試：第一次 500、第二次成功）這是一篇講自動化流程的普通貼文`);
  await postWebhook([ev]);
  const ans = await waitForAnswer(ev, seq0, 40_000);
  const anth = callsSince(seq0, 'anthropic');
  check('Anthropic 呼叫剛好 2 次（500 → 重試一次）', anth.length === 2 && anth[0].status === 500 && anth[1].status === 200, anth.map((c) => c.status));
  check('重試成功後回 flex carousel', !!flexCarousel(ans), messagesOf(ans).map((m) => m.type));
  mock.setConfig({ anthropic: { errorStatus: 500 } });
}

// 附加：Meta 解除授權／刪除資料 callback（放最後：最後一步會真的刪掉 token）
function signedRequest(payload) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRETS.THREADS_APP_SECRET).update(p).digest('base64url');
  return `${sig}.${p}`;
}
async function sMeta(check) {
  need(ctx.threadsConnected, '需要 Threads 已連結（情境 11）');
  const owner = mock.state.config.threads.user.id;
  const nowSec = Math.floor(Date.now() / 1000);
  const post = (path, payload) =>
    http('POST', path, { body: `signed_request=${encodeURIComponent(signedRequest(payload))}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const tokenRows = async () => (await d1one("SELECT COUNT(*) AS c FROM app_tokens WHERE provider = 'threads'"))?.c ?? -1;
  const ownPosts0 = (await d1one('SELECT COUNT(*) AS c FROM own_posts'))?.c ?? 0;

  const d1r = await post('/meta/deauthorize', { algorithm: 'HMAC-SHA256', user_id: '999', issued_at: nowSec });
  check('別人的 user_id 解除授權 → 200', d1r.status === 200, d1r.status);
  check('別人的 user_id 解除授權 → Max 的 token 還在', (await tokenRows()) === 1);

  const dd = await post('/meta/data-deletion', { algorithm: 'HMAC-SHA256', user_id: '999', issued_at: nowSec });
  check('別人的 user_id 要求刪資料 → 回 url + confirmation_code', dd.status === 200 && typeof dd.json?.url === 'string' && typeof dd.json?.confirmation_code === 'string', dd.text.slice(0, 200));
  const ownPosts1 = (await d1one('SELECT COUNT(*) AS c FROM own_posts'))?.c ?? 0;
  check('別人的 user_id 要求刪資料 → Max 的貼文與 token 都還在', ownPosts1 === ownPosts0 && (await tokenRows()) === 1, { ownPosts0, ownPosts1 });

  const stale = await post('/meta/deauthorize', { algorithm: 'HMAC-SHA256', user_id: owner, issued_at: 978307200 });
  check('issued_at 是 2001 年（重放）→ 400', stale.status === 400, stale.status);
  check('重放的請求沒有刪 token', (await tokenRows()) === 1);

  const bad = `${createHmac('sha256', 'wrong-secret').update('x').digest('base64url')}.${Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: owner, issued_at: nowSec })).toString('base64url')}`;
  const badRes = await http('POST', '/meta/deauthorize', { body: `signed_request=${encodeURIComponent(bad)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  check('簽章錯 → 400', badRes.status === 400, badRes.status);

  const mine = await post('/meta/deauthorize', { algorithm: 'HMAC-SHA256', user_id: owner, issued_at: nowSec });
  check('Max 本人解除授權 → 200、token 刪掉', mine.status === 200 && (await tokenRows()) === 0, mine.status);
}

// 附加：每日快照（SPEC 沒列，但只有這條會走到 SnapshotPostsJob 的 Queue）
async function sDaily(check) {
  need(ctx.threadsConnected, '需要 Threads 已連結（情境 11）');
  const now = Date.now();
  const texts = ['我怎麼用 AI 幫客戶整理報價單', '接案三年學到的五件事', '小團隊導入自動化的第一步', '每週回頭看數據的習慣', '交接文件怎麼寫才有人看', '用 AI 做會議記錄的心得', '今天的午餐'];
  const ages = [1, 3, 5, 8, 12, 20, 40]; // 天；最後一篇超過 30 天，不該進 own_posts
  const posts = texts.map((text, i) => ({
    id: `1790000000000000${i + 1}`,
    text,
    timestamp: graphTime(now - ages[i] * DAY),
    permalink: `https://www.threads.com/@e2e_max/post/E2EP000${i + 1}`,
    shortcode: `E2EP000${i + 1}`,
    media_type: i === 6 ? 'IMAGE' : 'TEXT_POST',
    is_quote_post: false,
  }));
  mock.setConfig({ threads: { threads: posts } });
  const sch = await http('GET', `/__scheduled?cron=${encodeURIComponent('50 15 * * *').replace(/%20/g, '+')}`);
  check('daily 排程跑得起來', sch.status === 200, sch.status);
  const today = taipeiDateOf(Date.now());
  const od = await waitFor(() => d1one(`SELECT followers_count, views FROM own_daily WHERE date = ${sq(today)}`), { what: 'own_daily', interval: 500, timeout: 10_000 }).catch(() => null);
  check('own_daily 有今天、粉絲數 321', od?.followers_count === 321, od);
  check('個人檔案瀏覽是時間序列加總（120 + 80）', od?.views === 200, od?.views);

  const stored = await d1(`SELECT media_id FROM own_posts ORDER BY media_id`);
  check('own_posts 存了 30 天內的 6 篇', stored.length === 6, stored);
  const snaps = await waitFor(
    async () => {
      const r = await d1(`SELECT media_id FROM own_post_snapshots WHERE date = ${sq(today)}`);
      return r.length >= 6 ? r : null;
    },
    { what: 'own_post_snapshots（經過 Queue）', interval: 500, timeout: 15_000 },
  ).catch(() => null);
  check('Queue 跑完貼文快照（own_post_snapshots 6 列）', snaps?.length === 6, snaps);
  ctx.ownPosts = snaps?.length ?? 0;
}

// 附加：/關鍵字 與 /主題（要先有 5 篇以上有數據的貼文，所以排在每日快照後面）
async function sAnalysis(check) {
  need(ctx.ownPosts >= 5, '需要附加情境 D 存好的貼文快照');
  for (const [cmd, purpose, expectText] of [['/關鍵字', 'keywords', '報價單'], ['/主題', 'topics', '流程自動化']]) {
    const seq0 = seqNow();
    const ev = textEvent(cmd);
    await postWebhook([ev]);
    const ans = await waitForAnswer(ev, seq0).catch(() => null);
    check(`${cmd} 有回覆`, !!ans);
    const anth = callsSince(seq0, 'anthropic');
    check(`${cmd} 呼叫 Claude 一次（用途 ${purpose}）`, anth.length === 1 && anth[0].status === 200 && anth[0].purpose === purpose, anth.map((c) => ({ status: c.status, purpose: c.purpose, problems: c.ruleProblems })));
    check(`${cmd} 回覆有用到 Claude 的結果`, allText(ans).includes(expectText), allText(ans).slice(0, 300));
  }
  const t = await d1one('SELECT COUNT(*) AS c FROM own_posts WHERE topic IS NOT NULL');
  check('/主題 有把主題寫回 own_posts.topic', t?.c >= 1, t);
}

// ---------------------------------------------------------------------------

async function main() {
  const guard = setTimeout(async () => {
    console.error(`\n整體超過 ${OVERALL_TIMEOUT_MS / 60000} 分鐘，強制結束`);
    await cleanup();
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  guard.unref();

  try {
    await setup();
  } catch (e) {
    console.error(`啟動失敗：${e.message}`);
    await cleanup();
    process.exit(1);
  }

  // 執行順序依相依關係排（編號是 SPEC §5 的編號）
  await scenario(1, '簽章錯誤 → 401；Verify → 200', s1);
  await scenario(2, '陌生人傳訊息 → 不回、不叫 Claude', s2);
  await scenario(4, '同一個 webhookEventId 送兩次 → 只處理一次', s4);
  await scenario(3, '網址 + 原文 → 5 則草稿卡片', s3);
  await scenario(5, '只貼網址 → 再傳截圖 → 用圖片產生', s5);
  await scenario(6, '/go/ 放行、間隔擋下、同篇寬限', s6);
  await scenario(7, '「再短一點」postback → 新一批草稿', s7);
  await scenario(8, '事件超過 50 秒 → 改用 push', s8);
  await scenario(12, 'Claude 回 skip／refusal → 不存草稿', s12);
  await scenario(13, '/額度 /今日 /人設 /海巡 都有回', s13);
  await scenario(10, '後台登入、限流、CSRF', s10);
  await scenario(11, 'Threads OAuth → token 加密 → 每週續期', s11);
  await scenario(9, '每小時比對 → posted_comments + 1h 快照', s9);
  await scenario('X', '（附加）留言查不到 → 作者自動進黑名單', sMissing);
  await scenario('R', '（附加）Claude 回 500 → 重試一次成功', sRetry);
  await scenario('D', '（附加）每日快照 + Queue 貼文快照', sDaily);
  await scenario('K', '（附加）/關鍵字 /主題', sAnalysis);
  await scenario('M', '（附加）Meta 解除授權／刪除資料只動本人的資料', sMeta);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通過${failed.length ? `；失敗：${failed.map((r) => r.id).join(', ')}` : ''}`);
  if (failed.length) {
    console.log(`\n--- wrangler dev log 最後 60 行（完整在 ${path.relative(APP, DEV_LOG)}）---\n${tail(DEV_LOG)}`);
    const errs = mock.state.calls.filter((c) => c.status >= 400).slice(-10);
    if (errs.length) {
      console.log('\n--- mock 最近回錯誤的呼叫 ---');
      for (const c of errs) console.log(`${c.status} ${c.method} ${c.path}${c.ruleProblems ? ` ${c.ruleProblems.join('; ')}` : ''}`);
    }
  }
  await cleanup();
  process.exit(failed.length ? 1 : 0);
}

main();
