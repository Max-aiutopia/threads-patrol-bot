import { describe, it, expect } from 'vitest';
import {
  bytesToBase64, base64ToBytes, base64UrlEncode, base64UrlDecode,
  hmacSha256Base64, sha256Hex, timingSafeEqual, randomId, encryptString, decryptString,
} from '../../src/lib/crypto';

function randomKeyB64(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

describe('base64 / base64url', () => {
  it('來回轉換不失真（含 0x00、0xff）', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes]);
  });

  it('base64url 沒有 + / =', () => {
    const bytes = new Uint8Array([251, 255, 191, 62, 63]);
    const s = base64UrlEncode(bytes);
    expect(s).not.toMatch(/[+/=]/);
  });

  it('大陣列（> 32 KB）也能轉', () => {
    const chunk = crypto.getRandomValues(new Uint8Array(65536)); // getRandomValues 一次最多 64 KB
    const bigger = new Uint8Array(200_000);
    for (let i = 0; i < bigger.length; i++) bigger[i] = chunk[i % chunk.length];
    const back = base64ToBytes(bytesToBase64(bigger));
    expect(back.length).toBe(bigger.length);
    expect(back[199_999]).toBe(bigger[199_999]);
  });
});

describe('bytesToBase64 跟 btoa 結果一致', () => {
  it('各種長度（含補 = 的 1、2 餘數）', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 6, 7, 31, 32, 33, 1000, 70_001]) {
      const u = new Uint8Array(len);
      for (let i = 0; i < len; i++) u[i] = (i * 97 + 13) & 255;
      let bin = '';
      for (const b of u) bin += String.fromCharCode(b);
      expect(bytesToBase64(u)).toBe(btoa(bin));
    }
  });

  it('收 ArrayBuffer 也可以', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]).buffer)).toBe('aGk=');
  });
});

describe('hash / hmac', () => {
  it('sha256Hex 已知值', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hmacSha256Base64 跟 openssl 一致', async () => {
    expect(await hmacSha256Base64('e2e-line-channel-secret', '{"destination":"Ubot","events":[]}')).toBe(
      'eK7n4gx3Z/hUHZs2MWJMpBetak8wrK/TaMPjlFq21as=',
    );
  });
});

describe('timingSafeEqual', () => {
  it('一樣 → true，不一樣或長度不同 → false', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('中文', '中文')).toBe(true);
  });
});

describe('randomId', () => {
  it('預設 16 字、只有英數（/go/ 網址用 [A-Za-z0-9]{16}）', () => {
    for (let i = 0; i < 200; i++) expect(randomId()).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it('可指定長度', () => {
    expect(randomId(12)).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(randomId(1)).toMatch(/^[A-Za-z0-9]$/);
    expect(randomId(64)).toMatch(/^[A-Za-z0-9]{64}$/);
  });

  it('不重複，62 個字元都會出現', () => {
    const ids = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = randomId();
      ids.add(id);
      for (const c of id) chars.add(c);
    }
    expect(ids.size).toBe(2000);
    expect(chars.size).toBe(62);
  });
});

describe('encryptString / decryptString（AES-256-GCM）', () => {
  it('加密後解得回來（含中文、長字串）', async () => {
    const key = randomKeyB64();
    for (const plain of ['THQVJhello', 'Threads token 中文 😀', 'x'.repeat(5000), '']) {
      const { ciphertext, iv } = await encryptString(key, plain);
      expect(await decryptString(key, ciphertext, iv)).toBe(plain);
    }
  });

  it('密文不含明文、IV 是 12 bytes、每次 IV 不同', async () => {
    const key = randomKeyB64();
    const plain = 'THQVe2eLongToken0001';
    const a = await encryptString(key, plain);
    const b = await encryptString(key, plain);
    expect(a.ciphertext).not.toContain(plain);
    expect(atob(a.ciphertext)).not.toContain(plain);
    expect(base64ToBytes(a.iv).length).toBe(12);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('金鑰不對 → 解密失敗', async () => {
    const { ciphertext, iv } = await encryptString(randomKeyB64(), 'secret');
    await expect(decryptString(randomKeyB64(), ciphertext, iv)).rejects.toBeTruthy();
  });

  it('密文被改 → 解密失敗（GCM 驗證）', async () => {
    const key = randomKeyB64();
    const { ciphertext, iv } = await encryptString(key, 'secret-token');
    const bytes = base64ToBytes(ciphertext);
    bytes[0] ^= 0x01;
    await expect(decryptString(key, bytesToBase64(bytes), iv)).rejects.toBeTruthy();
  });

  it('金鑰不是 32 bytes → 丟錯（避免設錯 TOKEN_ENC_KEY 還默默跑）', async () => {
    const short = bytesToBase64(new Uint8Array(16));
    await expect(encryptString(short, 'x')).rejects.toThrow();
  });
});
