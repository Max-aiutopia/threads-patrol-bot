// 偵測網址、網域、@帳號（留言草稿與產品資料卡共用）。
// 先把全形字轉半形（NFKC），再用通用的網域規則比對，所以 lin.ee、pse.is、goo.gl、youtu.be、
// example.xyz、ｍａｘｓｔｕｄｉｏ．ｂｉｚ 都抓得到；「maxstudio。biz」這種用句號隔開的，後面接常見網域結尾才算。
// 只拿來「判斷」，不拿來改寫：留言裡的全形標點要原樣保留。

// 常見的檔名副檔名（都不是真的頂級網域），避免「Node.js」「報價.xlsx」被誤判成網址
const NOT_TLDS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'json', 'csv', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx', 'html', 'htm', 'css', 'mp3', 'mp4', 'exe', 'yaml', 'yml',
]);

// 「。」在中文裡是句號，只有後面緊接這些常見網域結尾時才當成點（「用 Make。Notion 也行」不算）
const IDEOGRAPHIC_DOT_TLDS =
  'com|net|org|tw|biz|io|co|me|ai|app|cc|ly|ee|is|gl|be|gg|xyz|shop|link|info|site|top|store|online|tv|us|uk|jp|hk|cn|so|to|sh|page|dev';
const IDEOGRAPHIC_DOT_RE = new RegExp(`([a-z0-9])\\s*[。｡]\\s*(?=(?:${IDEOGRAPHIC_DOT_TLDS})(?![a-z0-9]))`, 'gi');

const SCHEME_RE = /\b(?:https?|ftp):\/\/|\bwww\./i;
// 英數字組成的網域：至少一個點，最後一段是 2 個字母以上
const DOMAIN_RE = /(?:^|[^a-z0-9._-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24}))(?![a-z0-9-])/gi;
// @帳號（Threads／IG 帳號只有英數、底線、句點）
const MENTION_RE = /(?:^|[^a-z0-9._])@[a-z0-9._]{2,30}/i;

export function normalizeForLinkCheck(s: string): string {
  return String(s ?? '').normalize('NFKC').replace(IDEOGRAPHIC_DOT_RE, '$1.');
}

export function containsLinkOrDomain(s: string): boolean {
  const t = normalizeForLinkCheck(s);
  if (SCHEME_RE.test(t)) return true;
  DOMAIN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DOMAIN_RE.exec(t))) {
    if (!NOT_TLDS.has(m[2].toLowerCase())) return true;
  }
  return false;
}

export function containsMention(s: string): boolean {
  return MENTION_RE.test(normalizeForLinkCheck(s));
}
