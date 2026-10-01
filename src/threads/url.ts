// Threads 貼文網址解析與 Web Intent 網址（純函式，可單元測試）
// Web Intent 格式來源：https://developers.facebook.com/documentation/threads/threads-web-intents

export interface ParsedThreadsUrl {
  url: string;             // 正規化後：https://www.threads.com/@user/post/CODE（/t/CODE 則是 https://www.threads.com/t/CODE）
  author: string | null;   // 不含 @，小寫
  shortcode: string;
}

const HOSTS = new Set(['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net']);
const SHORTCODE_RE = /^[A-Za-z0-9_-]+$/;
// Threads 帳號跟 IG 一樣：英數、底線、句點，最多 30 字
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

export function parseThreadsPostUrl(s: string): ParsedThreadsUrl | null {
  if (typeof s !== 'string') return null;
  let raw = s.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!HOSTS.has(u.hostname.toLowerCase())) return null;

  const parts = u.pathname.split('/').filter((p) => p.length > 0);

  // /@user/post/CODE
  if (parts.length === 3 && parts[0].startsWith('@') && parts[1].toLowerCase() === 'post') {
    let user: string;
    try {
      user = decodeURIComponent(parts[0].slice(1));
    } catch {
      return null;
    }
    const code = parts[2];
    if (!USERNAME_RE.test(user) || !SHORTCODE_RE.test(code)) return null;
    const author = user.toLowerCase();
    return { url: `https://www.threads.com/@${author}/post/${code}`, author, shortcode: code };
  }

  // /t/CODE（舊短網址，沒有作者）
  if (parts.length === 2 && parts[0].toLowerCase() === 't') {
    const code = parts[1];
    if (!SHORTCODE_RE.test(code)) return null;
    return { url: `https://www.threads.com/t/${code}`, author: null, shortcode: code };
  }

  return null;
}

// 從一段文字找出第一個 Threads 貼文網址。
// 回傳值多一個 raw（文字裡原本的那一段），方便呼叫端把網址從文字裡拿掉。
// 網址只收 ASCII 字元，所以「看這篇https://…很好笑」這種中文緊貼的寫法也能切乾淨。
const CANDIDATE_RE = /(?<![A-Za-z0-9.-])(?:https?:\/\/)?(?:www\.)?threads\.(?:com|net)\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;

export function extractFirstThreadsUrl(text: string): (ParsedThreadsUrl & { raw: string }) | null {
  if (typeof text !== 'string' || !text) return null;
  CANDIDATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CANDIDATE_RE.exec(text)) !== null) {
    // 去掉句尾標點（半形）
    const candidate = m[0].replace(/[.,;:!?)\]'"]+$/, '');
    const parsed = parseThreadsPostUrl(candidate);
    if (parsed) return { ...parsed, raw: candidate };
  }
  return null;
}

export function buildReplyIntentUrl(shortcode: string, text: string): string {
  return `https://www.threads.com/intent/post?reply_post_shortcode=${encodeURIComponent(shortcode)}&text=${encodeURIComponent(text)}`;
}
