import { describe, it, expect } from 'vitest';
import { parseThreadsPostUrl, extractFirstThreadsUrl, buildReplyIntentUrl } from '../../src/threads/url';

describe('parseThreadsPostUrl', () => {
  const canonical = 'https://www.threads.com/@max.studio_tw/post/DAbc-123_x';

  it.each([
    'https://www.threads.com/@max.studio_tw/post/DAbc-123_x',
    'https://threads.com/@max.studio_tw/post/DAbc-123_x',
    'https://www.threads.net/@max.studio_tw/post/DAbc-123_x',
    'https://threads.net/@max.studio_tw/post/DAbc-123_x',
    'https://www.threads.com/@max.studio_tw/post/DAbc-123_x/',
    'https://www.threads.com/@max.studio_tw/post/DAbc-123_x?xmt=AQGzAbCdEf',
    'https://www.threads.net/@max.studio_tw/post/DAbc-123_x?igshid=NTc4MTIwNjQ2YQ==',
    'https://www.threads.com/@max.studio_tw/post/DAbc-123_x/?xmt=AQG&slof=1',
  ])('接受 %s，並正規化成 www.threads.com', (input) => {
    const r = parseThreadsPostUrl(input);
    expect(r).not.toBeNull();
    expect(r!.shortcode).toBe('DAbc-123_x');
    expect(r!.author).toBe('max.studio_tw');
    expect(r!.url).toBe(canonical);
  });

  it('接受 /t/CODE 短網址，作者是 null', () => {
    const r = parseThreadsPostUrl('https://www.threads.com/t/CuXFPIeLLod');
    expect(r).not.toBeNull();
    expect(r!.shortcode).toBe('CuXFPIeLLod');
    expect(r!.author).toBeNull();
  });

  it.each([
    'https://www.instagram.com/@max/post/ABC',
    'https://evil.com/@max/post/ABC',
    'https://threads.com.evil.com/@max/post/ABC',
    'https://www.threads.com/@max',
    'https://www.threads.com/search?q=AI',
    'https://www.threads.com/@max/post/',
    '不是網址',
    '',
  ])('拒絕 %s', (input) => {
    expect(parseThreadsPostUrl(input)).toBeNull();
  });
});

describe('extractFirstThreadsUrl', () => {
  it('從一段有換行的訊息裡找出網址', () => {
    const text = 'https://www.threads.com/@alice/post/ABC123?xmt=zz\n今天用 AI 把報價單流程自動化了';
    const r = extractFirstThreadsUrl(text);
    expect(r).not.toBeNull();
    expect(r!.shortcode).toBe('ABC123');
    expect(r!.author).toBe('alice');
    expect(r!.url).toBe('https://www.threads.com/@alice/post/ABC123');
  });

  it('網址在句子中間也找得到', () => {
    const r = extractFirstThreadsUrl('幫我看這篇 https://threads.net/@bob_01/post/XyZ-9 謝謝');
    expect(r?.shortcode).toBe('XyZ-9');
    expect(r?.author).toBe('bob_01');
  });

  it('有兩個網址時取第一個', () => {
    const r = extractFirstThreadsUrl('https://www.threads.com/@a/post/FIRST1 跟 https://www.threads.com/@b/post/SECOND2');
    expect(r?.shortcode).toBe('FIRST1');
  });

  it('網址後面直接接中文（沒空白）時，短碼只取英數', () => {
    const r = extractFirstThreadsUrl('https://www.threads.com/@a/post/ABC123看這篇');
    expect(r?.shortcode).toBe('ABC123');
  });

  it('沒有 Threads 網址 → null', () => {
    expect(extractFirstThreadsUrl('https://www.instagram.com/p/ABC/ 這是 IG')).toBeNull();
    expect(extractFirstThreadsUrl('只是一般的文字')).toBeNull();
  });
});

describe('buildReplyIntentUrl', () => {
  it('組出官方 Web Intent 網址', () => {
    expect(buildReplyIntentUrl('ABC123', 'hello')).toBe(
      'https://www.threads.com/intent/post?reply_post_shortcode=ABC123&text=hello',
    );
  });

  it('用 encodeURIComponent 編碼中文、符號、換行、emoji', () => {
    const text = '同意！省下 3 小時 & 50% 的時間 #AI?\n第二行 😀';
    const url = buildReplyIntentUrl('Ab_-9', text);
    expect(url).toBe(
      `https://www.threads.com/intent/post?reply_post_shortcode=${encodeURIComponent('Ab_-9')}&text=${encodeURIComponent(text)}`,
    );
    const u = new URL(url);
    expect(u.origin).toBe('https://www.threads.com');
    expect(u.pathname).toBe('/intent/post');
    expect(u.searchParams.get('reply_post_shortcode')).toBe('Ab_-9');
    expect(u.searchParams.get('text')).toBe(text);
    expect(url).not.toContain(' ');
    expect(url).not.toContain('#');
  });
});
