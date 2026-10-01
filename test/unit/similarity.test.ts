import { describe, it, expect } from 'vitest';
import { normalizeForCompare, similarity, maxSimilarity, bigramProfile, profileSimilarity } from '../../src/safety/similarity';

describe('normalizeForCompare', () => {
  it('英文轉小寫、去空白與標點', () => {
    expect(normalizeForCompare('Hello, World!')).toBe('helloworld');
    expect(normalizeForCompare('  A  b\tC\n')).toBe('abc');
  });

  it('去掉中文全形標點與 emoji，保留中文字', () => {
    expect(normalizeForCompare('同意！這個流程，超實用。😀')).toBe('同意這個流程超實用');
    expect(normalizeForCompare('「真的」嗎？…… 🙏🏻')).toBe('真的嗎');
  });

  it('保留數字', () => {
    expect(normalizeForCompare('每週省 3 小時')).toBe('每週省3小時');
  });
});

describe('similarity（字元 bigram 的 Dice 係數）', () => {
  it('完全一樣 → 1', () => {
    expect(similarity('這個流程我也卡過', '這個流程我也卡過')).toBe(1);
  });

  it('只差標點、空白、大小寫、emoji → 1', () => {
    expect(similarity('這個流程超實用', '這個流程，超實用！😀')).toBe(1);
    expect(similarity('AI Tools', 'ai tools')).toBe(1);
  });

  it('完全不同 → 0', () => {
    expect(similarity('今天天氣很好', '報價單自動化')).toBe(0);
  });

  it('Dice 已知值：abcd vs abce = 2×2/(3+3)', () => {
    expect(similarity('abcd', 'abce')).toBeCloseTo(2 / 3, 5);
  });

  it('對稱，而且介於 0 到 1', () => {
    const pairs: [string, string][] = [
      ['這個流程我也卡過，最後是把步驟先寫成清單才順', '這個流程我也卡過'],
      ['想問一下你們是全自動嗎', '想問一下你們是半自動嗎'],
      ['a', 'ab'],
    ];
    for (const [a, b] of pairs) {
      const s1 = similarity(a, b);
      const s2 = similarity(b, a);
      expect(s1).toBeCloseTo(s2, 10);
      expect(s1).toBeGreaterThanOrEqual(0);
      expect(s1).toBeLessThanOrEqual(1);
    }
  });

  it('改幾個字的留言要夠像（≥ 0.5，hourly 比對用這個門檻）', () => {
    expect(similarity('這個流程我也卡過，最後是把步驟先寫成清單才順', '這個流程我也卡過，後來把步驟先寫成清單就順了')).toBeGreaterThanOrEqual(0.5);
  });

  it('太短或空字串不會出現 NaN', () => {
    for (const [a, b] of [['', ''], ['', '好'], ['好', '好'], ['好', '壞'], ['!!!', '???']] as [string, string][]) {
      const s = similarity(a, b);
      expect(Number.isNaN(s)).toBe(false);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(similarity('好', '壞')).toBe(0);
  });
});

describe('maxSimilarity', () => {
  it('取整個語料裡最像的那一個', () => {
    const corpus = ['今天天氣很好', '這個流程我也卡過', '報價單自動化'];
    expect(maxSimilarity('這個流程我也卡過！', corpus)).toBe(1);
    expect(maxSimilarity('完全無關的句子喔', corpus)).toBeLessThan(0.3);
  });

  it('空語料 → 0', () => {
    expect(maxSimilarity('任何文字', [])).toBe(0);
  });
});

describe('bigramProfile + profileSimilarity（每小時比對用的預先計算版）', () => {
  it('跟 similarity() 算出來一樣', () => {
    const pairs: [string, string][] = [
      ['這個流程我也卡過，最後是把步驟先寫成清單才順', '這個流程我也卡過，後來把步驟寫成清單就順了'],
      ['Hello World', 'hello, world!'],
      ['好', '好'],
      ['好', '壞'],
      ['想問一下你們是全自動嗎', '笑死我的自動化最後都變手動'],
      ['每週省 3 小時 😀', '每週省3小時'],
    ];
    for (const [a, b] of pairs) {
      expect(profileSimilarity(bigramProfile(a), bigramProfile(b))).toBeCloseTo(similarity(a, b), 10);
    }
  });

  it('正規化後是空字串 → 0', () => {
    expect(profileSimilarity(bigramProfile('😀'), bigramProfile('同意'))).toBe(0);
    expect(profileSimilarity(bigramProfile(''), bigramProfile(''))).toBe(0);
  });
});
