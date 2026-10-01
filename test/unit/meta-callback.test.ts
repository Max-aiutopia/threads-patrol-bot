import { describe, it, expect } from 'vitest';
import { base64UrlEncode, hmacSha256 } from '../../src/lib/crypto';
import { signedRequestFresh, userMatch, verifySignedRequest } from '../../src/dash/pages';

const SECRET = 'unit-test-app-secret';
async function sign(payload: Record<string, unknown>, secret = SECRET): Promise<string> {
  const p = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${base64UrlEncode(await hmacSha256(secret, p))}.${p}`;
}

describe('verifySignedRequest', () => {
  it('簽章正確 → 回 payload', async () => {
    const p = await verifySignedRequest(await sign({ algorithm: 'HMAC-SHA256', user_id: '1', issued_at: 1 }), SECRET);
    expect(p?.user_id).toBe('1');
  });
  it('簽章錯、algorithm 不對 → null', async () => {
    expect(await verifySignedRequest(await sign({ algorithm: 'HMAC-SHA256', user_id: '1' }, 'other'), SECRET)).toBeNull();
    expect(await verifySignedRequest(await sign({ algorithm: 'none', user_id: '1' }), SECRET)).toBeNull();
  });
});

describe('userMatch：不是 Max 的帳號就不能刪 Max 的資料', () => {
  it('同一個 user id → yes', () => expect(userMatch('123', true, '123')).toBe('yes'));
  it('別人的 user id → no（審查重現：user_id=999 也刪了 token）', () => expect(userMatch('123', true, '999')).toBe('no'));
  it('通知沒帶 user id → no', () => expect(userMatch('123', true, undefined)).toBe('no'));
  it('token 沒記 user id → unknown（只能當成是本人）', () => expect(userMatch(null, true, '999')).toBe('unknown'));
  it('沒有 token → no_token', () => expect(userMatch(null, false, '123')).toBe('no_token'));
});

describe('signedRequestFresh', () => {
  const now = Date.UTC(2026, 8, 28);
  it('剛簽的 → true', () => expect(signedRequestFresh({ issued_at: now / 1000 - 60 }, now)).toBe(true));
  it('2001 年簽的（重放）→ false', () => expect(signedRequestFresh({ issued_at: 978307200 }, now)).toBe(false));
  it('跑到未來很多 → false', () => expect(signedRequestFresh({ issued_at: now / 1000 + 3600 }, now)).toBe(false));
  it('沒帶 issued_at → 不以此擋', () => expect(signedRequestFresh({}, now)).toBe(true));
});
