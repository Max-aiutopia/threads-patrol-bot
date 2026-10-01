// 文字相似度（純函式，可單元測試）。
// 用字元 bigram 的 Dice 係數：中文不用斷詞也能比，改幾個字、換標點、加 emoji 都還抓得到。

// 比對前先正規化：全形轉半形（NFKC）、英文轉小寫、拿掉空白／標點／符號／emoji
export function normalizeForCompare(s: string): string {
  if (!s) return '';
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{White_Space}\p{P}\p{S}\p{M}\p{Cf}\p{Extended_Pictographic}]/gu, '');
}

// 以 code point 切（避免罕用字被拆成半個），回傳 bigram 出現次數
function bigramCounts(norm: string): Map<string, number> {
  const chars = Array.from(norm);
  const m = new Map<string, number>();
  if (chars.length === 1) {
    m.set(chars[0], 1);
    return m;
  }
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i] + chars[i + 1];
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function total(m: Map<string, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

function dice(a: Map<string, number>, b: Map<string, number>): number {
  const ta = total(a);
  const tb = total(b);
  if (ta === 0 || tb === 0) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [g, c] of small) {
    const d = big.get(g);
    if (d) inter += Math.min(c, d);
  }
  return (2 * inter) / (ta + tb);
}

// 0..1；原文或正規化後完全相同 → 1；空字串 → 0；其中一邊正規化後是空的（例如只有 emoji）→ 0
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return dice(bigramCounts(na), bigramCounts(nb));
}

// 大量兩兩比對用（每小時比對「回覆 × 草稿」）：每段文字只算一次 bigram，比對時直接用。
// 結果跟 similarity() 相同（唯一差別：兩邊正規化後都是空字串時回 0，similarity() 在原文相同時回 1）
export interface BigramProfile { norm: string; grams: Map<string, number>; total: number }

export function bigramProfile(s: string): BigramProfile {
  const norm = normalizeForCompare(s ?? '');
  const grams = norm ? bigramCounts(norm) : new Map<string, number>();
  return { norm, grams, total: total(grams) };
}

export function profileSimilarity(a: BigramProfile, b: BigramProfile): number {
  if (!a.norm || !b.norm) return 0;
  if (a.norm === b.norm) return 1;
  if (a.total === 0 || b.total === 0) return 0;
  let inter = 0;
  const [small, big] = a.grams.size <= b.grams.size ? [a.grams, b.grams] : [b.grams, a.grams];
  for (const [g, c] of small) {
    const d = big.get(g);
    if (d) inter += Math.min(c, d);
  }
  return (2 * inter) / (a.total + b.total);
}

// 跟一堆文字比，回傳最高的相似度
export function maxSimilarity(text: string, corpus: string[]): number {
  if (!text || corpus.length === 0) return 0;
  const nt = normalizeForCompare(text);
  if (!nt) return corpus.includes(text) ? 1 : 0;
  const gt = bigramCounts(nt);
  let best = 0;
  for (const c of corpus) {
    const nc = normalizeForCompare(c ?? '');
    if (!nc) continue;
    if (nc === nt) return 1;
    const s = dice(gt, bigramCounts(nc));
    if (s > best) best = s;
  }
  return best;
}
