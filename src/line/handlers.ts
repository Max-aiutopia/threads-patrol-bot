// LINE 事件處理（由 Queue consumer 呼叫）：產留言、指令、按鈕都從這裡分派。
// 原則：
// - 回覆一律走 sendResult（reply token 新鮮就 reply 免費，不然 push）
// - 慢的事（Claude、下載截圖）之前先叫等待動畫
// - 出錯不把原始錯誤丟給使用者，回一句短的中文，細節寫 job_log
// - Workers 免費版每次最多 40 個 D1 查詢：能合併的都用 DB.batch，最重的「截圖產留言」約 25 個
import type { Env } from '../env';
import type {
  DraftVariant, GenerateInput, GenerateResult, LineEventJob, LineMessage, LineWebhookEvent, Persona, ReplyContext,
} from '../types';
import { LineClient, sendResult } from './client';
import { LUNA_ALIAS, parseIncoming, type CommandName } from './commands';
import { buildDraftCarousel, defaultQuickReplies, linkCard, personaPicker, textMessage, type DraftCardInput, type QuickReplyItem } from './flex';
import { getSettings, logJob, setSetting, type Settings } from '../lib/settings';
import { getActiveProduct, getPersona, listPersonas, monthLlmCostUsd, monthPushCount, recentPostedTexts } from '../lib/repo';
import { bytesToBase64, randomId } from '../lib/crypto';
import { DAY, HOUR, inWindow, taipeiDate, taipeiHHMM, taipeiShort, windowEndAt } from '../lib/time';
import { generateComments } from '../llm/comments';
import { analyzeKeywords, analyzeTopics } from '../llm/analysis';
import { USD_TO_TWD } from '../llm/pricing';
import { activePause, pauseFor, resume as resumePause } from '../safety/pause';
import { quotaStatus } from '../safety/limits';
import { buildTodaySummary } from '../jobs/morning';
import { tokenStatus } from '../threads/token';

const PENDING_TTL_MS = 10 * 60_000;        // 貼完網址後 10 分鐘內傳原文／截圖才算數
const KEYWORD_TTL_MS = 6 * HOUR;           // /海巡 的關鍵字 6 小時內有效
const MIN_INLINE_TEXT = 8;                 // 網址後面至少 8 個字才當原文
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;  // Claude API 單張圖 5 MB；用 base64 後的長度算比較保險
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const REDELIVERY_TOKEN_MAX_AGE_MS = 20 * 60_000; // 重送事件的 reply token：事件發生 20 分鐘內、收到後 1 分鐘內可用
const RACE_RECHECK_WINDOW_MS = 30_000;
const RACE_RECHECK_DELAY_MS = 1_500;

const HELP_TEXT = [
  '怎麼用：',
  '1. 在 Threads 找到想回的貼文 → 分享 → 複製連結',
  '2. 貼到這裡，下一行貼原文（或下一則傳截圖）',
  '3. 我回 5 則留言，按「開 Threads 回覆」→ 在 Threads 按送出',
  '',
  '指令：',
  '/海巡 關鍵字　記下關鍵字，給你搜尋按鈕',
  '/人設　切換人設',
  '/今日　今天的數據',
  '/關鍵字　從你表現好的貼文找關鍵字',
  '/主題　哪些主題表現好但寫太少',
  '/額度　今天還能留幾則、花了多少',
  '/暫停 24　暫停 24 小時',
  '/恢復　解除暫停',
  '/後台　後台連結',
].join('\n');

const HINT_TEXT = '要產留言：先貼 Threads 貼文網址，下一行貼原文（或下一則傳截圖）。\n打 /說明 看全部指令。';
const GOT_URL_TEXT = '收到網址。10 分鐘內貼原文或傳一張截圖；不回了就打「取消」。';
const SHORT_TEXT_HINT = '這段太短，不像貼文原文。把原文整段貼過來，或傳截圖；不回了就打「取消」。';
const EXPIRED_TEXT = '剛剛的網址超過 10 分鐘了。再貼一次網址，原文接在下一行。';
const EXPIRED_IMAGE_TEXT = '剛剛的網址超過 10 分鐘了。先重貼網址，再傳截圖。';
const CANCEL_RE = /^(取消|算了|不用了)$/;
const EXPIRED_NOTICE_MS = DAY; // 超過一天的舊網址就不提了，直接給一般說明
const BATCH_GONE = '這批草稿找不到了（可能已經清掉），重新貼一次網址。';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

function cutChars(s: string, n: number): string {
  const a = Array.from(s);
  return a.length <= n ? s : a.slice(0, n).join('');
}

// 同一天顯示 HH:MM，不同天顯示 M/D HH:MM（台北時間）
function whenText(ts: number, now: number): string {
  return taipeiDate(ts) === taipeiDate(now) ? taipeiHHMM(ts) : taipeiShort(ts);
}

function normalizeAuthor(a: string | null | undefined): string | null {
  const v = (a ?? '').trim().replace(/^@+/, '');
  return v || null;
}

// ---------- 回覆 ----------

// 包一層：記住「已經試著回過了」，出錯時才不會再補一則錯誤訊息；最後一則自動加 quick reply
class Responder {
  attempted = false;
  private readonly env: Env;
  readonly rctx: ReplyContext;

  constructor(env: Env, rctx: ReplyContext) {
    this.env = env;
    this.rctx = rctx;
  }

  async send(messages: LineMessage[]): Promise<'reply' | 'push' | 'failed'> {
    this.attempted = true;
    const last = messages.length - 1;
    const out = messages.map((m, i) => (i === last && !('quickReply' in m) ? { ...m, quickReply: { items: defaultQuickReplies() } } : m));
    return sendResult(this.env, this.rctx, out);
  }

  text(s: string): Promise<'reply' | 'push' | 'failed'> {
    return this.send([textMessage(s)]);
  }
}

// reply token 的計時起點。一般事件用事件時間；重送事件的 token 從「收到重送」起算 1 分鐘
function replyClock(ev: LineWebhookEvent, receivedAt: number): number {
  const ts = typeof ev.timestamp === 'number' && Number.isFinite(ev.timestamp) ? ev.timestamp : receivedAt;
  if (ev.deliveryContext?.isRedelivery && receivedAt - ts < REDELIVERY_TOKEN_MAX_AGE_MS) return receivedAt;
  return ts;
}

// ---------- 入口 ----------

export async function processLineEvent(job: LineEventJob, env: Env, _ctx: ExecutionContext): Promise<void> {
  const ev = job.event;
  const userId = ev?.source?.userId;
  // webhook 已經擋過，這裡再擋一次
  const adminId = (env.LINE_ADMIN_USER_ID ?? '').trim();
  if (!userId || !adminId || userId !== adminId) return;

  // Queue 至少送一次、可能送兩次：先把狀態從 queued 搶成 processing，搶不到就是別人處理過了
  const claim = await env.DB.prepare("UPDATE line_events SET status = 'processing' WHERE webhook_event_id = ?1 AND status = 'queued'")
    .bind(ev.webhookEventId)
    .run();
  if (!claim.meta?.changes) {
    console.log('line event skipped (already handled)', ev.type);
    return;
  }

  const r = new Responder(env, { userId, replyToken: ev.replyToken, eventTimestamp: replyClock(ev, job.receivedAt) });
  let ok = true;
  try {
    await route(env, r, ev);
  } catch (err) {
    ok = false;
    console.error('line event failed', ev.type, errText(err));
    await logJob(env, 'line_event', false, `${ev.type}: ${errText(err)}`);
    if (!r.attempted) {
      try {
        await r.text('出了點問題，等一下再試一次。');
      } catch {
        // 連錯誤訊息都送不出去就算了，job_log 有紀錄
      }
    }
  }
  try {
    await env.DB.prepare('UPDATE line_events SET status = ?1 WHERE webhook_event_id = ?2').bind(ok ? 'done' : 'failed', ev.webhookEventId).run();
  } catch (err) {
    console.error('line_events status update failed', errText(err));
  }
}

async function route(env: Env, r: Responder, ev: LineWebhookEvent): Promise<unknown> {
  switch (ev.type) {
    case 'follow':
      return r.text(`加入完成。這個帳號只回你一個人。\n\n${HELP_TEXT}`);
    case 'postback':
      return onPostback(env, r, ev);
    case 'message': {
      const m = ev.message;
      if (!m) return;
      if (m.type === 'text') return onText(env, r, ev, m.text ?? '');
      if (m.type === 'image') return onImage(env, r, ev);
      return r.text(`我只看得懂文字和截圖。\n${HINT_TEXT}`);
    }
    default:
      return;
  }
}

// ---------- 對話狀態（先貼網址，下一則再給原文或截圖） ----------

interface ConvState {
  pending_url: string | null;
  pending_shortcode: string | null;
  pending_author: string | null;
  pending_at: number | null;
  current_keyword: string | null;
  keyword_at: number | null;
}
type PendingState = ConvState & { pending_url: string; pending_shortcode: string; pending_at: number };

interface TargetRef { url: string; shortcode: string; author: string | null }

async function loadState(env: Env, userId: string): Promise<ConvState | null> {
  return env.DB.prepare(
    'SELECT pending_url, pending_shortcode, pending_author, pending_at, current_keyword, keyword_at FROM conversation_state WHERE user_id = ?1',
  )
    .bind(userId)
    .first<ConvState>();
}

function hasPending(s: ConvState | null, now: number): s is PendingState {
  return !!s && !!s.pending_url && !!s.pending_shortcode && typeof s.pending_at === 'number' && now - s.pending_at < PENDING_TTL_MS;
}

// 網址還記著、但已經超過 10 分鐘（要跟 Max 講清楚，不要當成他沒貼過）
function hasExpiredPending(s: ConvState | null, now: number): s is PendingState {
  return (
    !!s && !!s.pending_url && !!s.pending_shortcode && typeof s.pending_at === 'number' &&
    now - s.pending_at >= PENDING_TTL_MS && now - s.pending_at < EXPIRED_NOTICE_MS
  );
}

function cancelQuickReplies(): QuickReplyItem[] {
  return [{ type: 'action', action: { type: 'message', label: '取消', text: '取消' } }, ...defaultQuickReplies()];
}

// 網址和截圖幾乎同時送到時，兩個事件可能被平行處理，網址那則還沒寫進去。沒找到就等一下再讀一次
async function loadStateForFollowUp(env: Env, userId: string, eventTs: number): Promise<ConvState | null> {
  const s = await loadState(env, userId);
  if (hasPending(s, Date.now())) return s;
  if (Date.now() - eventTs < RACE_RECHECK_WINDOW_MS) {
    await sleep(RACE_RECHECK_DELAY_MS);
    return loadState(env, userId);
  }
  return s;
}

function activeKeyword(s: ConvState | null, now: number): string | null {
  if (!s?.current_keyword || typeof s.keyword_at !== 'number') return null;
  return now - s.keyword_at < KEYWORD_TTL_MS ? s.current_keyword : null;
}

function pendingTarget(s: PendingState): TargetRef {
  return { url: s.pending_url, shortcode: s.pending_shortcode, author: normalizeAuthor(s.pending_author) };
}

function setPendingStmt(env: Env, userId: string, t: TargetRef, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO conversation_state (user_id, pending_url, pending_shortcode, pending_author, pending_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(user_id) DO UPDATE SET
       pending_url = excluded.pending_url, pending_shortcode = excluded.pending_shortcode,
       pending_author = excluded.pending_author, pending_at = excluded.pending_at, updated_at = excluded.updated_at`,
  ).bind(userId, t.url, t.shortcode, t.author, now);
}

type PendingGuard = { shortcode: string } | { before: number };

// 只清掉「這次用掉的」那筆：用短碼比對，或只清這個事件開始前就存在的，避免清到平行事件剛寫的新網址
function clearPendingStmt(env: Env, userId: string, guard: PendingGuard, now: number): D1PreparedStatement {
  const base = 'UPDATE conversation_state SET pending_url = NULL, pending_shortcode = NULL, pending_author = NULL, pending_at = NULL, updated_at = ?2 WHERE user_id = ?1';
  return 'shortcode' in guard
    ? env.DB.prepare(`${base} AND pending_shortcode = ?3`).bind(userId, now, guard.shortcode)
    : env.DB.prepare(`${base} AND pending_at IS NOT NULL AND pending_at <= ?3`).bind(userId, now, guard.before);
}

// 產生失敗時把網址的 10 分鐘重新起算，Max 再傳一次原文／截圖就能重試
function bumpPendingStmt(env: Env, userId: string, shortcode: string, now: number): D1PreparedStatement {
  return env.DB.prepare('UPDATE conversation_state SET pending_at = ?2, updated_at = ?2 WHERE user_id = ?1 AND pending_shortcode = ?3').bind(
    userId,
    now,
    shortcode,
  );
}

function upsertTargetStmt(env: Env, t: TargetRef, keyword: string | null, sourceType: 'text' | 'image' | null, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO targets (shortcode, author_username, url, keyword, source_type, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(shortcode) DO UPDATE SET
       author_username = COALESCE(excluded.author_username, targets.author_username),
       url = excluded.url,
       keyword = COALESCE(excluded.keyword, targets.keyword),
       source_type = COALESCE(excluded.source_type, targets.source_type),
       updated_at = excluded.updated_at
     RETURNING id`,
  ).bind(t.shortcode, t.author, t.url, keyword, sourceType, now);
}

async function upsertTargetId(env: Env, t: TargetRef, keyword: string | null, sourceType: 'text' | 'image' | null, now: number): Promise<number> {
  const row = await upsertTargetStmt(env, t, keyword, sourceType, now).first<{ id: number }>();
  if (!row) throw new Error('targets upsert 沒有回傳 id');
  return row.id;
}

// ---------- 產留言（貼文字、截圖、按鈕共用） ----------

interface GenParams {
  target: TargetRef & { id?: number };
  text?: string;
  image?: { base64: string; mediaType: string };
  sourceType: 'text' | 'image' | null;   // null = 不改（按鈕重產）
  variant: DraftVariant;
  keyword: string | null;
  previousDrafts?: string[];
  clearPending: PendingGuard | null;     // 產完（或判定敏感）要清掉的 pending
  keepPendingOnError: boolean;           // 失敗時保留 pending 並重新計時
  retryHint: string;
  loadingStarted?: boolean;
  note?: string;                         // 卡片後面補一句（例：只讀第 1 張圖）
}

async function resolveActivePersona(env: Env, s: Settings): Promise<Persona | null> {
  // 跟 repo.getActivePersona 同邏輯，但沿用已讀的 settings，省一次查詢
  if (s.active_persona_id) {
    const p = await getPersona(env, s.active_persona_id);
    if (p && p.isActive) return p;
  }
  const list = await listPersonas(env, true);
  return list[0] ?? null;
}

async function budgetBlock(env: Env, s: Settings, now: number): Promise<string | null> {
  const budget = s.monthly_budget_usd;
  if (!(budget > 0)) return null;
  const spent = await monthLlmCostUsd(env, now);
  if (spent < budget) return null;
  return `這個月 Claude 已經花 US$${spent.toFixed(2)}，到預算 US$${budget.toFixed(2)} 了，先停下來。\n要繼續就到後台「安全設定」調高預算。`;
}

async function generateFlow(env: Env, r: Responder, p: GenParams): Promise<void> {
  const userId = r.rctx.userId;
  // 1. 先叫等待動畫（Claude 要跑十幾秒）
  if (!p.loadingStarted) await new LineClient(env).startLoading(userId, 45);

  const now = Date.now();
  const settings = await getSettings(env);
  // 2. 暫停中照樣可以產草稿（產草稿不會動到 Threads），只在回覆裡提醒
  // 3. 本月預算用完就停
  const [pause, blocked] = await Promise.all([activePause(env, now), budgetBlock(env, settings, now)]);
  if (blocked) {
    await r.text(blocked);
    return;
  }

  // 4. 人設、產品、最近送出的留言
  const persona = await resolveActivePersona(env, settings);
  if (!persona) {
    await r.text('還沒有啟用中的人設。先到後台「人設與產品」新增或啟用一個。');
    return;
  }
  const [product, avoidTexts, targetId] = await Promise.all([
    getActiveProduct(env),
    recentPostedTexts(env, 50),
    p.target.id ?? upsertTargetId(env, p.target, p.keyword, p.sourceType, now),
  ]);

  // 5. 呼叫 Claude
  const post: GenerateInput['post'] = { url: p.target.url, author: p.target.author };
  if (p.text) post.text = p.text;
  if (p.image) post.image = p.image;
  const input: GenerateInput = { post, persona, product, variant: p.variant, keyword: p.keyword, avoidTexts };
  if (p.previousDrafts && p.previousDrafts.length) input.previousDrafts = p.previousDrafts;
  const res = await generateComments(env, input);
  if (!res.ok || !res.comments.length) {
    await onGenerateFailure(env, r, res, p);
    return;
  }

  // 6. 存 batch、5 則草稿、摘要、關鍵字紀錄，一次 batch 寫完
  const batchId = randomId(12);
  const created = Date.now();
  const drafts: DraftCardInput[] = res.comments.slice(0, 5).map((c, i) => ({
    draftId: randomId(16),
    idx: i + 1,
    text: c.text,
    mentionsProduct: !!c.mentionsProduct,
  }));
  const summary = cutChars((res.summary ?? '').trim(), 100) || null;
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO draft_batches (id, target_id, persona_id, variant, keyword, model, input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(
      batchId, targetId, persona.id, p.variant, p.keyword,
      res.usage?.model || settings.llm_model, res.usage?.inputTokens ?? null, res.usage?.outputTokens ?? null, res.usage?.costUsd ?? null,
      created,
    ),
    ...drafts.map((d) =>
      env.DB.prepare(
        `INSERT INTO comment_drafts (id, batch_id, target_id, idx, text, mentions_product, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', ?7)`,
      ).bind(d.draftId, batchId, targetId, d.idx, d.text, d.mentionsProduct ? 1 : 0, created),
    ),
  ];
  if (summary) {
    // 按鈕重產時手上只有摘要，不要拿「摘要的摘要」蓋掉原本的
    stmts.push(
      p.variant === 'default'
        ? env.DB.prepare('UPDATE targets SET summary = ?1, summary_at = ?2, updated_at = ?2 WHERE id = ?3').bind(summary, created, targetId)
        : env.DB.prepare(
            // 保存天數看 summary_at：按鈕重產不延長舊摘要的壽命
            `UPDATE targets SET summary = COALESCE(summary, ?1),
                    summary_at = CASE WHEN summary IS NULL THEN ?2 ELSE summary_at END, updated_at = ?2
              WHERE id = ?3`,
          ).bind(summary, created, targetId),
    );
  }
  if (p.keyword) stmts.push(env.DB.prepare("INSERT INTO keyword_log (keyword, source, created_at) VALUES (?1, 'draft', ?2)").bind(p.keyword, created));
  if (p.clearPending) stmts.push(clearPendingStmt(env, userId, p.clearPending, created));
  await env.DB.batch(stmts);

  const carousel = buildDraftCarousel({
    batchId,
    drafts,
    personaName: persona.name,
    targetAuthor: p.target.author,
    baseUrl: env.PUBLIC_BASE_URL,
    clipboard: settings.flex_clipboard,
    openExternal: settings.open_external_browser,
    keyword: p.keyword,
  });
  const notes: string[] = [];
  if (pause) notes.push(`目前暫停中，到 ${taipeiShort(pause.untilAt)}（${pause.reason}）。草稿先留著，暫停結束才開得了 Threads。`);
  if (p.note) notes.push(p.note);
  const messages: LineMessage[] = [carousel];
  if (notes.length) messages.push(textMessage(notes.join('\n')));
  const sent = await r.send(messages);
  if (sent === 'failed') {
    // 卡片被 LINE 退回（多半是 Flex 格式問題，細節在 job_log 的 line_reply／line_push）：改送純文字，草稿照樣能用
    const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    const q = settings.open_external_browser ? '?openExternalBrowser=1' : '';
    const lines = ['卡片送不出去，先用文字給你：'];
    for (const d of drafts) lines.push('', `${d.idx}. ${d.text}`, `開 Threads 回覆：${base}/go/${d.draftId}${q}`);
    if (notes.length) lines.push('', ...notes);
    await r.send([textMessage(lines.join('\n'))]);
  }
}

async function onGenerateFailure(env: Env, r: Responder, res: GenerateResult, p: GenParams): Promise<void> {
  const userId = r.rctx.userId;
  const now = Date.now();
  const reason = res.ok ? 'invalid_output' : res.reason;
  const message = res.ok ? '沒有產出任何留言' : res.message ?? '';

  if (reason === 'sensitive') {
    if (p.clearPending) await clearPendingStmt(env, userId, p.clearPending, now).run();
    const why = cutChars(message.trim(), 60);
    await r.text(`這篇內容比較敏感${why ? `（${why}）` : ''}，我不產留言。`);
    return;
  }
  if (reason === 'budget') {
    await r.text(`${message.trim() || '這個月的 Claude 預算用完了'}，先不產留言。\n要繼續就到後台「安全設定」調高預算。`);
    return;
  }

  const REASON_ZH: Record<string, string> = { refusal: 'Claude 拒絕處理', invalid_output: '產出不能用', api_error: '呼叫 Claude 失敗' };
  await logJob(env, 'generate', false, `${REASON_ZH[reason] ?? reason}：${message}`);
  if (p.keepPendingOnError && p.clearPending && 'shortcode' in p.clearPending) {
    await bumpPendingStmt(env, userId, p.clearPending.shortcode, now).run();
  }
  // llm 模組回的 message 本來就是給人看的短句（例：「能用的留言只剩 2 則…」「Claude 太久沒回應」）
  const detail = message.trim().replace(/[。.]+$/, '');
  const head =
    reason === 'refusal'
      ? 'Claude 這次不肯寫這篇。'
      : reason === 'invalid_output'
        ? `這次產出的留言不能用${detail ? `：${detail}` : ''}。`
        : `${detail || 'Claude 暫時連不上'}。等一兩分鐘，`;
  await r.text(`${head}${p.retryHint}`);
}

// ---------- 文字訊息 ----------

async function onText(env: Env, r: Responder, ev: LineWebhookEvent, text: string): Promise<unknown> {
  const parsed = parseIncoming(text);
  if (parsed.type === 'command') return onCommand(env, r, parsed.name, parsed.args, text);

  const userId = r.rctx.userId;
  const startedAt = Date.now();

  if (parsed.type === 'threads_url') {
    const state = await loadState(env, userId);
    const keyword = activeKeyword(state, startedAt);
    const target: TargetRef = { url: parsed.url, shortcode: parsed.shortcode, author: normalizeAuthor(parsed.author) };
    if (parsed.restText.length >= MIN_INLINE_TEXT) {
      // 網址＋原文一起貼：直接產。之前沒用掉的 pending 已經過時，一起清掉
      return generateFlow(env, r, {
        target,
        text: parsed.restText,
        sourceType: 'text',
        variant: 'default',
        keyword,
        clearPending: state?.pending_at ? { before: startedAt } : null,
        keepPendingOnError: false,
        retryHint: '再貼一次網址和原文就會重試。',
      });
    }
    await env.DB.batch([upsertTargetStmt(env, target, keyword, null, startedAt), setPendingStmt(env, userId, target, startedAt)]);
    return r.send([textMessage(GOT_URL_TEXT, cancelQuickReplies())]);
  }

  // 一般文字：10 分鐘內貼過網址 → 這則就是原文
  const state = await loadStateForFollowUp(env, userId, ev.timestamp);
  const now = Date.now();
  const body = parsed.text;
  const isCancel = CANCEL_RE.test(body);
  if (hasPending(state, now)) {
    if (isCancel) {
      await clearPendingStmt(env, userId, { shortcode: state.pending_shortcode }, now).run();
      return r.text('好，這篇先不回。');
    }
    // 「好」「等等」「?」這種順手回的字不要拿去叫 Claude（一次約 NT$1）。網址照樣記著
    if (Array.from(body).length < MIN_INLINE_TEXT) return r.send([textMessage(SHORT_TEXT_HINT, cancelQuickReplies())]);
    return generateFlow(env, r, {
      target: pendingTarget(state),
      text: body,
      sourceType: 'text',
      variant: 'default',
      keyword: activeKeyword(state, now),
      clearPending: { shortcode: state.pending_shortcode },
      keepPendingOnError: true,
      retryHint: '網址還記著，再傳一次原文或截圖就會重試。',
    });
  }
  if (isCancel) {
    if (state?.pending_shortcode) await clearPendingStmt(env, userId, { shortcode: state.pending_shortcode }, now).run();
    return r.text(state?.pending_shortcode ? '好，這篇先不回。' : '目前沒有要取消的。');
  }
  if (hasExpiredPending(state, now)) {
    await clearPendingStmt(env, userId, { shortcode: state.pending_shortcode }, now).run();
    return r.text(EXPIRED_TEXT);
  }
  return r.text(HINT_TEXT);
}

// ---------- 截圖 ----------

function sniffImageType(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp';
  return null;
}

async function onImage(env: Env, r: Responder, ev: LineWebhookEvent): Promise<unknown> {
  const m = ev.message as NonNullable<LineWebhookEvent['message']> & { imageSet?: { id?: string; index?: number; total?: number } };
  // 一次傳好幾張會拆成好幾個事件、順序不定：只用第 1 張，其他不回
  const set = m.imageSet;
  if (set && typeof set.index === 'number' && set.index > 1) return;

  const userId = r.rctx.userId;
  const state = await loadStateForFollowUp(env, userId, ev.timestamp);
  const now = Date.now();
  if (!hasPending(state, now)) {
    if (hasExpiredPending(state, now)) {
      await clearPendingStmt(env, userId, { shortcode: state.pending_shortcode }, now).run();
      return r.text(EXPIRED_IMAGE_TEXT);
    }
    return r.text('先貼 Threads 網址，再傳截圖。');
  }
  if (m.contentProvider?.type === 'external') return r.text('這張圖抓不到。請從相簿直接傳截圖。');

  const client = new LineClient(env);
  await client.startLoading(userId, 45);
  let content: { bytes: ArrayBuffer; contentType: string };
  try {
    content = await client.getContent(m.id);
  } catch (err) {
    await logJob(env, 'line_content', false, errText(err));
    return r.text('截圖下載失敗，再傳一次試試。');
  }
  if (content.bytes.byteLength > MAX_IMAGE_BYTES) return r.text('截圖超過 5 MB，裁小一點再傳。');
  const head = new Uint8Array(content.bytes, 0, Math.min(16, content.bytes.byteLength));
  const mediaType = sniffImageType(head) ?? content.contentType.split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(mediaType)) return r.text('這個圖片格式讀不了，請傳 JPG 或 PNG 截圖。');
  const base64 = bytesToBase64(content.bytes);
  if (base64.length > MAX_IMAGE_BASE64) return r.text('截圖太大，裁小一點再傳。');

  const total = set && typeof set.total === 'number' && set.total > 1 ? set.total : 0;
  return generateFlow(env, r, {
    target: pendingTarget(state),
    image: { base64, mediaType },
    sourceType: 'image',
    variant: 'default',
    keyword: activeKeyword(state, now),
    clearPending: { shortcode: state.pending_shortcode },
    keepPendingOnError: true,
    retryHint: '網址還記著，再傳一次截圖就會重試。',
    loadingStarted: true,
    note: total ? `你一次傳了 ${total} 張，我只讀第 1 張。` : undefined,
  });
}

// ---------- 按鈕（postback） ----------

async function onPostback(env: Env, r: Responder, ev: LineWebhookEvent): Promise<unknown> {
  const q = new URLSearchParams(ev.postback?.data ?? '');
  const action = q.get('action');
  if (action === 'regen' || action === 'shorter' || action === 'playful') return onVariant(env, r, action, q.get('batch'));
  if (action === 'personas') return showPersonaPicker(env, r);
  if (action === 'persona') return switchPersonaById(env, r, Number(q.get('id')));
  return r.text('這顆按鈕沒有作用了。');
}

interface BatchRow { target_id: number; keyword: string | null; shortcode: string; url: string; author: string | null; summary: string | null }

async function onVariant(env: Env, r: Responder, variant: 'regen' | 'shorter' | 'playful', batchId: string | null): Promise<unknown> {
  if (!batchId || !/^[A-Za-z0-9]{6,32}$/.test(batchId)) return r.text(BATCH_GONE);
  await new LineClient(env).startLoading(r.rctx.userId, 45);

  // 這批的貼文資訊＋同一篇貼文最近的草稿（按的那批排前面），一次 batch 讀
  const [bRes, dRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT b.target_id AS target_id, b.keyword AS keyword, t.shortcode AS shortcode, t.url AS url,
              t.author_username AS author, t.summary AS summary
       FROM draft_batches b JOIN targets t ON t.id = b.target_id WHERE b.id = ?1`,
    ).bind(batchId),
    env.DB.prepare(
      `SELECT text FROM comment_drafts
       WHERE target_id = (SELECT target_id FROM draft_batches WHERE id = ?1)
       ORDER BY (batch_id = ?1) DESC, created_at DESC, idx LIMIT 15`,
    ).bind(batchId),
  ]);
  const row = ((bRes?.results ?? []) as BatchRow[])[0];
  if (!row) return r.text(BATCH_GONE);
  const previous = ((dRes?.results ?? []) as { text: string }[]).map((x) => x.text).filter((t) => typeof t === 'string' && t);

  // 不存原文，只剩 100 字內摘要（30 天後會清掉）＋上一批草稿當線索。摘要清掉了就沒辦法重產
  if (!row.summary) return r.text('這篇的摘要已經清掉了（超過 30 天），重新貼一次網址和原文。');
  const text = `（原文沒有保存，這是摘要）${row.summary}`;
  return generateFlow(env, r, {
    target: { id: row.target_id, url: row.url, shortcode: row.shortcode, author: normalizeAuthor(row.author) },
    text,
    sourceType: null,
    variant,
    keyword: row.keyword,
    previousDrafts: previous,
    clearPending: null,
    keepPendingOnError: false,
    retryHint: variant === 'shorter' ? '再按一次「再短一點」試試。' : '再按一次按鈕試試。',
    loadingStarted: true,
  });
}

// ---------- 人設 ----------

function currentPersonaId(s: Settings, list: Persona[]): number | null {
  if (s.active_persona_id && list.some((p) => p.id === s.active_persona_id)) return s.active_persona_id;
  return list[0]?.id ?? null;
}

async function showPersonaPicker(env: Env, r: Responder, lead?: string): Promise<unknown> {
  const [settings, list] = await Promise.all([getSettings(env), listPersonas(env, true)]);
  const activeId = currentPersonaId(settings, list);
  const messages: LineMessage[] = [];
  if (lead) messages.push(textMessage(lead));
  messages.push(personaPicker(list.map((p) => ({ id: p.id, name: p.name, active: p.id === activeId }))));
  return r.send(messages);
}

async function switchPersonaById(env: Env, r: Responder, id: number): Promise<unknown> {
  if (!Number.isInteger(id) || id <= 0) return r.text('找不到這個人設。');
  const p = await getPersona(env, id);
  if (!p || !p.isActive) return r.text('這個人設不存在或已經停用。打 /人設 重新選。');
  await setSetting(env, 'active_persona_id', p.id);
  return r.text(`已切換成「${p.name}」`);
}

async function switchPersonaByName(env: Env, r: Responder, query: string): Promise<unknown> {
  const q = query.trim().toLowerCase();
  const list = await listPersonas(env, true);
  const exact = list.find((p) => p.name.trim().toLowerCase() === q);
  const partial = exact ? [exact] : list.filter((p) => p.name.toLowerCase().includes(q));
  if (partial.length === 1) {
    await setSetting(env, 'active_persona_id', partial[0].id);
    return r.text(`已切換成「${partial[0].name}」`);
  }
  if (partial.length > 1) return showPersonaPicker(env, r, `有 ${partial.length} 個人設符合「${query.trim()}」，選一個：`);
  return showPersonaPicker(env, r, `沒有叫「${query.trim()}」的人設，從下面選：`);
}

// ---------- 指令 ----------

async function onCommand(env: Env, r: Responder, name: CommandName, args: string, raw: string): Promise<unknown> {
  switch (name) {
    case 'help': {
      const luna = new RegExp(`^\\s*[/／]${LUNA_ALIAS}`).test(raw);
      return r.text(luna ? `不用打 /${LUNA_ALIAS}，直接把 Threads 網址貼過來就好。\n\n${HELP_TEXT}` : HELP_TEXT);
    }
    case 'persona':
      return args ? switchPersonaByName(env, r, args) : showPersonaPicker(env, r);
    case 'patrol':
      return patrol(env, r, args);
    case 'today':
      return r.text(await buildTodaySummary(env));
    case 'keywords':
    case 'topics':
      return analysis(env, r, name);
    case 'quota':
      return quota(env, r);
    case 'pause':
      return pause(env, r, args);
    case 'resume':
      return doResume(env, r);
    case 'dashboard':
      return r.text(`後台：${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/`);
    default:
      return r.text('沒有這個指令。打 /說明 看全部指令。');
  }
}

async function patrol(env: Env, r: Responder, args: string): Promise<unknown> {
  const kw = cutChars(args.replace(/^[#＃]+/, '').replace(/\s+/g, ' ').trim(), 50);
  if (!kw) return r.text('用法：/海巡 關鍵字\n例如：/海巡 AI 工具');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO conversation_state (user_id, current_keyword, keyword_at, updated_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(user_id) DO UPDATE SET current_keyword = excluded.current_keyword, keyword_at = excluded.keyword_at, updated_at = excluded.updated_at`,
    ).bind(r.rctx.userId, kw, now),
    env.DB.prepare("INSERT INTO keyword_log (keyword, source, created_at) VALUES (?1, 'patrol_cmd', ?2)").bind(kw, now),
  ]);
  // UNVERIFIED：Threads 網頁版搜尋網址沒有官方文件，這個格式是觀察來的，要實機確認（00_建置計畫 3-4）
  const uri = `https://www.threads.com/search?q=${encodeURIComponent(kw)}&serp_type=default`;
  return r.send([
    linkCard({
      title: `記下關鍵字「${kw}」`,
      text: '接下來 6 小時內貼的網址，都會記在這個關鍵字底下。',
      tip: '看到想回的貼文，分享 → 複製連結，貼回這裡。',
      label: `到 Threads 搜「${cutChars(kw, 20)}」`,
      uri,
      altText: `關鍵字：${kw}`,
    }),
  ]);
}

async function analysis(env: Env, r: Responder, which: 'keywords' | 'topics'): Promise<unknown> {
  await new LineClient(env).startLoading(r.rctx.userId, 45);
  const settings = await getSettings(env);
  const blocked = await budgetBlock(env, settings, Date.now());
  if (blocked) return r.text(blocked);
  const text = which === 'keywords' ? await analyzeKeywords(env) : await analyzeTopics(env);
  return r.text(text);
}

function settled<T>(x: PromiseSettledResult<T>): T | null {
  return x.status === 'fulfilled' ? x.value : null;
}

async function quota(env: Env, r: Responder): Promise<unknown> {
  const now = Date.now();
  const client = new LineClient(env);
  // 各項分開查，一項壞掉不影響其他項
  const [qs, pushed, lineQ, cost, tok, st] = await Promise.allSettled([
    quotaStatus(env, now),
    monthPushCount(env, now),
    client.getQuota(),
    monthLlmCostUsd(env, now),
    tokenStatus(env),
    getSettings(env),
  ]);
  const s = settled(st);
  const lines: string[] = [];

  lines.push(settled(qs) ?? '今天的留言額度查不到。');
  lines.push('');

  const n = settled(pushed);
  const lq = settled(lineQ);
  let line = `LINE push 本月 ${n ?? '?'} 則`;
  if (lq && lq.used !== null) line += `（LINE 回報已用 ${lq.used}${lq.limit !== null ? `／上限 ${lq.limit}` : ''}）`;
  if (s && Math.max(n ?? 0, lq?.used ?? 0) >= s.push_warn_at) line += '，快用完了';
  lines.push(line);

  const c = settled(cost);
  if (c !== null) {
    let cl = `Claude 本月 US$${c.toFixed(2)}（約 NT$${Math.round(c * USD_TO_TWD).toLocaleString('zh-TW')}）`;
    if (s && s.monthly_budget_usd > 0) cl += `，預算 US$${s.monthly_budget_usd}`;
    lines.push(cl);
  } else {
    lines.push('Claude 花費查不到');
  }

  const t = settled(tok);
  if (!t) lines.push('Threads 授權狀態查不到');
  else if (!t.connected) lines.push('Threads 還沒連結，到後台連結');
  else if (t.daysLeft !== null && t.daysLeft <= 0) lines.push('Threads 授權過期了，到後台重新連結');
  else lines.push(`Threads 授權還有 ${t.daysLeft ?? '?'} 天${t.daysLeft !== null && t.daysLeft < 10 ? '，快到期了' : ''}`);

  return r.text(lines.join('\n'));
}

function toHalfWidth(s: string): string {
  return s.replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

async function pause(env: Env, r: Responder, args: string): Promise<unknown> {
  const usage = '用法：/暫停 24（單位是小時，不填就是 24）';
  let hours = 24;
  const a = toHalfWidth(args).trim();
  if (a) {
    const m = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?|小時|個小時)?$/i.exec(a);
    if (!m) return r.text(usage);
    hours = Number(m[1]);
  }
  if (!(hours > 0)) return r.text(usage);
  hours = Math.min(hours, 24 * 30);
  const { untilAt } = await pauseFor(env, hours, '手動暫停', 'manual');
  return r.text(`已暫停到 ${taipeiShort(untilAt)}。這段時間按「開 Threads 回覆」會被擋，草稿照樣能產。\n打 /恢復 可以提早解除。`);
}

async function doResume(env: Env, r: Responder): Promise<unknown> {
  const p = await activePause(env);
  if (!p) return r.text('目前沒有暫停。');
  await resumePause(env);
  // 恢復了不代表現在就開得了：夜間或間隔還沒到，要講清楚
  const now = Date.now();
  const s = await getSettings(env);
  if (inWindow(now, s.night_start, s.night_end)) {
    return r.text(`已恢復。現在是夜間，${whenText(windowEndAt(now, s.night_start, s.night_end), now)} 後才開得了 Threads。`);
  }
  if (s.next_allowed_at > now) return r.text(`已恢復。下一則 ${whenText(s.next_allowed_at, now)} 後可以開。`);
  return r.text('已恢復，可以開 Threads 回覆了。');
}
