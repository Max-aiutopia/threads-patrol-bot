import { describe, it, expect } from 'vitest';
import { buildDraftCarousel, textMessage, defaultQuickReplies, personaPicker, type DraftCardInput } from '../../src/line/flex';

type Obj = Record<string, unknown>;

function walk(node: unknown, visit: (o: Obj) => void): void {
  if (Array.isArray(node)) node.forEach((x) => walk(x, visit));
  else if (node && typeof node === 'object') {
    visit(node as Obj);
    Object.values(node as Obj).forEach((v) => walk(v, visit));
  }
}

function actions(node: unknown): Obj[] {
  const out: Obj[] = [];
  walk(node, (o) => {
    if (typeof o.type === 'string' && ['uri', 'postback', 'clipboard', 'message'].includes(o.type) && ('uri' in o || 'data' in o || 'clipboardText' in o || 'text' in o) && 'label' in o) {
      out.push(o);
    }
  });
  return out;
}

function bubbles(msg: Obj): Obj[] {
  const contents = msg.contents as Obj;
  expect(contents.type).toBe('carousel');
  return contents.contents as Obj[];
}

const BASE = 'https://threads-patrol-bot.example.workers.dev';

function drafts(n: number, textFor: (i: number) => string = (i) => `第 ${i + 1} 則草稿：這個流程我也卡過，最後是把步驟寫成清單才順`): DraftCardInput[] {
  return Array.from({ length: n }, (_, i) => ({
    draftId: `D${String(i).padStart(15, '0')}`,
    idx: i + 1,
    text: textFor(i),
    mentionsProduct: i === 2,
  }));
}

function build(over: Partial<Parameters<typeof buildDraftCarousel>[0]> = {}) {
  return buildDraftCarousel({
    batchId: 'Bx7Kp2Qa9Zc1',
    drafts: drafts(5),
    personaName: '實戰派顧問',
    targetAuthor: 'alice',
    baseUrl: BASE,
    clipboard: true,
    openExternal: false,
    keyword: 'AI 工具',
    ...over,
  }) as Obj;
}

describe('buildDraftCarousel', () => {
  it('是 flex carousel：5 則草稿 + 1 個控制卡 = 6 個 bubble', () => {
    const msg = build();
    expect(msg.type).toBe('flex');
    const bs = bubbles(msg);
    expect(bs).toHaveLength(6);
    for (const b of bs) expect(b.type).toBe('bubble');
  });

  it('altText 有內容、≤ 400 字、提到作者', () => {
    const msg = build();
    expect(typeof msg.altText).toBe('string');
    expect((msg.altText as string).length).toBeGreaterThan(0);
    expect((msg.altText as string).length).toBeLessThanOrEqual(400);
    expect(msg.altText as string).toContain('alice');
  });

  it('沒有作者時 altText 仍然合法', () => {
    const msg = build({ targetAuthor: null });
    expect((msg.altText as string).length).toBeGreaterThan(0);
    expect((msg.altText as string).length).toBeLessThanOrEqual(400);
    expect(msg.altText as string).not.toContain('null');
  });

  it('每則草稿卡有「開 Threads 回覆」→ /go/<draftId>，順序跟輸入一樣', () => {
    const ds = drafts(5);
    const msg = build({ drafts: ds });
    const goActions = actions(msg).filter((a) => a.type === 'uri' && String(a.uri).includes('/go/'));
    expect(goActions.map((a) => a.uri)).toEqual(ds.map((d) => `${BASE}/go/${d.draftId}`));
    for (const a of goActions) expect(a.label).toBe('開 Threads 回覆');
  });

  it('openExternal=true 時加 ?openExternalBrowser=1', () => {
    const ds = drafts(5);
    const msg = build({ drafts: ds, openExternal: true });
    const goLinks = actions(msg).filter((a) => a.type === 'uri' && String(a.uri).includes('/go/')).map((a) => a.uri);
    expect(goLinks).toEqual(ds.map((d) => `${BASE}/go/${d.draftId}?openExternalBrowser=1`));
  });

  it('clipboard=true 時每則都有「複製」，內容就是留言本身', () => {
    const ds = drafts(5);
    const msg = build({ drafts: ds, clipboard: true });
    const clips = actions(msg).filter((a) => a.type === 'clipboard');
    expect(clips).toHaveLength(5);
    expect(clips.map((c) => c.clipboardText)).toEqual(ds.map((d) => d.text));
    for (const c of clips) expect(c.label).toBe('複製');
  });

  it('clipboard=false 時完全沒有 clipboard action（電腦版 LINE 不支援）', () => {
    const msg = build({ clipboard: false });
    expect(actions(msg).filter((a) => a.type === 'clipboard')).toHaveLength(0);
  });

  it('草稿卡：標題有「第 N 則」與人設名稱，留言文字 wrap: true', () => {
    const ds = drafts(5);
    const msg = build({ drafts: ds });
    const draftBubbles = bubbles(msg).filter((b) => JSON.stringify(b).includes('/go/'));
    expect(draftBubbles).toHaveLength(5);
    draftBubbles.forEach((b, i) => {
      const s = JSON.stringify(b);
      expect(s).toContain(`第 ${i + 1} 則`);
      expect(s).toContain('實戰派顧問');
      const texts: Obj[] = [];
      walk(b, (o) => {
        if (o.type === 'text' && o.text === ds[i].text) texts.push(o);
      });
      expect(texts.length).toBeGreaterThan(0);
      expect(texts[0].wrap).toBe(true);
    });
  });

  it('「提到產品」標籤只出現在 mentionsProduct 的那張', () => {
    const msg = build();
    const draftBubbles = bubbles(msg).filter((b) => JSON.stringify(b).includes('/go/'));
    const flags = draftBubbles.map((b) => JSON.stringify(b).includes('提到產品'));
    expect(flags).toEqual([false, false, true, false, false]);
  });

  it('控制卡：換一批／再短一點／再俏皮一點／換人設，postback data 格式正確且有 displayText', () => {
    const msg = build({ batchId: 'Bx7Kp2Qa9Zc1' });
    const pbs = actions(msg).filter((a) => a.type === 'postback');
    const datas = pbs.map((p) => p.data);
    expect(datas).toEqual(
      expect.arrayContaining([
        'action=regen&batch=Bx7Kp2Qa9Zc1',
        'action=shorter&batch=Bx7Kp2Qa9Zc1',
        'action=playful&batch=Bx7Kp2Qa9Zc1',
        'action=personas',
      ]),
    );
    const labels = pbs.map((p) => p.label);
    expect(labels).toEqual(expect.arrayContaining(['換一批', '再短一點', '再俏皮一點', '換人設']));
    for (const p of pbs) {
      expect(typeof p.displayText).toBe('string');
      expect((p.displayText as string).length).toBeGreaterThan(0);
      expect((p.displayText as string).length).toBeLessThanOrEqual(300);
    }
  });

  it('LINE 限制：uri ≤ 1000、postback data ≤ 300、clipboardText ≤ 1000、整包 JSON < 50 KB（5 則 150 字）', () => {
    const msg = build({ drafts: drafts(5, (i) => '留'.repeat(149) + i), personaName: '一個很長很長很長的人設名稱二十個字啊啊' });
    for (const a of actions(msg)) {
      if (a.type === 'uri') expect((a.uri as string).length).toBeLessThanOrEqual(1000);
      if (a.type === 'postback') expect((a.data as string).length).toBeLessThanOrEqual(300);
      if (a.type === 'clipboard') expect((a.clipboardText as string).length).toBeLessThanOrEqual(1000);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(msg)).length;
    expect(bytes).toBeLessThan(50 * 1024);
  });

  it('草稿超過 1000 字時，複製內容截到 1000 字以內（LINE 上限）', () => {
    const msg = build({ drafts: drafts(5, () => '長'.repeat(1200)) });
    for (const c of actions(msg).filter((a) => a.type === 'clipboard')) {
      expect((c.clipboardText as string).length).toBeLessThanOrEqual(1000);
    }
  });

  it('草稿再多也不超過 LINE 的 12 個 bubble', () => {
    const msg = build({ drafts: drafts(20) });
    expect(bubbles(msg).length).toBeLessThanOrEqual(12);
  });
});

describe('textMessage / defaultQuickReplies', () => {
  it('純文字訊息', () => {
    expect(textMessage('你好')).toMatchObject({ type: 'text', text: '你好' });
    expect((textMessage('你好') as Obj).quickReply).toBeUndefined();
  });

  it('帶 quick reply', () => {
    const qr = defaultQuickReplies();
    const m = textMessage('你好', qr) as Obj;
    expect(m.type).toBe('text');
    expect((m.quickReply as Obj).items).toEqual(qr);
  });

  it('預設 quick reply：人設／今日／額度／說明，都是 message action，送出對應指令', () => {
    const qr = defaultQuickReplies();
    expect(qr.length).toBeGreaterThanOrEqual(4);
    expect(qr.length).toBeLessThanOrEqual(13);
    for (const item of qr) {
      expect(item.type).toBe('action');
      expect(item.action.type).toBe('message');
      expect(String(item.action.label).length).toBeLessThanOrEqual(20);
    }
    const texts = qr.map((i) => String(i.action.text));
    for (const c of ['/人設', '/今日', '/額度', '/說明']) expect(texts).toContain(c);
  });
});

describe('personaPicker', () => {
  it('每個人設一顆 postback：action=persona&id=N', () => {
    const personas = [
      { id: 1, name: '實戰派顧問', active: true },
      { id: 2, name: '吐槽好朋友', active: false },
      { id: 3, name: '溫和陪跑', active: false },
      { id: 4, name: '好奇發問', active: false },
    ];
    const msg = personaPicker(personas) as Obj;
    expect(typeof msg.type).toBe('string');
    const datas = actions(msg).filter((a) => a.type === 'postback').map((a) => a.data as string);
    for (const p of personas) expect(datas).toContain(`action=persona&id=${p.id}`);
    for (const d of datas) expect(d.length).toBeLessThanOrEqual(300);
    const s = JSON.stringify(msg);
    for (const p of personas) expect(s).toContain(p.name);
    if (msg.altText !== undefined) expect(String(msg.altText).length).toBeLessThanOrEqual(400);
  });
});
