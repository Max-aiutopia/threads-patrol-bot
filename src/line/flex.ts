// LINE 訊息物件產生器（純函式，可單元測試）。
// 官方上限（https://developers.line.biz/en/reference/messaging-api/）：
// - carousel 最多 12 個 bubble、JSON 50 KB；同一個 carousel 的 bubble size 要一樣
// - URI action 的 uri ≤ 1000 字；postback data ≤ 300、displayText ≤ 300
// - Flex 按鈕 label ≤ 40；quick reply 最多 13 顆、label ≤ 20
// - clipboard action 的 clipboardText ≤ 1000（只有 iOS/Android LINE 14.0.0+ 有作用）
// - Flex altText 官方上限 1500，我們自己限 400
// - 文字訊息 ≤ 5000（UTF-16 單位）
import type { LineMessage } from '../types';

export interface DraftCardInput { draftId: string; idx: number; text: string; mentionsProduct: boolean }
export type QuickReplyItem = { type: 'action'; action: Record<string, unknown> };

const LIMIT = {
  bubbles: 12,
  uri: 1000,
  postbackData: 300,
  displayText: 300,
  buttonLabel: 40,
  clipboard: 1000,
  altText: 400,
  text: 5000,
  carouselBytes: 48_000, // 官方 50 KB，留一點緩衝
};

const INK = '#111111';
const MUTED = '#6B6B6B';
const ACCENT = '#B4441F';

type Json = Record<string, unknown>;

// 依 UTF-16 長度截斷，不切斷 emoji 這類代理對
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function nonEmpty(s: string | null | undefined, fallback: string): string {
  const v = (s ?? '').trim();
  return v ? v : fallback;
}

function atAuthor(author: string | null): string | null {
  const a = (author ?? '').trim().replace(/^@+/, '');
  return a ? `@${a}` : null;
}

function postbackButton(label: string, data: string, displayText: string): Json | null {
  if (data.length > LIMIT.postbackData) return null;
  return {
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: {
      type: 'postback',
      label: cut(label, LIMIT.buttonLabel),
      data,
      displayText: cut(displayText, LIMIT.displayText),
    },
  };
}

function goUrl(baseUrl: string, draftId: string, openExternal: boolean): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/go/${encodeURIComponent(draftId)}${openExternal ? '?openExternalBrowser=1' : ''}`;
}

function draftBubble(
  d: DraftCardInput,
  p: { personaName: string; baseUrl: string; clipboard: boolean; openExternal: boolean },
  maxText: number,
): Json {
  const header: Json[] = [
    { type: 'text', text: cut(`第 ${d.idx} 則 · ${nonEmpty(p.personaName, '人設')}`, 60), size: 'sm', weight: 'bold', color: INK, flex: 1, wrap: true },
  ];
  if (d.mentionsProduct) {
    header.push({
      type: 'box',
      layout: 'vertical',
      flex: 0,
      backgroundColor: ACCENT,
      cornerRadius: 'md',
      paddingStart: 'sm',
      paddingEnd: 'sm',
      paddingTop: '2px',
      paddingBottom: '2px',
      contents: [{ type: 'text', text: '提到產品', size: 'xxs', color: '#FFFFFF' }],
    });
  }

  const footer: Json[] = [];
  let uri = goUrl(p.baseUrl, d.draftId, p.openExternal);
  if (uri.length > LIMIT.uri) uri = goUrl(p.baseUrl, d.draftId, false);
  if (uri.length <= LIMIT.uri) {
    footer.push({ type: 'button', style: 'primary', color: INK, height: 'sm', action: { type: 'uri', label: '開 Threads 回覆', uri } });
  }
  if (p.clipboard) {
    footer.push({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: { type: 'clipboard', label: '複製', clipboardText: cut(nonEmpty(d.text, ' '), LIMIT.clipboard) },
    });
  }

  const bubble: Json = {
    type: 'bubble',
    size: 'mega',
    header: { type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm', paddingBottom: 'none', contents: header },
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'text', text: cut(nonEmpty(d.text, '（空白）'), maxText), wrap: true, size: 'md', color: INK }],
    },
  };
  if (footer.length) bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer };
  return bubble;
}

function controlBubble(batchId: string, targetAuthor: string | null, keyword: string | null): Json {
  const b = encodeURIComponent(batchId);
  const info: string[] = [];
  const author = atAuthor(targetAuthor);
  if (author) info.push(`回 ${author}`);
  if (keyword && keyword.trim()) info.push(`關鍵字：${keyword.trim()}`);

  const body: Json[] = [{ type: 'text', text: '不滿意？', weight: 'bold', size: 'md', color: INK }];
  if (info.length) body.push({ type: 'text', text: cut(info.join(' · '), 200), size: 'xs', color: MUTED, wrap: true });
  body.push({ type: 'text', text: '換一批，或調整長短、語氣。', size: 'xs', color: MUTED, wrap: true });

  const buttons = [
    postbackButton('換一批', `action=regen&batch=${b}`, '換一批'),
    postbackButton('再短一點', `action=shorter&batch=${b}`, '再短一點'),
    postbackButton('再俏皮一點', `action=playful&batch=${b}`, '再俏皮一點'),
    postbackButton('換人設', 'action=personas', '換人設'),
  ].filter((x): x is Json => x !== null);

  return {
    type: 'bubble',
    size: 'mega',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons },
  };
}

export function buildDraftCarousel(p: {
  batchId: string; drafts: DraftCardInput[]; personaName: string; targetAuthor: string | null;
  baseUrl: string; clipboard: boolean; openExternal: boolean; keyword: string | null;
}): LineMessage {
  const drafts = p.drafts.slice(0, LIMIT.bubbles - 1); // 留一格給控制卡
  const author = atAuthor(p.targetAuthor);
  const altText = cut(`${drafts.length} 則留言草稿${author ? `：${author}` : ''}`, LIMIT.altText);

  const build = (maxText: number, clipboard: boolean): LineMessage => ({
    type: 'flex',
    altText,
    contents: {
      type: 'carousel',
      contents: [
        ...drafts.map((d) => draftBubble(d, { personaName: p.personaName, baseUrl: p.baseUrl, clipboard, openExternal: p.openExternal }, maxText)),
        controlBubble(p.batchId, p.targetAuthor, p.keyword),
      ],
    },
  });

  let msg = build(1000, p.clipboard);
  // 正常留言 ≤ 150 字，不會超過；萬一超過就縮短顯示文字、拿掉複製鈕
  if (byteLength(JSON.stringify(msg)) > LIMIT.carouselBytes) msg = build(300, false);
  return msg;
}

export function textMessage(text: string, quickReplies?: QuickReplyItem[]): LineMessage {
  const msg: LineMessage = { type: 'text', text: cut(nonEmpty(text, '（沒有內容）'), LIMIT.text) };
  if (quickReplies && quickReplies.length) msg.quickReply = { items: quickReplies.slice(0, 13) };
  return msg;
}

// 手機 LINE 才看得到（官方只寫支援 iOS/Android）；電腦版會直接忽略
export function defaultQuickReplies(): QuickReplyItem[] {
  const item = (label: string, text: string): QuickReplyItem => ({ type: 'action', action: { type: 'message', label, text } });
  return [item('人設', '/人設'), item('今日', '/今日'), item('額度', '/額度'), item('說明', '/說明')];
}

export function personaPicker(personas: { id: number; name: string; active: boolean }[]): LineMessage {
  if (!personas.length) return textMessage('還沒有可用的人設。到後台「人設與產品」新增一個。');
  const buttons: Json[] = personas.slice(0, 10).map((x) => {
    const name = nonEmpty(x.name, `人設 ${x.id}`);
    return {
      type: 'button',
      style: x.active ? 'primary' : 'secondary',
      ...(x.active ? { color: INK } : {}),
      height: 'sm',
      action: {
        type: 'postback',
        label: cut(x.active ? `${name}（使用中）` : name, LIMIT.buttonLabel),
        data: `action=persona&id=${x.id}`,
        displayText: cut(`換成「${name}」`, LIMIT.displayText),
      },
    };
  });
  return {
    type: 'flex',
    altText: '選一個人設',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '換人設', weight: 'bold', size: 'md', color: INK },
          { type: 'text', text: '人設只換語氣，不會替你編身分。', size: 'xs', color: MUTED, wrap: true },
        ],
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons },
    },
  };
}

// 一段說明＋一顆連結按鈕（/海巡 的「到 Threads 搜」用）。網址太長就只給文字
export function linkCard(p: { title: string; text: string; tip?: string; label: string; uri: string; altText: string }): LineMessage {
  if (p.uri.length > LIMIT.uri) {
    return textMessage([p.title, p.text, p.tip].filter(Boolean).join('\n'));
  }
  const body: Json[] = [
    { type: 'text', text: nonEmpty(p.title, ' '), weight: 'bold', size: 'md', color: INK, wrap: true },
    { type: 'text', text: nonEmpty(p.text, ' '), size: 'sm', color: INK, wrap: true },
  ];
  if (p.tip) body.push({ type: 'text', text: p.tip, size: 'xs', color: MUTED, wrap: true });
  return {
    type: 'flex',
    altText: cut(nonEmpty(p.altText, p.title), LIMIT.altText),
    contents: {
      type: 'bubble',
      size: 'mega',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: body },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'button', style: 'primary', color: INK, height: 'sm', action: { type: 'uri', label: cut(p.label, LIMIT.buttonLabel), uri: p.uri } },
        ],
      },
    },
  };
}
