import { describe, it, expect } from 'vitest';
import { cleanCommentText, describeDrops, postProcessComments, type DropCounts } from '../../src/llm/comments';
import { buildCommentSystemPrompt } from '../../src/llm/prompts';
import type { Persona, ProductCard } from '../../src/types';

const base = { bannedWords: [], avoidTexts: [], similarityBlock: 0.8, hasProduct: false };
const item = (text: string, mentions_product = false) => ({ text, mentions_product });

describe('postProcessComments', () => {
  it('含網址、網域、@帳號的草稿整則丟掉（不只刪掉那一段）', () => {
    const drops: DropCounts = {};
    const out = postProcessComments(
      [
        item('加我 LINE lin.ee/AbC123 聊'),
        item('懶人包在 pse.is/6abcd'),
        item('官網 ｍａｘｓｔｕｄｉｏ．ｂｉｚ'),
        item('maxstudio。biz 有寫'),
        item('@someone 你怎麼看'),
        item('這個流程我也卡過，最後是把步驟先寫成清單才順'),
      ],
      { ...base, drops },
    );
    expect(out.map((o) => o.text)).toEqual(['這個流程我也卡過，最後是把步驟先寫成清單才順']);
    expect(drops.link).toBe(4);
    expect(drops.mention).toBe(1);
  });

  it('簡體字的草稿丟掉', () => {
    const drops: DropCounts = {};
    const out = postProcessComments([item('这个流程我们也做过，真的有用'), item('這個流程我們也做過，真的有用')], { ...base, drops });
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('這個');
    expect(drops.simplified).toBe(1);
  });

  it('「再短一點」超過 45 字的丟掉', () => {
    const long = '這個流程我也卡過，最後是把步驟先寫成清單才順，然後每週固定回頭看一次數據，再決定下一輪要改哪一段規格';
    expect(Array.from(long).length).toBeGreaterThan(45);
    const drops: DropCounts = {};
    const out = postProcessComments([item(long), item('先寫成清單才順')], { ...base, variant: 'shorter', drops });
    expect(out.map((o) => o.text)).toEqual(['先寫成清單才順']);
    expect(drops.too_long).toBe(1);
    // 一般變體不擋這個長度
    expect(postProcessComments([item(long)], base)).toHaveLength(1);
  });

  it('彼此重複、跟舊留言太像分開記原因', () => {
    const drops: DropCounts = {};
    postProcessComments(
      [item('同意，工具其實不是重點，重點是有沒有人願意維護它'), item('同意，工具其實不是重點，重點是有沒有人願意維護它！'), item('我之前送出過的一模一樣的留言內容')],
      { ...base, avoidTexts: ['我之前送出過的一模一樣的留言內容'], drops },
    );
    expect(drops.duplicate).toBe(1);
    expect(drops.similar_old).toBe(1);
    expect(describeDrops(drops)).toBe('1 則跟你送出過的留言太像、1 則彼此重複');
  });

  it('清理時保留全形標點（判斷網址用的半形轉換不會改到留言本身）', () => {
    expect(cleanCommentText('真的！每週三小時，不是小數字？')).toBe('真的！每週三小時，不是小數字？');
  });
});

describe('buildCommentSystemPrompt', () => {
  const persona = (identityNote: string | null): Persona => ({
    id: 2, name: '吐槽好朋友', tone: '輕鬆接梗', identityNote, bannedWords: [], examples: [], isActive: true, sortOrder: 2,
  });
  const product: ProductCard = { id: 1, title: 'Max 的服務', facts: ['自己維運 28 個 Skill'], ctaHint: null };

  it('明講要用繁體中文', () => {
    expect(buildCommentSystemPrompt(persona(null), null)).toContain('一律用繁體中文、台灣用語');
  });

  it('沒寫身分的人設 + 產品卡：不再說「不要設定任何經歷」卻又給產品事實', () => {
    const sys = buildCommentSystemPrompt(persona(null), product);
    expect(sys).toContain('除了產品資料卡上寫到的事');
    expect(sys).not.toContain('沒有提供身分。不要替他設定任何職業');
  });

  it('沒有產品卡時維持原本的說法', () => {
    expect(buildCommentSystemPrompt(persona(null), null)).toContain('沒有提供身分。不要替他設定任何職業');
  });
});
