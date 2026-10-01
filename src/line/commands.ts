// 解析 Max 在 LINE 傳來的文字：指令、Threads 網址、或一般文字。純函式，不碰 DB。
import { extractFirstThreadsUrl, parseThreadsPostUrl } from '../threads/url';

export type CommandName =
  | 'help' | 'persona' | 'patrol' | 'today' | 'keywords' | 'topics'
  | 'quota' | 'pause' | 'resume' | 'dashboard' | 'unknown';

export type Parsed =
  | { type: 'command'; name: CommandName; args: string }
  | { type: 'threads_url'; url: string; author: string | null; shortcode: string; restText: string }
  | { type: 'text'; text: string };

// '/海巡留言' 是 Luna 的舊指令：沒帶網址就回說明（handlers 會補一句「直接貼網址」）
export const LUNA_ALIAS = '海巡留言';

const ALIASES: [string, CommandName][] = [
  [LUNA_ALIAS, 'help'],
  ['說明', 'help'],
  ['help', 'help'],
  ['?', 'help'],
  ['？', 'help'],
  ['人設', 'persona'],
  ['海巡', 'patrol'],
  ['今日', 'today'],
  ['關鍵字', 'keywords'],
  ['主題', 'topics'],
  ['額度', 'quota'],
  ['暫停', 'pause'],
  ['恢復', 'resume'],
  ['後台', 'dashboard'],
];
const EXACT = new Map<string, CommandName>(ALIASES);
// 中文指令常常不空格就接參數（/暫停24、/海巡AI工具），用前綴比對；長的先比（海巡留言 要在 海巡 前面）
const CJK_PREFIXES = ALIASES.filter(([k]) => /[^\x00-\x7f]/.test(k) && k !== '？').sort((a, b) => b[0].length - a[0].length);

// 網址可用的 ASCII 字元（RFC 3986）。中文或全形標點緊貼在網址後面時，會在這裡斷開
const URL_CHARS = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";
const THREADS_URLISH = new RegExp(`(?:https?:\\/\\/)?(?:[A-Za-z0-9-]+\\.)*threads\\.(?:com|net)(?:\\/[${URL_CHARS}]*)?`, 'gi');

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCandidate(c: string): { shortcode: string } | null {
  let s = c;
  for (let i = 0; i < 3 && s; i++) {
    const p = parseThreadsPostUrl(s) ?? (/^https?:\/\//i.test(s) ? null : parseThreadsPostUrl(`https://${s}`));
    if (p) return p;
    // 網址後面黏著英文標點（例：「(網址)」「網址,」）→ 去掉再試
    const trimmed = s.replace(/[)\].,;:!?'"]+$/, '');
    if (trimmed === s) break;
    s = trimmed;
  }
  return null;
}

function tidy(s: string): string {
  return s
    .replace(/\(\s*\)|（\s*）|「\s*」|\[\s*\]|<\s*>/g, ' ') // 網址拿掉後留下的空括號
    .replace(/[ \t　]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 從原文拿掉「使用者貼的那一段網址」（不是正規化後的網址，兩者可能不同）。
// threads/url.ts 有回傳 raw（原文裡那一段）就直接用；沒有就自己找
function stripThreadsUrl(text: string, shortcode: string, raw?: string): string {
  if (raw) {
    const at = text.indexOf(raw);
    if (at >= 0) return tidy(`${text.slice(0, at)} ${text.slice(at + raw.length)}`);
  }
  let removed = false;
  let out = text.replace(THREADS_URLISH, (m) => {
    if (removed) return m;
    const p = parseCandidate(m);
    if (p && p.shortcode === shortcode) {
      removed = true;
      return ' ';
    }
    return m;
  });
  if (!removed) {
    // 保險：拿掉含這個短碼的那串網址字元
    const re = new RegExp(`[${URL_CHARS}]*${escapeRe(shortcode)}[${URL_CHARS}]*`);
    out = out.replace(re, ' ');
  }
  return tidy(out);
}

function findThreadsUrl(text: string): Extract<Parsed, { type: 'threads_url' }> | null {
  const hit = extractFirstThreadsUrl(text);
  if (!hit) return null;
  const raw = (hit as { raw?: unknown }).raw;
  return {
    type: 'threads_url',
    url: hit.url,
    author: hit.author,
    shortcode: hit.shortcode,
    restText: stripThreadsUrl(text, hit.shortcode, typeof raw === 'string' ? raw : undefined),
  };
}

export function parseIncoming(text: string): Parsed {
  const raw = (text ?? '').replace(/\r\n?/g, '\n');
  const t = raw.trim();

  if (t.startsWith('/') || t.startsWith('／')) {
    const body = t.slice(1);
    const m = /^(\S*)([\s\S]*)$/.exec(body);
    const token = m ? m[1] : '';
    let rest = m ? m[2] : '';
    const key = token.toLowerCase(); // 只影響英文字母，中文不變
    let name = EXACT.get(key);
    let matched = name ? key : '';
    if (!name) {
      const hit = CJK_PREFIXES.find(([k]) => key.startsWith(k));
      if (hit) {
        name = hit[1];
        matched = hit[0];
        rest = token.slice(hit[0].length) + rest;
      }
    }
    const args = rest.trim();
    if (matched === LUNA_ALIAS) {
      const u = findThreadsUrl(args);
      if (u) return u;
    }
    return { type: 'command', name: name ?? 'unknown', args };
  }

  const u = findThreadsUrl(raw);
  if (u) return u;
  return { type: 'text', text: t };
}
