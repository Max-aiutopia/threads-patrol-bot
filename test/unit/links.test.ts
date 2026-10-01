import { describe, it, expect } from 'vitest';
import { containsLinkOrDomain, containsMention } from '../../src/lib/links';

describe('containsLinkOrDomain', () => {
  // 資安審查（strip.probe.ts）找到的：舊規則只認固定幾種網域結尾，這些全部漏掉
  const links = [
    '加我 LINE lin.ee/AbC123 聊',
    '懶人包在 pse.is/6abcd',
    '看這個 goo.gl/xyz',
    '影片 youtu.be/dQw4w9WgXcQ',
    '全部連結 linktr.ee/maxstudio',
    '來群組 discord.gg/abcd',
    '我整理在 example.xyz/abc',
    '官網 ｍａｘｓｔｕｄｉｏ．ｂｉｚ',
    'maxstudio。biz 有寫',
    'bit.ly/abc 看',
    'shopee.tw/abc',
    '寫信到 me@gmail.com',
    'https://example.com/x',
    'HTTP://EXAMPLE.COM',
    '到 www.example 看',
    '看我主頁maxstudio.biz吧',
    'claude.ai 很好用',
    'n8n.io 也可以',
  ];
  for (const s of links) {
    it(`抓得到：${s}`, () => expect(containsLinkOrDomain(s)).toBe(true));
  }

  // 不能誤判：一般中文、檔名、版本號、句號分隔的英文單字
  const clean = [
    '這個流程我也卡過，最後是把步驟先寫成清單才順',
    '我用 Node.js 寫排程，比想像中簡單',
    '報價.xlsx 那種表格最容易出錯',
    '用 Make。Notion 也行，看團隊習慣',
    '效率大概提升 3.5 倍',
    'GPT-4o 跟 Claude 3.5 都試過',
    'e.g. 先做一個小流程',
    '好',
    '真的！！每週三小時不是小數字。',
  ];
  for (const s of clean) {
    it(`不誤判：${s}`, () => expect(containsLinkOrDomain(s)).toBe(false));
  }
});

describe('containsMention', () => {
  it('抓得到 @帳號（半形、全形）', () => {
    expect(containsMention('@someone 你怎麼看')).toBe(true);
    expect(containsMention('問一下 ＠max_studio 好了')).toBe(true);
  });
  it('一般文字、Email 前半不算提及', () => {
    expect(containsMention('我覺得這樣比較好')).toBe(false);
    expect(containsMention('me@gmail.com')).toBe(false); // Email 由網域規則擋
    expect(containsMention('@ 一個人')).toBe(false);
  });
});
