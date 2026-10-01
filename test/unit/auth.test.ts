import { describe, it, expect } from 'vitest';
import { rateKeyForIp } from '../../src/dash/auth';

describe('rateKeyForIp（登入限流的來源 key）', () => {
  it('IPv4 原樣', () => {
    expect(rateKeyForIp('203.0.113.7')).toBe('203.0.113.7');
    expect(rateKeyForIp('')).toBe('unknown');
  });

  it('同一個 /64 的 IPv6 算同一個來源（審查重現：2001:db8::2～::7 從沒被擋）', () => {
    const keys = ['2001:db8::2', '2001:db8::3', '2001:db8::7', '2001:db8:0:0:ffff::1', '2001:0db8:0000:0000:0000:0000:0000:0009'].map(rateKeyForIp);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('2001:db8:0:0::/64');
  });

  it('不同的 /64 分開算', () => {
    expect(rateKeyForIp('2001:db8:1:2::1')).not.toBe(rateKeyForIp('2001:db8:1:3::1'));
  });

  it('大小寫、中括號、zone id 不影響', () => {
    expect(rateKeyForIp('[2001:DB8:1:2::5]')).toBe(rateKeyForIp('2001:db8:1:2::9'));
    expect(rateKeyForIp('fe80::1%eth0')).toBe(rateKeyForIp('fe80::2'));
  });

  it('IPv4-mapped IPv6 當成 IPv4', () => {
    expect(rateKeyForIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateKeyForIp('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('看不懂的字串不會丟錯', () => {
    expect(() => rateKeyForIp('not:an:ip:::::')).not.toThrow();
  });
});
