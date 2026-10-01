// 產生 5 則留言草稿：組 prompt → Claude（JSON Schema 輸出）→ 程式後處理（去網址、禁用詞、去重）。
// 後處理是最後一道關：模型沒照規則寫的（網址、@帳號、簡體字、禁用詞、太像舊留言…），整則丟掉，不交給 Max。
import type { Env } from '../env';
import type { DraftVariant, GeneratedComment, GenerateInput, GenerateResult } from '../types';
import { getSettings } from '../lib/settings';
import { containsLinkOrDomain, containsMention } from '../lib/links';
import { bigramProfile, profileSimilarity, type BigramProfile } from '../safety/similarity';
import { callClaudeJson, overBudget } from './claude';
import {
  COMMENT_SCHEMA,
  GLOBAL_BANNED_WORDS,
  buildCommentSystemPrompt,
  buildCommentUserContent,
  type RawCommentOutput,
} from './prompts';

const MAX_COMMENTS = 5;
const MIN_COMMENTS = 3;
const MAX_PRODUCT_MENTIONS = 2;
const SELF_DEDUPE = 0.8; // 同一批裡互相太像就只留第一則
const HARD_MAX_CHARS = 200; // 超過這麼長一定是壞掉了，直接丟
const MIN_CHARS = 4;
const SHORTER_MAX_CHARS = 45; // 「再短一點」要求 40 字內，留一點緩衝

// 只有簡體字才會出現的常用字（繁體、日文都不用）。出現就整則丟掉，不硬轉字形
const SIMPLIFIED_ONLY_RE = /[这们说为个对时过还没问题现发么让应觉东车书买卖头见经实门网络软视频质样]/;

// 中國用語 → 台灣用語。只放不會誤傷的詞；其他靠 prompt。
const TW_TERMS: [RegExp, string][] = [
  [/視頻/g, '影片'],
  [/質量/g, '品質'],
  [/信息/g, '資訊'],
  [/屏幕/g, '螢幕'],
  [/軟件/g, '軟體'],
  [/硬件/g, '硬體'],
  [/網絡/g, '網路'],
  [/默認/g, '預設'],
  [/性價比/g, 'CP 值'],
];

// 摘要（只存在自己的 DB）用的去網址：https://…、www.…、xxx.com / lin.ee / maxstudio.biz …
// 留言草稿不走這裡：含網址、網域或 @帳號的草稿整則丟掉（src/lib/links.ts）。
// 網址字元只收 ASCII，後面緊接的中文不會被一起吃掉
const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]";
const LINK_SRC =
  `https?:\\/\\/${URL_CHARS}+` +
  `|\\bwww\\.${URL_CHARS}+` +
  `|\\b[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,24}\\b(?:\\/${URL_CHARS}*)?`;
const LINK_RE = new RegExp(LINK_SRC, 'gi');
// 網址在句尾時，連前面的「看／去／點…」一起拿掉，免得留下半句「…才順 看」
const TRAILING_LINK_RE = new RegExp(
  `(?:\\s*[，,：:]?\\s*(?:可以|歡迎|請)?(?:看看|去看|參考|搜尋|看|去|到|點|上|搜))?\\s*(?:${LINK_SRC})\\s*$`,
  'i',
);
const HASHTAG_RE = /[#＃][^\s#＃　，。！？、,.!?]+/g;

export function stripLinks(s: string): string {
  let t = s;
  for (let i = 0; i < 3 && TRAILING_LINK_RE.test(t); i++) t = t.replace(TRAILING_LINK_RE, '');
  return t.replace(LINK_RE, '');
}

export function charCount(s: string): number {
  return Array.from(s).length;
}

export function capChars(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n).join('') : s;
}

// 單則留言的清理（不判斷丟不丟）
export function cleanCommentText(raw: string): string {
  let t = String(raw ?? '').normalize('NFC');
  t = t.replace(HASHTAG_RE, '');
  for (const [re, to] of TW_TERMS) t = t.replace(re, to);
  t = t.replace(/[—─]{2,}/g, '，'); // 破折號連用改逗號
  t = t.replace(/[ \t　]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
  t = t.replace(/^(?:\d+[.、)）]|[-•・])\s*/, ''); // 模型自己加的編號
  t = t.replace(/^[「『"“]([^「」『』"“”]*)[」』"”]$/, '$1'); // 整句被一對引號包起來
  t = t.replace(/ +([，。！？、：；）」』])/g, '$1'); // 標點前多出來的空白
  t = t.replace(/([，、,])\s*([，、,。！？!?])/g, '$2').replace(/[，、,：:\s]+$/, '');
  return t.trim();
}

function containsAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => {
    const k = String(w ?? '').trim().toLowerCase();
    return k.length > 0 && lower.includes(k);
  });
}

export interface PostProcessOptions {
  bannedWords: string[]; // 人設卡的禁用詞（會再加上 GLOBAL_BANNED_WORDS）
  avoidTexts: string[]; // 最近送出過的留言
  similarityBlock: number; // settings.similarity_block
  hasProduct: boolean;
  variant?: DraftVariant;
  previousDrafts?: string[]; // 「換一批」時，上一批不能再出現
  drops?: DropCounts; // 有給就記下每則被丟掉的原因（給錯誤訊息用）
}

// 被丟掉的原因。訊息裡要講對原因，不要一律說「太像舊留言」
export type DropReason = 'length' | 'too_long' | 'link' | 'mention' | 'simplified' | 'banned' | 'similar_old' | 'similar_prev' | 'duplicate' | 'product';
export type DropCounts = Partial<Record<DropReason, number>>;

const DROP_TEXT: Record<DropReason, string> = {
  length: '長度不對',
  too_long: '超過 40 字',
  link: '有網址或網域',
  mention: '有 @帳號',
  simplified: '用了簡體字',
  banned: '有禁用詞',
  similar_old: '跟你送出過的留言太像',
  similar_prev: '跟上一批太像',
  duplicate: '彼此重複',
  product: '提產品的超過 2 則',
};

// 「（2 則跟你送出過的留言太像、1 則有網址或網域）」
export function describeDrops(d: DropCounts): string {
  const parts = (Object.keys(DROP_TEXT) as DropReason[]).filter((k) => (d[k] ?? 0) > 0).map((k) => `${d[k]} 則${DROP_TEXT[k]}`);
  return parts.join('、');
}

// 純函式：模型的原始 comments → 可以交給 Max 的草稿（最多 5 則，可能少於 3 則，由呼叫端判斷）
export function postProcessComments(raw: unknown, o: PostProcessOptions): GeneratedComment[] {
  if (!Array.isArray(raw)) return [];
  const banned = [...GLOBAL_BANNED_WORDS, ...(o.bannedWords ?? [])];
  // bigram 先算好重複用（免費版 CPU 只有 10 ms）
  const avoid = (o.avoidTexts ?? []).filter(Boolean).map(bigramProfile);
  const prev = o.variant === 'regen' ? (o.previousDrafts ?? []).filter(Boolean).map(bigramProfile) : [];
  const maxSim = (p: BigramProfile, corpus: BigramProfile[]) => corpus.reduce((m, c) => Math.max(m, profileSimilarity(p, c)), 0);
  const out: GeneratedComment[] = [];
  const outProfiles: BigramProfile[] = [];
  let productCount = 0;
  const drop = (why: DropReason) => {
    if (o.drops) o.drops[why] = (o.drops[why] ?? 0) + 1;
  };

  for (const item of raw) {
    if (out.length >= MAX_COMMENTS) break;
    if (!item || typeof item !== 'object') { drop('length'); continue; }
    const r = item as { text?: unknown; mentions_product?: unknown };
    if (typeof r.text !== 'string') { drop('length'); continue; }

    const text = cleanCommentText(r.text);
    const n = charCount(text);
    if (n < MIN_CHARS || n > HARD_MAX_CHARS) { drop('length'); continue; }
    if (o.variant === 'shorter' && n > SHORTER_MAX_CHARS) { drop('too_long'); continue; }
    // 網址、網域、@帳號：整則丟掉，不只刪掉那一段（免得留下半句話，也免得被 Threads 當成垃圾訊息）
    if (containsLinkOrDomain(r.text) || containsLinkOrDomain(text)) { drop('link'); continue; }
    if (containsMention(text)) { drop('mention'); continue; }
    if (SIMPLIFIED_ONLY_RE.test(text)) { drop('simplified'); continue; }
    if (containsAny(text, banned)) { drop('banned'); continue; }
    const tp = bigramProfile(text);
    if (avoid.length && maxSim(tp, avoid) >= o.similarityBlock) { drop('similar_old'); continue; }
    if (prev.length && maxSim(tp, prev) >= SELF_DEDUPE) { drop('similar_prev'); continue; }
    if (outProfiles.length && maxSim(tp, outProfiles) >= SELF_DEDUPE) { drop('duplicate'); continue; }

    let mentionsProduct = o.hasProduct && r.mentions_product === true;
    if (mentionsProduct) {
      if (productCount >= MAX_PRODUCT_MENTIONS) { drop('product'); continue; } // 提產品的超過 2 則，多的丟掉
      productCount++;
    }
    out.push({ text, mentionsProduct });
    outProfiles.push(tp);
  }
  return out;
}

export function cleanSummary(s: unknown): string {
  if (typeof s !== 'string') return '';
  return capChars(stripLinks(s).replace(/\s+/g, ' ').trim(), 100);
}

function isRawOutput(x: unknown): x is RawCommentOutput {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.skip === 'boolean' && Array.isArray(o.comments);
}

export async function generateComments(env: Env, input: GenerateInput): Promise<GenerateResult> {
  const hasText = !!input.post.text?.trim();
  const hasImage = !!input.post.image?.base64;
  if (!hasText && !hasImage) {
    return { ok: false, reason: 'invalid_output', message: '沒有貼文內容，先貼原文或傳截圖' };
  }

  const settings = await getSettings(env);
  const over = await overBudget(env, settings);
  if (over) {
    return {
      ok: false,
      reason: 'budget',
      message: `本月 Claude 已花 US$${over.spentUsd.toFixed(2)}，到上限 US$${over.budgetUsd.toFixed(2)} 了`,
    };
  }

  const r = await callClaudeJson<RawCommentOutput>(env, {
    purpose: 'comments',
    system: buildCommentSystemPrompt(input.persona, input.product),
    content: buildCommentUserContent(input),
    schema: COMMENT_SCHEMA,
    maxTokens: 8000, // 含自適應思考；只收實際用掉的
    settings,
  });
  if (!r.ok) return { ok: false, reason: r.reason, message: r.message, usage: r.usage };

  const data = r.data;
  if (!isRawOutput(data)) {
    return { ok: false, reason: 'invalid_output', message: 'Claude 回的格式不對', usage: r.usage };
  }
  if (data.skip) {
    const why = capChars(cleanSummary(data.skip_reason), 40) || '內容比較敏感';
    return { ok: false, reason: 'sensitive', message: why, usage: r.usage };
  }

  if (data.comments.length === 0) {
    return { ok: false, reason: 'invalid_output', message: 'Claude 這次沒給出留言', usage: r.usage };
  }
  const drops: DropCounts = {};
  const comments = postProcessComments(data.comments, {
    bannedWords: input.persona.bannedWords,
    avoidTexts: input.avoidTexts,
    similarityBlock: settings.similarity_block,
    hasProduct: !!input.product,
    variant: input.variant,
    previousDrafts: input.previousDrafts,
    drops,
  });
  if (comments.length < MIN_COMMENTS) {
    const why = describeDrops(drops);
    const tooLong = input.variant === 'shorter' && (drops.too_long ?? 0) > 0;
    return {
      ok: false,
      reason: 'invalid_output',
      message: tooLong
        ? `還是太長（${why}）`
        : `能用的留言只剩 ${comments.length} 則${why ? `（${why}）` : ''}`,
      usage: r.usage,
    };
  }

  return { ok: true, comments, summary: cleanSummary(data.summary), usage: r.usage };
}
