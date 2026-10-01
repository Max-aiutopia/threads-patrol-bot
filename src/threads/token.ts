// Threads 長效 token：加密存 D1、讀取、續期、狀態
// 續期規則（官方）：token 至少 24 小時、還沒過期才能續；續完再給 60 天。60 天沒續就作廢，只能重新授權。
// https://developers.facebook.com/documentation/threads/get-started/long-lived-tokens
import type { Env } from '../env';
import { decryptString, encryptString } from '../lib/crypto';
import { DAY, HOUR } from '../lib/time';
import { ThreadsApiError, threadsRawGet } from './client';

const PROVIDER = 'threads';
const DEFAULT_EXPIRES_SEC = 60 * 24 * 60 * 60;

interface TokenRow {
  user_id: string | null;
  username: string | null;
  ciphertext: string;
  iv: string;
  scopes: string | null;
  expires_at: number;
  refreshed_at: number;
}

export async function saveThreadsToken(
  env: Env,
  t: { accessToken: string; userId: string | null; username: string | null; expiresInSec: number; scopes: string | null },
): Promise<void> {
  const now = Date.now();
  const { ciphertext, iv } = await encryptString(env.TOKEN_ENC_KEY, t.accessToken);
  const expiresIn = Number.isFinite(t.expiresInSec) && t.expiresInSec > 0 ? t.expiresInSec : DEFAULT_EXPIRES_SEC;
  // 續期時 userId/username/scopes 會是 null，保留原本的值
  await env.DB.prepare(
    `INSERT INTO app_tokens (provider, user_id, username, ciphertext, iv, scopes, expires_at, refreshed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(provider) DO UPDATE SET
       user_id = COALESCE(excluded.user_id, app_tokens.user_id),
       username = COALESCE(excluded.username, app_tokens.username),
       ciphertext = excluded.ciphertext,
       iv = excluded.iv,
       scopes = COALESCE(excluded.scopes, app_tokens.scopes),
       expires_at = excluded.expires_at,
       refreshed_at = excluded.refreshed_at`,
  )
    .bind(PROVIDER, t.userId, t.username, ciphertext, iv, t.scopes, now + expiresIn * 1000, now)
    .run();
}

export async function getThreadsToken(
  env: Env,
): Promise<{ accessToken: string; userId: string | null; username: string | null; expiresAt: number; refreshedAt: number } | null> {
  const r = await env.DB.prepare(
    'SELECT user_id, username, ciphertext, iv, scopes, expires_at, refreshed_at FROM app_tokens WHERE provider = ?1',
  )
    .bind(PROVIDER)
    .first<TokenRow>();
  if (!r) return null;
  let accessToken: string;
  try {
    accessToken = await decryptString(env.TOKEN_ENC_KEY, r.ciphertext, r.iv);
  } catch {
    // 多半是 TOKEN_ENC_KEY 換過了。當成沒有 token，請 Max 重新連結
    console.error('threads token decrypt failed (TOKEN_ENC_KEY changed?)');
    return null;
  }
  return {
    accessToken,
    userId: r.user_id,
    username: r.username,
    expiresAt: r.expires_at,
    refreshedAt: r.refreshed_at,
  };
}

export async function refreshThreadsToken(env: Env): Promise<{ ok: true; expiresAt: number } | { ok: false; error: string }> {
  const now = Date.now();
  const tok = await getThreadsToken(env);
  if (!tok) return { ok: false, error: '還沒連結 Threads（或 token 讀不出來）' };
  if (tok.expiresAt <= now) return { ok: false, error: 'token 已經過期，只能到後台重新連結' };

  try {
    const b = await threadsRawGet(env, '/refresh_access_token', {
      grant_type: 'th_refresh_token',
      access_token: tok.accessToken,
    });
    const accessToken = typeof b.access_token === 'string' ? b.access_token : '';
    if (!accessToken) return { ok: false, error: '續期回應沒有 access_token' };
    const expiresIn = Number(b.expires_in);
    await saveThreadsToken(env, {
      accessToken,
      userId: null,
      username: null,
      expiresInSec: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_SEC,
      scopes: null,
    });
    const expiresAt = now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_SEC) * 1000;
    return { ok: true, expiresAt };
  } catch (err) {
    // 官方規定 token 未滿 24 小時不能續。剛連結完的 token 還有約 60 天，不算問題
    if (now - tok.refreshedAt < 24 * HOUR) {
      console.log('threads token refresh skipped: token younger than 24h');
      return { ok: true, expiresAt: tok.expiresAt };
    }
    const msg = err instanceof ThreadsApiError ? `${err.status}${err.code ? `/${err.code}` : ''} ${err.message}` : String(err);
    return { ok: false, error: msg.slice(0, 300) };
  }
}

export async function tokenStatus(env: Env): Promise<{ connected: boolean; username: string | null; expiresAt: number | null; daysLeft: number | null }> {
  const r = await env.DB.prepare('SELECT username, expires_at FROM app_tokens WHERE provider = ?1')
    .bind(PROVIDER)
    .first<{ username: string | null; expires_at: number }>();
  if (!r) return { connected: false, username: null, expiresAt: null, daysLeft: null };
  const now = Date.now();
  const left = r.expires_at - now;
  return {
    connected: left > 0,
    username: r.username,
    expiresAt: r.expires_at,
    daysLeft: left > 0 ? Math.floor(left / DAY) : 0,
  };
}
