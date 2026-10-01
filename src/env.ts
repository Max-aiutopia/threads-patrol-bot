// Worker 綁定與環境變數。secret 用 `npx wrangler secret put <名稱>` 設定，本機開發放 .dev.vars
import type { Job } from './types';

export interface Env {
  // 綁定
  DB: D1Database;
  JOBS: Queue<Job>;
  ASSETS: Fetcher;

  // vars（wrangler.jsonc）
  PUBLIC_BASE_URL: string;      // 這支 Worker 的公開網址，例 https://threads-patrol-bot.xxx.workers.dev
  LINE_API_BASE: string;        // https://api.line.me（測試時指到 mock）
  LINE_DATA_API_BASE: string;   // https://api-data.line.me
  THREADS_API_BASE: string;     // https://graph.threads.net
  THREADS_AUTH_URL: string;     // https://threads.com/oauth/authorize
  CLAUDE_API_BASE: string;      // https://api.anthropic.com
  // 選填：Meta 後台登記的 redirect URI 跟預設值（PUBLIC_BASE_URL + /auth/threads/callback）不一樣時才設，
  // 例如後台自動補了結尾斜線。授權與換 token 兩步都用這個值，必須跟後台一字不差
  THREADS_REDIRECT_URI?: string;

  // secrets
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_ADMIN_USER_ID: string;   // Max 的 LINE userId（U 開頭），bot 只回這個人
  THREADS_APP_ID: string;
  THREADS_APP_SECRET: string;
  ANTHROPIC_API_KEY: string;
  DASH_PASSWORD: string;        // 後台密碼
  SESSION_SECRET: string;       // 簽 session cookie 用，隨機 32 bytes 以上
  TOKEN_ENC_KEY: string;        // AES-256-GCM 金鑰，base64 編碼的 32 bytes
}

export const THREADS_API_VERSION = 'v1.0';

// Phase 1 只要這三個權限；不申請代發（見 00_建置計畫 決定 3）
export const THREADS_SCOPES = ['threads_basic', 'threads_read_replies', 'threads_manage_insights'];

export function threadsRedirectUri(env: Env): string {
  const override = (env.THREADS_REDIRECT_URI ?? '').trim();
  if (override) return override;
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/auth/threads/callback`;
}
