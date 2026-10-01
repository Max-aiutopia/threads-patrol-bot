// 呼叫 Claude，要求照 JSON Schema 輸出。每次呼叫都記到 llm_usage（含被拒絕的那次）。
//
// 各模型的參數規則（送錯會直接 400，改之前先查官方文件）：
// - claude-opus-5：走 beta endpoint，開伺服器端 fallback（被安全分類器拒絕時改由別的模型接手）。
//   effort 放在 output_config 裡。不能送 temperature/top_p/top_k、thinking.budget_tokens。不送 thinking＝自適應。
// - claude-sonnet-5：一般 endpoint，effort 放在 output_config。不能送取樣參數、budget_tokens、fallbacks。
// - claude-haiku-4-5：一般 endpoint，不能送 effort。
// - 所有模型都不能用 assistant prefill。
import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../env';
import type { LlmUsage } from '../types';
import { ALLOWED_MODELS, DEFAULT_SETTINGS, getSettings, logJob, type Settings } from '../lib/settings';
import { monthLlmCostUsd } from '../lib/repo';
import { costUsd } from './pricing';

export type LlmPurpose = 'comments' | 'keywords' | 'topics';

export type ClaudeJsonResult<T> =
  | { ok: true; data: T; usage: LlmUsage }
  | { ok: false; reason: 'refusal' | 'invalid_output' | 'api_error'; message: string; usage?: LlmUsage };

// 各模型統一後的回應（beta 與一般 endpoint 回傳型別不同，這裡只取用得到的欄位）
interface NormalizedResponse {
  model: string;
  stopReason: string | null;
  refusalCategory: string | null;
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  extraCostUsd: number; // fallback 前被拒、但已產生部分輸出的那一段
}

const OPUS_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// 逾時設長、SDK 不自動重試：SDK 碰到逾時也會整包重送（連截圖一起），慢的生成只會更慢、更貴。
// 這支在 Queue consumer 裡跑（牆鐘上限 15 分鐘，等回應不算 CPU），超過 50 秒本來就改用 push 回覆。
// 只有「一定沒被處理」的暫時性錯誤（429、5xx、529、連線中斷）才自己重試一次；逾時不重試。
const TIMEOUT_MS = 120_000;
const RETRY_DELAY_MS = 1_500;
const RETRY_DELAY_MAX_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return false;
  if (err instanceof Anthropic.APIUserAbortError) return false;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) {
    const st = err.status;
    return typeof st === 'number' && (st === 429 || st >= 500);
  }
  return false;
}

function retryDelayMs(err: unknown): number {
  const h = err instanceof Anthropic.APIError ? err.headers : undefined;
  const ra = Number(h?.get?.('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.min(RETRY_DELAY_MAX_MS, ra * 1000);
  return RETRY_DELAY_MS;
}

function errDetail(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return `逾時（${TIMEOUT_MS / 1000} 秒）`;
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') return `HTTP ${err.status} ${err.message}`;
  return String(err);
}

// 給人看的短句（LINE 會直接顯示），細節另外寫 job_log
function apiErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'Claude 太久沒回應';
  if (err instanceof Anthropic.APIConnectionError) return '連不上 Claude';
  if (err instanceof Anthropic.APIError) {
    const st = err.status;
    if (st === 401 || st === 403) return `Claude 金鑰或權限有問題（${st}）`;
    if (st === 429) return 'Claude 現在太忙（429）';
    if (typeof st === 'number' && st >= 500) return `Claude 暫時沒回應（${st}）`;
    return `Claude 退回這次的請求（${st ?? '沒有狀態碼'}）`;
  }
  return '呼叫 Claude 失敗';
}

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
}

function textOf(content: ReadonlyArray<{ type: string }>): string {
  let out = '';
  for (const b of content) {
    if (b.type === 'text') out += (b as { text?: string }).text ?? '';
  }
  return out;
}

// 伺服器端 fallback 的計費：頂層 usage 只算「最後回答的那次」。前面被拒的那次如果還沒產生輸出就被拒，
// 官方不收費；如果已經產生一部分才被拒，那一段照原模型計費。這裡把後者補算進來。
function declinedPartialCost(iterations: unknown, requestedModel: string): number {
  if (!Array.isArray(iterations)) return 0;
  const servedByFallback = iterations.some((it) => (it as { type?: string })?.type === 'fallback_message');
  if (!servedByFallback) return 0;
  let usd = 0;
  for (const it of iterations as Array<Record<string, unknown>>) {
    if (it?.type !== 'message' || num(it.output_tokens) === 0) continue;
    usd += costUsd(typeof it.model === 'string' ? it.model : requestedModel, {
      inputTokens: num(it.input_tokens),
      outputTokens: num(it.output_tokens),
      cacheReadTokens: num(it.cache_read_input_tokens),
      cacheWriteTokens: num(it.cache_creation_input_tokens),
    });
  }
  return usd;
}

function normalize(
  r: {
    model?: string | null;
    stop_reason?: string | null;
    stop_details?: { category?: string | null } | null;
    content: ReadonlyArray<{ type: string }>;
    usage?: Record<string, unknown> | null;
  },
  requestedModel: string,
): NormalizedResponse {
  const u = (r.usage ?? {}) as Record<string, unknown>;
  return {
    model: typeof r.model === 'string' && r.model ? r.model : requestedModel,
    stopReason: r.stop_reason ?? null,
    refusalCategory: r.stop_details?.category ?? null,
    text: textOf(r.content ?? []),
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    extraCostUsd: declinedPartialCost(u.iterations, requestedModel),
  };
}

function toUsage(n: NormalizedResponse): LlmUsage {
  // 分類器在產生任何輸出前就拒絕 → 官方不收費
  const unbilledRefusal = n.stopReason === 'refusal' && n.outputTokens === 0;
  const cost = unbilledRefusal
    ? 0
    : costUsd(n.model, {
        inputTokens: n.inputTokens,
        outputTokens: n.outputTokens,
        cacheReadTokens: n.cacheReadTokens,
        cacheWriteTokens: n.cacheWriteTokens,
      }) + n.extraCostUsd;
  return {
    model: n.model,
    inputTokens: n.inputTokens,
    outputTokens: n.outputTokens,
    cacheReadTokens: n.cacheReadTokens,
    cacheWriteTokens: n.cacheWriteTokens,
    costUsd: Math.round(cost * 1e6) / 1e6,
    stopReason: n.stopReason,
  };
}

async function recordUsage(env: Env, purpose: LlmPurpose, u: LlmUsage): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO llm_usage (purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, stop_reason, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(purpose, u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.costUsd, u.stopReason, Date.now())
      .run();
  } catch (err) {
    console.error('llm_usage insert failed', String(err));
  }
}

// 結構化輸出理論上一定是合法 JSON；保險起見，前後有雜字時取第一個 { 到最後一個 }
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('not json');
  }
}

export function resolveModel(s: Settings): string {
  return (ALLOWED_MODELS as readonly string[]).includes(s.llm_model) ? s.llm_model : DEFAULT_SETTINGS.llm_model;
}

// 本月花費是否已到上限。沒設上限（0）→ null
export async function overBudget(env: Env, s: Settings): Promise<{ spentUsd: number; budgetUsd: number } | null> {
  if (!(s.monthly_budget_usd > 0)) return null;
  const spent = await monthLlmCostUsd(env);
  return spent >= s.monthly_budget_usd ? { spentUsd: spent, budgetUsd: s.monthly_budget_usd } : null;
}

export async function callClaudeJson<T>(
  env: Env,
  p: {
    purpose: LlmPurpose;
    system: string;
    content: Anthropic.MessageParam['content']; // user turn（文字＋可選的圖片）
    schema: Record<string, unknown>; // output_config.format 用的 JSON Schema
    maxTokens?: number; // 預設 4000
    effort?: Settings['llm_effort']; // 不給就用後台設定；Haiku 4.5 一律不送
    settings?: Settings; // 呼叫端已經讀過設定就傳進來，省一次 DB 查詢
  },
): Promise<ClaudeJsonResult<T>> {
  const settings = p.settings ?? (await getSettings(env));
  const model = resolveModel(settings);
  const effort = p.effort ?? settings.llm_effort;
  const maxTokens = p.maxTokens ?? 4000;
  const format = { type: 'json_schema' as const, schema: p.schema };
  // system 固定不變的部分放前面並標快取；太短不到門檻時 API 會自動略過，不會多收錢
  const system = [{ type: 'text' as const, text: p.system, cache_control: { type: 'ephemeral' as const } }];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: p.content }];

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.CLAUDE_API_BASE,
    maxRetries: 0,
    timeout: TIMEOUT_MS,
  });

  const send = async (): Promise<NormalizedResponse> => {
    if (model === 'claude-opus-5') {
      const r = await client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: messages as Anthropic.Beta.BetaMessageParam[],
        betas: [OPUS_FALLBACK_BETA],
        fallbacks: 'default',
        output_config: { effort, format },
      });
      return normalize(r as unknown as Parameters<typeof normalize>[0], model);
    }
    if (model === 'claude-haiku-4-5') {
      const r = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages,
        output_config: { format },
      });
      return normalize(r as unknown as Parameters<typeof normalize>[0], model);
    }
    const r = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages,
      output_config: { effort, format },
    });
    return normalize(r as unknown as Parameters<typeof normalize>[0], model);
  };

  let n: NormalizedResponse;
  try {
    try {
      n = await send();
    } catch (first) {
      if (!isRetryable(first)) throw first;
      await logJob(env, `llm:${p.purpose}`, false, `${model} 暫時性錯誤，重試一次：${errDetail(first)}`.slice(0, 500));
      await sleep(retryDelayMs(first));
      n = await send();
    }
  } catch (err) {
    // SDK 的錯誤訊息只含 API 回應內容，不含金鑰
    await logJob(env, `llm:${p.purpose}`, false, `${model} ${errDetail(err)}`.slice(0, 500));
    return { ok: false, reason: 'api_error', message: apiErrorMessage(err) };
  }

  const usage = toUsage(n);
  await recordUsage(env, p.purpose, usage);

  if (n.stopReason === 'refusal') {
    return { ok: false, reason: 'refusal', message: `Claude 拒絕處理（${n.refusalCategory ?? '未分類'}）`, usage };
  }
  if (n.stopReason === 'max_tokens' || n.stopReason === 'model_context_window_exceeded') {
    await logJob(env, `llm:${p.purpose}`, false, `${n.model} 回覆太長被截斷（stop_reason=${n.stopReason}）`);
    return { ok: false, reason: 'invalid_output', message: '回覆太長被截斷', usage };
  }
  if (!n.text.trim()) {
    await logJob(env, `llm:${p.purpose}`, false, `${n.model} 沒有回內容（stop_reason=${n.stopReason}）`);
    return { ok: false, reason: 'invalid_output', message: 'Claude 沒有回內容', usage };
  }
  try {
    return { ok: true, data: parseJsonLoose(n.text) as T, usage };
  } catch {
    await logJob(env, `llm:${p.purpose}`, false, `${n.model} 回的不是合法 JSON`);
    return { ok: false, reason: 'invalid_output', message: 'Claude 回的格式不對', usage };
  }
}
