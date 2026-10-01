import { describe, it, expect } from 'vitest';
import { parseIncoming } from '../../src/line/commands';

function cmd(text: string) {
  const r = parseIncoming(text);
  if (r.type !== 'command') throw new Error(`「${text}」應該是指令，實際是 ${r.type}`);
  return r;
}

describe('parseIncoming：指令', () => {
  it.each([
    ['/說明', 'help'],
    ['/help', 'help'],
    ['/HELP', 'help'],
    ['/Help', 'help'],
    ['/?', 'help'],
    ['/人設', 'persona'],
    ['/海巡', 'patrol'],
    ['/今日', 'today'],
    ['/關鍵字', 'keywords'],
    ['/主題', 'topics'],
    ['/額度', 'quota'],
    ['/暫停', 'pause'],
    ['/恢復', 'resume'],
    ['/後台', 'dashboard'],
  ] as const)('%s → %s', (text, name) => {
    const r = cmd(text);
    expect(r.name).toBe(name);
    expect(r.args).toBe('');
  });

  it('全形斜線「／」也算指令', () => {
    expect(cmd('／人設').name).toBe('persona');
    expect(cmd('／說明').name).toBe('help');
  });

  it('指令後面的字是 args（去頭尾空白）', () => {
    const r = cmd('/海巡 AI 工具 ');
    expect(r.name).toBe('patrol');
    expect(r.args).toBe('AI 工具');
    expect(cmd('/暫停 12').args).toBe('12');
    expect(cmd('/人設 吐槽好朋友').args).toBe('吐槽好朋友');
  });

  it('不認得的指令 → unknown', () => {
    expect(cmd('/不存在的指令').name).toBe('unknown');
    expect(cmd('/xyz').name).toBe('unknown');
  });

  it('Luna 舊指令 /海巡留言 → 當成說明（教他直接貼網址），不是 /海巡 加關鍵字「留言」', () => {
    const r = cmd('/海巡留言');
    expect(r.name).toBe('help');
  });

  it('指令優先：/海巡 後面帶網址也還是指令', () => {
    const r = cmd('/海巡 https://www.threads.com/@a/post/ABC123');
    expect(r.name).toBe('patrol');
  });
});

describe('parseIncoming：Threads 網址', () => {
  it('網址 + 原文 → threads_url，restText 是去掉網址後的文字', () => {
    const r = parseIncoming('https://www.threads.com/@alice/post/ABC123?xmt=zz\n今天用 AI 把報價單流程自動化了');
    expect(r.type).toBe('threads_url');
    if (r.type !== 'threads_url') return;
    expect(r.shortcode).toBe('ABC123');
    expect(r.author).toBe('alice');
    expect(r.url).toBe('https://www.threads.com/@alice/post/ABC123');
    expect(r.restText).toBe('今天用 AI 把報價單流程自動化了');
    expect(r.restText).not.toContain('threads.com');
  });

  it('只有網址 → restText 是空字串', () => {
    const r = parseIncoming('https://www.threads.net/@bob/post/XYZ789/');
    expect(r.type).toBe('threads_url');
    if (r.type !== 'threads_url') return;
    expect(r.restText).toBe('');
    expect(r.shortcode).toBe('XYZ789');
  });

  it('原文在網址前面也可以', () => {
    const r = parseIncoming('這篇在講接案報價 https://www.threads.com/@carol/post/C0de_1');
    expect(r.type).toBe('threads_url');
    if (r.type !== 'threads_url') return;
    expect(r.restText).toBe('這篇在講接案報價');
  });
});

describe('parseIncoming：一般文字', () => {
  it('沒有斜線也沒有網址 → text，內容原封不動', () => {
    const r = parseIncoming('這是別人貼文的原文，我等一下再貼網址');
    expect(r).toEqual({ type: 'text', text: '這是別人貼文的原文，我等一下再貼網址' });
  });

  it('IG 網址不算 Threads 網址', () => {
    expect(parseIncoming('https://www.instagram.com/p/ABC123/').type).toBe('text');
  });
});
