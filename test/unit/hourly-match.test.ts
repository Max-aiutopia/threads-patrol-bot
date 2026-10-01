import { describe, it, expect } from 'vitest';
import { matchRepliesToDrafts, OPEN_CLOCK_SKEW_MS, type MatchCandidate, type MatchReply } from '../../src/jobs/hourly';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 28, 4, 0, 0);
const DRAFT = '這個流程我也卡過，最後是把步驟先寫成清單才順';

const cand = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({ id: 'D1', text: DRAFT, target_id: 1, opened_at: T0, ...over });
const reply = (over: Partial<MatchReply> = {}): MatchReply => ({ id: 'R1', text: DRAFT, permalink: null, at: T0 + 2 * MIN, ...over });

describe('matchRepliesToDrafts', () => {
  it('開草稿之後送出的回覆 → 比對到', () => {
    const m = matchRepliesToDrafts([reply()], [cand()]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ mediaId: 'R1', draftId: 'D1', targetId: 1, postedAt: T0 + 2 * MIN });
    expect(m[0].sim).toBe(1);
  });

  it('草稿打開「之前」就發的回覆，文字一樣也不算（審查重現：早 117 分鐘）', () => {
    expect(matchRepliesToDrafts([reply({ at: T0 - 117 * MIN })], [cand()])).toHaveLength(0);
  });

  it('留 5 分鐘時鐘誤差', () => {
    expect(matchRepliesToDrafts([reply({ at: T0 - OPEN_CLOCK_SKEW_MS + 1000 })], [cand()])).toHaveLength(1);
    expect(matchRepliesToDrafts([reply({ at: T0 - OPEN_CLOCK_SKEW_MS - 1000 })], [cand()])).toHaveLength(0);
  });

  it('早的回覆不會搶走草稿，晚的那則才配得到', () => {
    const m = matchRepliesToDrafts([reply({ id: 'OLD', at: T0 - 60 * MIN }), reply({ id: 'NEW', at: T0 + 5 * MIN })], [cand()]);
    expect(m.map((x) => x.mediaId)).toEqual(['NEW']);
  });

  it('每則草稿最多配一則回覆；相似度不到 0.5 不算', () => {
    const m = matchRepliesToDrafts(
      [reply({ id: 'A' }), reply({ id: 'B', at: T0 + 3 * MIN }), reply({ id: 'C', text: '跟草稿完全無關的一般回覆，謝謝大家今天來參加' })],
      [cand()],
    );
    expect(m.map((x) => x.mediaId)).toEqual(['A']);
  });
});
