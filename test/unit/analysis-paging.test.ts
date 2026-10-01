import { describe, it, expect } from 'vitest';
import { computeTopicStats } from '../../src/llm/analysis';
import { afterCursor } from '../../src/threads/client';

describe('computeTopicStats「表現好但寫太少」', () => {
  const posts = (views: number[]) => views.map((v, i) => ({ mediaId: `m${i + 1}`, views: v }));

  it('每個主題篇數一樣多時，沒有誰算寫太少（審查重現：4 個主題各 3 篇）', () => {
    const p = posts([100, 100, 100, 50, 50, 50, 10, 10, 10, 5, 5, 5]);
    const stats = computeTopicStats(
      [
        { name: 'A', post_indexes: [1, 2, 3] },
        { name: 'B', post_indexes: [4, 5, 6] },
        { name: 'C', post_indexes: [7, 8, 9] },
        { name: 'D', post_indexes: [10, 11, 12] },
      ],
      p,
    );
    expect(stats.filter((s) => s.underWritten)).toHaveLength(0);
  });

  it('篇數少、平均觀看高的會被標出來；寫最多的不會', () => {
    // 平均觀看：少但好 850（2 篇）、寫很多 100（4 篇，觀看也高但寫最多）、普通 20、偏低 15（各 3 篇）
    const p = posts([900, 800, 100, 100, 100, 100, 20, 20, 20, 15, 15, 15]);
    const stats = computeTopicStats(
      [
        { name: '少但好', post_indexes: [1, 2] },
        { name: '寫很多', post_indexes: [3, 4, 5, 6] },
        { name: '普通', post_indexes: [7, 8, 9] },
        { name: '偏低', post_indexes: [10, 11, 12] },
      ],
      p,
    );
    const flagged = stats.filter((s) => s.underWritten).map((s) => s.name);
    expect(flagged).toEqual(['少但好']);
  });
});

describe('afterCursor（Threads 分頁）', () => {
  it('有 next → 繼續翻', () => {
    expect(afterCursor({ paging: { next: 'https://x', cursors: { after: 'AA' } } }, 3, 50)).toBe('AA');
  });
  it('沒有 next、但這頁是滿的 → 也繼續翻（官方範例常沒有 next）', () => {
    expect(afterCursor({ paging: { cursors: { after: 'BB' } } }, 50, 50)).toBe('BB');
  });
  it('沒有 next、這頁不滿 → 停', () => {
    expect(afterCursor({ paging: { cursors: { after: 'CC' } } }, 12, 50)).toBeUndefined();
  });
  it('沒有 cursor → 停', () => {
    expect(afterCursor({ paging: { next: 'https://x' } }, 50, 50)).toBeUndefined();
    expect(afterCursor({}, 50, 50)).toBeUndefined();
  });
});
