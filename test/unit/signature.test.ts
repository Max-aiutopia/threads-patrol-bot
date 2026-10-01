import { describe, it, expect } from 'vitest';
import { verifyLineSignature } from '../../src/line/signature';

const SECRET = 'e2e-line-channel-secret';

// 用 openssl 算的固定值：printf '%s' BODY | openssl dgst -sha256 -hmac SECRET -binary | base64
const VERIFY_BODY = '{"destination":"Ubot","events":[]}';
const VERIFY_SIG = 'eK7n4gx3Z/hUHZs2MWJMpBetak8wrK/TaMPjlFq21as=';
const UTF8_BODY = '{"events":[{"type":"message","message":{"type":"text","text":"測試 😀"}}]}';
const UTF8_SIG = '9ZqLrEZ1M1yk8yZZhzHNpraZbzbKMB5MGdObgPmOFuA=';

async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  let s = '';
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s);
}

describe('verifyLineSignature', () => {
  it('接受 openssl 算出來的正確簽章（LINE Verify 按鈕的空 events）', async () => {
    expect(await verifyLineSignature(VERIFY_BODY, VERIFY_SIG, SECRET)).toBe(true);
  });

  it('body 含中文與 emoji 時也對（對原始 UTF-8 字串簽）', async () => {
    expect(await verifyLineSignature(UTF8_BODY, UTF8_SIG, SECRET)).toBe(true);
  });

  it('跟 Web Crypto 自己算的一致', async () => {
    const body = JSON.stringify({ destination: 'U1', events: [{ type: 'follow', webhookEventId: '01ABC' }] });
    expect(await verifyLineSignature(body, await sign(SECRET, body), SECRET)).toBe(true);
  });

  it('沒有 header（null）→ false', async () => {
    expect(await verifyLineSignature(VERIFY_BODY, null, SECRET)).toBe(false);
  });

  it('空字串簽章 → false', async () => {
    expect(await verifyLineSignature(VERIFY_BODY, '', SECRET)).toBe(false);
  });

  it('body 被改過一個字 → false', async () => {
    expect(await verifyLineSignature(VERIFY_BODY.replace('Ubot', 'Ubox'), VERIFY_SIG, SECRET)).toBe(false);
  });

  it('body 重新排版（parse 再 stringify）→ false，驗簽一定要用原始 body', async () => {
    const pretty = JSON.stringify(JSON.parse(VERIFY_BODY), null, 2);
    expect(await verifyLineSignature(pretty, VERIFY_SIG, SECRET)).toBe(false);
  });

  it('secret 不對 → false', async () => {
    expect(await verifyLineSignature(VERIFY_BODY, VERIFY_SIG, 'wrong-secret')).toBe(false);
  });

  it('hex 格式或亂碼的簽章 → false，不會丟錯', async () => {
    await expect(verifyLineSignature(VERIFY_BODY, 'deadbeef', SECRET)).resolves.toBe(false);
    await expect(verifyLineSignature(VERIFY_BODY, '%%%not-base64%%%', SECRET)).resolves.toBe(false);
  });

  it('簽章少最後一個字元 → false', async () => {
    expect(await verifyLineSignature(VERIFY_BODY, VERIFY_SIG.slice(0, -1), SECRET)).toBe(false);
  });
});
