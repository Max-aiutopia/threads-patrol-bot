import { describe, it, expect } from 'vitest';
import { MODEL_PRICES, costUsd, USD_TO_TWD } from '../../src/llm/pricing';
import { ALLOWED_MODELS } from '../../src/lib/settings';

describe('MODEL_PRICES（每百萬 token 美金）', () => {
  it('三個模型的價格照 SPEC', () => {
    expect(MODEL_PRICES['claude-opus-5']).toEqual({ in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(MODEL_PRICES['claude-sonnet-5']).toEqual({ in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 });
    expect(MODEL_PRICES['claude-haiku-4-5']).toEqual({ in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 });
  });

  it('後台可選的模型都有價格', () => {
    for (const m of ALLOWED_MODELS) expect(MODEL_PRICES[m]).toBeDefined();
  });
});

describe('costUsd', () => {
  // 後台顯示的「每次約多少」用 1,950 in / 1,040 out 估
  it('一次產生留言的成本（1,950 in / 1,040 out）', () => {
    expect(costUsd('claude-opus-5', { inputTokens: 1950, outputTokens: 1040 })).toBeCloseTo(0.03575, 8);
    expect(costUsd('claude-sonnet-5', { inputTokens: 1950, outputTokens: 1040 })).toBeCloseTo(0.0143, 8);
    expect(costUsd('claude-haiku-4-5', { inputTokens: 1950, outputTokens: 1040 })).toBeCloseTo(0.00715, 8);
  });

  it('快取讀寫分開計價', () => {
    expect(costUsd('claude-opus-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.5, 8);
    expect(costUsd('claude-opus-5', { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBeCloseTo(6.25, 8);
    expect(
      costUsd('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
    ).toBeCloseTo(2 + 10 + 0.2 + 2.5, 8);
  });

  it('沒給快取欄位當 0', () => {
    expect(costUsd('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('不認得的模型不丟錯，回傳有限、非負的數字', () => {
    const c = costUsd('claude-unknown-9', { inputTokens: 1000, outputTokens: 1000 });
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(0);
  });
});

describe('USD_TO_TWD', () => {
  it('匯率 31.74', () => {
    expect(USD_TO_TWD).toBe(31.74);
  });
});
