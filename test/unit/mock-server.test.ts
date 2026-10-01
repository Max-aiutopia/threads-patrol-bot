// mock server 自己的測試：確定 e2e 用的假 API 行為跟官方文件一致
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
// @ts-ignore -- 純 JS 模組，沒有型別宣告
import { startMockServer, TINY_PNG_BASE64, graphTime } from '../mocks/mock-server.mjs';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let m: Json;
let U = '';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (typeof body === 'string') init.body = body;
    else {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
  }
  const res = await fetch(U + path, { ...init, redirect: 'manual' });
  const text = await res.text();
  let json: Json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

const LINE = { authorization: 'Bearer test-token' };
const ANTH = { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' };
const COMMENT_SCHEMA = {
  type: 'object',
  properties: { skip: {}, skip_reason: {}, summary: {}, comments: {} },
};

beforeAll(async () => {
  m = await startMockServer();
  U = m.url;
});
afterAll(async () => {
  await m.close();
});
beforeEach(async () => {
  await call('POST', '/__reset');
});

describe('控制端點', () => {
  it('health / config / calls / reset', async () => {
    expect((await call('GET', '/__health')).json).toEqual({ ok: true });
    const c = await call('POST', '/__config', { anthropic: { mode: 'skip' } });
    expect(c.json.config.anthropic.mode).toBe('skip');
    expect(c.json.config.anthropic.strict).toBe(true);
    await call('GET', '/v2/bot/message/quota', undefined, LINE);
    const calls = await call('GET', '/__calls?service=line');
    expect(calls.json.calls).toHaveLength(1);
    expect(calls.json.calls[0].headers.authorization).toBe('Bearer ***');
    await call('POST', '/__reset');
    expect((await call('GET', '/__calls')).json.calls).toHaveLength(0);
    expect((await call('GET', '/__config')).json.config.anthropic.mode).toBe('ok');
  });
});

describe('LINE', () => {
  it('reply：成功回 x-line-request-id；同一個 reply token 第二次回 400', async () => {
    const body = { replyToken: 'rt1', messages: [{ type: 'text', text: '你好' }] };
    const a = await call('POST', '/v2/bot/message/reply', body, LINE);
    expect(a.status).toBe(200);
    expect(a.headers.get('x-line-request-id')).toBeTruthy();
    const b = await call('POST', '/v2/bot/message/reply', body, LINE);
    expect(b.status).toBe(400);
  });

  it('reply：沒帶 token → 401；超過 5 則訊息或 postback data 太長 → 400', async () => {
    expect((await call('POST', '/v2/bot/message/reply', { replyToken: 'x', messages: [{ type: 'text', text: 'a' }] })).status).toBe(401);
    const six = Array.from({ length: 6 }, () => ({ type: 'text', text: 'a' }));
    expect((await call('POST', '/v2/bot/message/reply', { replyToken: 'r6', messages: six }, LINE)).status).toBe(400);
    const flex = {
      type: 'flex', altText: 'x',
      contents: { type: 'bubble', footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', action: { type: 'postback', label: 'a', data: 'x'.repeat(301) } }] } },
    };
    const r = await call('POST', '/v2/bot/message/reply', { replyToken: 'r7', messages: [flex] }, LINE);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain('postback');
  });

  it('push：同一把 X-Line-Retry-Key 第二次回 409；quota/consumption 算得出已送幾則', async () => {
    const h = { ...LINE, 'x-line-retry-key': '123e4567-e89b-12d3-a456-426614174000' };
    const body = { to: 'U_admin', messages: [{ type: 'text', text: '早安' }] };
    expect((await call('POST', '/v2/bot/message/push', body, h)).status).toBe(200);
    expect((await call('POST', '/v2/bot/message/push', body, h)).status).toBe(409);
    expect((await call('GET', '/v2/bot/message/quota/consumption', undefined, LINE)).json).toEqual({ totalUsage: 1 });
    expect((await call('GET', '/v2/bot/message/quota', undefined, LINE)).json).toEqual({ type: 'limited', value: 200 });
  });

  it('push：pushFailTimes 讓第一次回 500，重試成功；pushStatus 429 = 額度用完', async () => {
    await call('POST', '/__config', { line: { pushFailTimes: 1 } });
    const h = { ...LINE, 'x-line-retry-key': 'k1' };
    const body = { to: 'U_admin', messages: [{ type: 'text', text: 'a' }] };
    expect((await call('POST', '/v2/bot/message/push', body, h)).status).toBe(500);
    expect((await call('POST', '/v2/bot/message/push', body, h)).status).toBe(200);
    await call('POST', '/__config', { line: { pushStatus: 429 } });
    const r = await call('POST', '/v2/bot/message/push', body, { ...LINE, 'x-line-retry-key': 'k2' });
    expect(r.status).toBe(429);
    expect(r.json.message).toContain('monthly limit');
  });

  it('loading：5 的倍數 5..60 回 202，其他回 400', async () => {
    expect((await call('POST', '/v2/bot/chat/loading/start', { chatId: 'U_admin', loadingSeconds: 45 }, LINE)).status).toBe(202);
    expect((await call('POST', '/v2/bot/chat/loading/start', { chatId: 'U_admin', loadingSeconds: 42 }, LINE)).status).toBe(400);
    expect((await call('POST', '/v2/bot/chat/loading/start', { chatId: 'U_admin', loadingSeconds: 65 }, LINE)).status).toBe(400);
  });

  it('content：回一張 PNG', async () => {
    const res = await fetch(`${U}/v2/bot/message/123/content`, { headers: LINE });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(atob(TINY_PNG_BASE64).length);
    expect([...buf.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
  });
});

describe('Threads', () => {
  it('OAuth：code → 短效 → 長效 → me；code 帶 #_ 會失敗', async () => {
    const form = (code: string) =>
      `client_id=1&client_secret=s&grant_type=authorization_code&redirect_uri=${encodeURIComponent('http://x/cb')}&code=${encodeURIComponent(code)}`;
    const ct = { 'content-type': 'application/x-www-form-urlencoded' };
    expect((await call('POST', '/oauth/access_token', form('abc#_'), ct)).status).toBe(400);
    const s = await call('POST', '/oauth/access_token', form('abc'), ct);
    expect(s.status).toBe(200);
    expect(s.json.access_token).toBeTruthy();
    const calls = (await call('GET', '/__calls?service=threads')).json.calls;
    expect(calls[1].body.client_secret).toBe('***');
    const l = await call('GET', `/access_token?grant_type=th_exchange_token&client_secret=s&access_token=${s.json.access_token}`);
    expect(l.status).toBe(200);
    expect(l.json.expires_in).toBeGreaterThan(5_000_000);
    const me = await call('GET', `/v1.0/me?fields=id,username&access_token=${l.json.access_token}`);
    expect(me.json).toEqual({ id: '1234567890123', username: 'e2e_max' });
    const bad = await call('GET', '/v1.0/me?fields=id,username&access_token=nope');
    expect(bad.json.error.code).toBe(190);
    const r = await call('GET', `/refresh_access_token?grant_type=th_refresh_token&access_token=${l.json.access_token}`);
    expect(r.json.access_token).not.toBe(l.json.access_token);
    expect(r.json.expires_in).toBe(5184000);
  });

  it('/me/replies：依 since 篩選、只回 fields 有要的欄位', async () => {
    const now = Date.now();
    await call('POST', '/__config', {
      threads: {
        checkToken: false,
        replies: [
          { id: 'r1', text: '新的', timestamp: graphTime(now - 3600_000), shortcode: 'S1', is_reply: true },
          { id: 'r2', text: '很舊', timestamp: graphTime(now - 10 * 86400_000), shortcode: 'S2', is_reply: true },
        ],
      },
    });
    const since = Math.floor((now - 72 * 3600_000) / 1000);
    const r = await call('GET', `/v1.0/me/replies?fields=id,text,timestamp&since=${since}&limit=50&access_token=t`);
    expect(r.json.data).toEqual([{ id: 'r1', text: '新的', timestamp: graphTime(now - 3600_000) }]);
    expect(graphTime(0)).toBe('1970-01-01T00:00:00+0000');
  });

  it('/me/threads 分頁有 paging.next', async () => {
    const now = Date.now();
    const threads = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, text: `貼文${i}`, timestamp: graphTime(now - i * 3600_000) }));
    await call('POST', '/__config', { threads: { checkToken: false, threads } });
    const a = await call('GET', '/v1.0/me/threads?fields=id,text&limit=2&access_token=t');
    expect(a.json.data.map((x: Json) => x.id)).toEqual(['p0', 'p1']);
    expect(a.json.paging.next).toBeTruthy();
    const b = await call('GET', `/v1.0/me/threads?fields=id,text&limit=2&access_token=t&after=${a.json.paging.cursors.after}`);
    expect(b.json.data.map((x: Json) => x.id)).toEqual(['p2', 'p3']);
  });

  it('insights：單篇是 values，帳號層級 views 是時間序列、其他是 total_value', async () => {
    await call('POST', '/__config', { threads: { checkToken: false, insights: { m1: { views: 10, likes: 2, replies: 0, reposts: 0, quotes: 0, shares: 1 } } } });
    const a = await call('GET', '/v1.0/m1/insights?metric=views,likes,shares&access_token=t');
    expect(a.json.data.map((d: Json) => [d.name, d.values[0].value])).toEqual([['views', 10], ['likes', 2], ['shares', 1]]);
    const u = await call('GET', '/v1.0/me/threads_insights?metric=views,followers_count,clicks&since=1&until=2&access_token=t');
    const byName = Object.fromEntries(u.json.data.map((d: Json) => [d.name, d]));
    expect(Array.isArray(byName.views.values)).toBe(true);
    expect(byName.followers_count.total_value.value).toBe(321);
    expect(byName.clicks.link_total_values[0].value).toBe(4);
  });

  it('錯誤模式：不存在、限流、授權失效', async () => {
    await call('POST', '/__config', { threads: { checkToken: false, notFoundIds: ['gone'] } });
    const nf = await call('GET', '/v1.0/gone/insights?metric=views&access_token=t');
    expect(nf.json.error.code).toBe(100);
    expect(nf.json.error.message).toContain('does not exist');
    await call('POST', '/__config', { threads: { errorMode: 'rate_limit' } });
    expect((await call('GET', '/v1.0/me/replies?access_token=t')).json.error.code).toBe(4);
    await call('POST', '/__config', { threads: { errorMode: 'auth' } });
    expect((await call('GET', '/v1.0/me/replies?access_token=t')).json.error.code).toBe(190);
  });

  it('/oauth/authorize 模擬使用者按同意，導回 redirect_uri', async () => {
    const r = await call('GET', `/oauth/authorize?client_id=1&redirect_uri=${encodeURIComponent('http://127.0.0.1:9/auth/threads/callback')}&state=S1`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('http://127.0.0.1:9/auth/threads/callback?code=abc&state=S1#_');
  });
});

describe('Anthropic', () => {
  const req = (over: Record<string, unknown> = {}) => ({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    system: '寫 5 則留言',
    messages: [{ role: 'user', content: [{ type: 'text', text: '以下是別人的貼文內容 <post>原文</post>' }] }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: COMMENT_SCHEMA } },
    ...over,
  });

  it('留言：text block 是符合 schema 的 JSON，附 usage', async () => {
    const r = await call('POST', '/v1/messages', req(), ANTH);
    expect(r.status).toBe(200);
    expect(r.json.stop_reason).toBe('end_turn');
    expect(r.json.usage.input_tokens).toBe(1950);
    const data = JSON.parse(r.json.content[0].text);
    expect(Object.keys(data).sort()).toEqual(['comments', 'skip', 'skip_reason', 'summary']);
    expect(data.skip).toBe(false);
    expect(data.comments).toHaveLength(5);
    for (const c of data.comments) {
      expect(Object.keys(c).sort()).toEqual(['mentions_product', 'text']);
      expect(c.text).not.toMatch(/https?:|www\.|\.com/);
    }
    expect(data.comments.filter((c: Json) => c.mentions_product).length).toBeLessThanOrEqual(2);
  });

  it('每次呼叫給不同的 5 則', async () => {
    const a = JSON.parse((await call('POST', '/v1/messages', req(), ANTH)).json.content[0].text);
    const b = JSON.parse((await call('POST', '/v1/messages', req(), ANTH)).json.content[0].text);
    expect(a.comments.map((c: Json) => c.text)).not.toEqual(b.comments.map((c: Json) => c.text));
  });

  it('Opus 走 beta 路徑（/v1/messages?beta=true）帶 fallbacks 也可以', async () => {
    const r = await call('POST', '/v1/messages?beta=true', req({ model: 'claude-opus-5', fallbacks: 'default' }), {
      ...ANTH, 'anthropic-beta': 'server-side-fallback-2026-07-01',
    });
    expect(r.status).toBe(200);
    expect(r.json.model).toBe('claude-opus-5');
  });

  it('API 硬規則：sampling 參數、budget_tokens、Haiku 帶 effort、prefill、沒 beta 帶 fallbacks → 400', async () => {
    expect((await call('POST', '/v1/messages', req({ temperature: 0.7 }), ANTH)).status).toBe(400);
    expect((await call('POST', '/v1/messages', req({ thinking: { type: 'enabled', budget_tokens: 2000 } }), ANTH)).status).toBe(400);
    expect((await call('POST', '/v1/messages', req({ model: 'claude-haiku-4-5' }), ANTH)).status).toBe(400);
    const prefill = req({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '{' }] });
    expect((await call('POST', '/v1/messages', prefill, ANTH)).status).toBe(400);
    expect((await call('POST', '/v1/messages', req({ fallbacks: 'default' }), ANTH)).status).toBe(400);
    const haikuOk = req({ model: 'claude-haiku-4-5', output_config: { format: { type: 'json_schema', schema: COMMENT_SCHEMA } } });
    expect((await call('POST', '/v1/messages', haikuOk, ANTH)).status).toBe(200);
  });

  it('沒 x-api-key → 401', async () => {
    expect((await call('POST', '/v1/messages', req(), { 'anthropic-version': '2023-06-01' })).status).toBe(401);
  });

  it('queue：refusal → skip → 回到 ok', async () => {
    await call('POST', '/__config', { anthropic: { queue: ['refusal', 'skip'] } });
    const a = await call('POST', '/v1/messages', req(), ANTH);
    expect(a.json.stop_reason).toBe('refusal');
    expect(a.json.stop_details.category).toBe('general_harms');
    expect(a.json.usage).toBeTruthy();
    const b = JSON.parse((await call('POST', '/v1/messages', req(), ANTH)).json.content[0].text);
    expect(b.skip).toBe(true);
    expect(b.comments).toEqual([]);
    const c = JSON.parse((await call('POST', '/v1/messages', req(), ANTH)).json.content[0].text);
    expect(c.skip).toBe(false);
  });

  it('invalid / max_tokens / error 模式', async () => {
    await call('POST', '/__config', { anthropic: { queue: ['invalid', 'max_tokens', 'error'] } });
    const a = await call('POST', '/v1/messages', req(), ANTH);
    expect(() => JSON.parse(a.json.content[0].text)).toThrow();
    const b = await call('POST', '/v1/messages', req(), ANTH);
    expect(b.json.stop_reason).toBe('max_tokens');
    const c = await call('POST', '/v1/messages', req(), ANTH);
    expect(c.status).toBe(500);
    expect(c.json.type).toBe('error');
  });

  it('依 schema 判斷用途：keywords / topics', async () => {
    const kw = await call('POST', '/v1/messages', req({ output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { keywords: {} } } } } }), ANTH);
    const kwData = JSON.parse(kw.json.content[0].text);
    expect(kwData.keywords.length).toBeGreaterThanOrEqual(6);
    expect(kwData.keywords[0]).toHaveProperty('keyword');
    expect(kwData.keywords[0]).toHaveProperty('why');
    const tp = await call(
      'POST',
      '/v1/messages',
      req({
        messages: [{ role: 'user', content: '[0] 第一篇\n[1] 第二篇\n[2] 第三篇\n[3] 第四篇\n[4] 第五篇\n[5] 第六篇' }],
        output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { topics: {} } } } },
      }),
      ANTH,
    );
    const tpData = JSON.parse(tp.json.content[0].text);
    expect(tpData.topics.length).toBeGreaterThanOrEqual(4);
    const all = tpData.topics.flatMap((t: Json) => t.post_indexes).sort((a: number, b: number) => a - b);
    expect(all).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('紀錄裡看得到 purpose、mode、beta，看不到 API key', async () => {
    await call('POST', '/v1/messages?beta=true', req({ model: 'claude-opus-5' }), ANTH);
    const c = (await call('GET', '/__calls?service=anthropic')).json.calls[0];
    expect(c.purpose).toBe('comments');
    expect(c.mode).toBe('ok');
    expect(c.beta).toBe(true);
    expect(c.headers['x-api-key']).toBe('***');
    expect(c.body.messages[0].content[0].text).toContain('<post>');
  });
});
