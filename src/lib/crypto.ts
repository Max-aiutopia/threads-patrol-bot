// 加解密與簽章小工具。全部用 Web Crypto，Workers 原生支援。

const enc = new TextEncoder();
const dec = new TextDecoder();

const B64_CODES = new Uint8Array(64);
{
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 64; i++) B64_CODES[i] = abc.charCodeAt(i);
}

// 查表編碼：比「String.fromCharCode + btoa」快十幾倍（1 MB 截圖約 1 ms，舊寫法約 19 ms），
// 免費版每次只有 10 ms CPU，截圖轉 base64 是最重的一步
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = u8.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out[o++] = B64_CODES[v >> 18];
    out[o++] = B64_CODES[(v >> 12) & 63];
    out[o++] = B64_CODES[(v >> 6) & 63];
    out[o++] = B64_CODES[v & 63];
  }
  if (i < n) {
    const two = i + 1 < n;
    const v = (u8[i] << 16) | ((two ? u8[i + 1] : 0) << 8);
    out[o++] = B64_CODES[v >> 18];
    out[o++] = B64_CODES[(v >> 12) & 63];
    out[o++] = two ? B64_CODES[(v >> 6) & 63] : 61; // '='
    out[o++] = 61;
  }
  return dec.decode(out);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return base64ToBytes(b64);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

// LINE x-line-signature：Base64(HMAC-SHA256(channelSecret, 原始 body))
export async function hmacSha256Base64(secret: string, data: string): Promise<string> {
  return bytesToBase64(await hmacSha256(secret, data));
}

export async function sha256Hex(data: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(data)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 固定時間比較，避免從回應時間猜出正確值
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// 無偏差的 base62 隨機字串（/go/<id> 與 batch id 用）
export function randomId(length = 16): string {
  let out = '';
  while (out.length < length) {
    const buf = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of buf) {
      if (b < 248) out += BASE62[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyB64);
  if (raw.length !== 32) throw new Error('TOKEN_ENC_KEY 必須是 base64 編碼的 32 bytes');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptString(keyB64: string, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyB64);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return { ciphertext: bytesToBase64(ct), iv: bytesToBase64(iv) };
}

export async function decryptString(keyB64: string, ciphertext: string, iv: string): Promise<string> {
  const key = await aesKey(keyB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, key, base64ToBytes(ciphertext));
  return dec.decode(pt);
}
