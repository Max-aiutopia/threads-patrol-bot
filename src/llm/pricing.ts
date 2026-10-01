// Claude 單價（USD / 百萬 token）。來源：platform.claude.com 定價頁，2026-09 查。
// cacheRead = 輸入單價 × 0.1；cacheWrite = 5 分鐘快取寫入，輸入單價 × 1.25。

type Price = { in: number; out: number; cacheRead: number; cacheWrite: number };

// 後台可選的三個模型（後台的模型選單直接讀這張表）
export const MODEL_PRICES: Record<string, Price> = {
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

// 不在選單上、但可能出現在回應裡的模型：Opus 5 被拒時，伺服器端 fallback 會改用別的模型回答
// （cyber 類別會轉給 Opus 4.8），計價要照實際回答的模型算。
const EXTRA_PRICES: Record<string, Price> = {
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

export const USD_TO_TWD = 31.74;

// 找單價：先比完整名稱，再比前綴（API 回傳的 model 可能帶日期，例 claude-haiku-4-5-20251001）。
// 認不得的模型用 Opus 5 的單價估，寧可高估，預算上限才擋得住。
export function priceFor(model: string): Price {
  const all = { ...MODEL_PRICES, ...EXTRA_PRICES };
  if (all[model]) return all[model];
  const key = Object.keys(all)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? all[key] : MODEL_PRICES['claude-opus-5'];
}

export function costUsd(
  model: string,
  u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): number {
  const p = priceFor(model);
  const n = (x: number | undefined) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  const usd =
    (n(u.inputTokens) * p.in +
      n(u.outputTokens) * p.out +
      n(u.cacheReadTokens) * p.cacheRead +
      n(u.cacheWriteTokens) * p.cacheWrite) /
    1_000_000;
  // 存進 DB 前先去掉浮點尾巴，留到 0.000001 美元
  return Math.round(usd * 1e6) / 1e6;
}

// 換成新台幣，留兩位小數（顯示時再自己決定要不要四捨五入）
export function usdToTwd(usd: number): number {
  return Math.round(usd * USD_TO_TWD * 100) / 100;
}
