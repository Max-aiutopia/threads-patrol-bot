import { describe, it, expect } from 'vitest';
import {
  TAIPEI_OFFSET_MS, HOUR, DAY,
  taipeiDate, startOfTaipeiDay, taipeiMinuteOfDay, taipeiHHMM, taipeiShort,
  hhmmToMinutes, inWindow, windowEndAt, toUnixSeconds,
} from '../../src/lib/time';

// 台北時間 → epoch ms（台灣固定 UTC+8）
const tpe = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => Date.UTC(y, mo - 1, d, h, mi, s, ms) - 8 * HOUR;

describe('常數', () => {
  it('UTC+8、小時、天', () => {
    expect(TAIPEI_OFFSET_MS).toBe(8 * 3600_000);
    expect(HOUR).toBe(3600_000);
    expect(DAY).toBe(86_400_000);
  });
});

describe('taipeiDate / startOfTaipeiDay', () => {
  it('UTC 16:00 就是台北隔天 00:00', () => {
    const t = Date.UTC(2026, 8, 27, 16, 0, 0); // 2026-09-27T16:00Z
    expect(taipeiDate(t)).toBe('2026-09-28');
    expect(startOfTaipeiDay(t)).toBe(t);
  });

  it('台北 23:59:59.999 還是當天', () => {
    const t = tpe(2026, 9, 27, 23, 59, 59, 999);
    expect(taipeiDate(t)).toBe('2026-09-27');
    expect(startOfTaipeiDay(t)).toBe(tpe(2026, 9, 27));
  });

  it('跨月、跨年', () => {
    expect(taipeiDate(tpe(2026, 12, 31, 23, 30))).toBe('2026-12-31');
    expect(taipeiDate(tpe(2027, 1, 1, 0, 0))).toBe('2027-01-01');
    expect(startOfTaipeiDay(tpe(2027, 1, 1, 13, 5))).toBe(tpe(2027, 1, 1));
  });
});

describe('taipeiMinuteOfDay / taipeiHHMM / taipeiShort', () => {
  it('分鐘數', () => {
    expect(taipeiMinuteOfDay(tpe(2026, 9, 28, 0, 0))).toBe(0);
    expect(taipeiMinuteOfDay(tpe(2026, 9, 28, 8, 30))).toBe(510);
    expect(taipeiMinuteOfDay(tpe(2026, 9, 28, 23, 59))).toBe(1439);
  });

  it('HH:MM 補零', () => {
    expect(taipeiHHMM(tpe(2026, 9, 28, 7, 5))).toBe('07:05');
    expect(taipeiHHMM(tpe(2026, 9, 28, 23, 59))).toBe('23:59');
  });

  it('M/D HH:MM（月日不補零）', () => {
    expect(taipeiShort(tpe(2026, 1, 5, 9, 7))).toBe('1/5 09:07');
    expect(taipeiShort(tpe(2026, 12, 25, 18, 0))).toBe('12/25 18:00');
  });
});

describe('hhmmToMinutes', () => {
  it('轉分鐘', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('08:30')).toBe(510);
    expect(hhmmToMinutes('23:59')).toBe(1439);
  });
});

describe('inWindow（夜間禁送時段，[start, end)）', () => {
  it('00:00–08:00：頭算、尾不算', () => {
    expect(inWindow(tpe(2026, 9, 28, 0, 0), '00:00', '08:00')).toBe(true);
    expect(inWindow(tpe(2026, 9, 28, 7, 59), '00:00', '08:00')).toBe(true);
    expect(inWindow(tpe(2026, 9, 28, 8, 0), '00:00', '08:00')).toBe(false);
    expect(inWindow(tpe(2026, 9, 28, 23, 59), '00:00', '08:00')).toBe(false);
  });

  it('跨午夜 23:00–07:00', () => {
    expect(inWindow(tpe(2026, 9, 28, 23, 30), '23:00', '07:00')).toBe(true);
    expect(inWindow(tpe(2026, 9, 28, 3, 0), '23:00', '07:00')).toBe(true);
    expect(inWindow(tpe(2026, 9, 28, 7, 0), '23:00', '07:00')).toBe(false);
    expect(inWindow(tpe(2026, 9, 28, 22, 59), '23:00', '07:00')).toBe(false);
  });

  it('start 等於 end → 關閉（永遠 false）', () => {
    for (const h of [0, 3, 12, 23]) expect(inWindow(tpe(2026, 9, 28, h, 0), '00:00', '00:00')).toBe(false);
  });
});

describe('windowEndAt', () => {
  it('不在時段內 → 原值', () => {
    const t = tpe(2026, 9, 28, 12, 0);
    expect(windowEndAt(t, '00:00', '08:00')).toBe(t);
  });

  it('00:00–08:00 的 00:30 → 當天 08:00', () => {
    expect(windowEndAt(tpe(2026, 9, 28, 0, 30), '00:00', '08:00')).toBe(tpe(2026, 9, 28, 8, 0));
  });

  it('跨午夜：23:30 → 隔天 07:00；03:00 → 當天 07:00', () => {
    expect(windowEndAt(tpe(2026, 9, 27, 23, 30), '23:00', '07:00')).toBe(tpe(2026, 9, 28, 7, 0));
    expect(windowEndAt(tpe(2026, 9, 28, 3, 0), '23:00', '07:00')).toBe(tpe(2026, 9, 28, 7, 0));
  });
});

describe('toUnixSeconds', () => {
  it('無條件捨去到秒', () => {
    expect(toUnixSeconds(1_700_000_000_999)).toBe(1_700_000_000);
    expect(toUnixSeconds(0)).toBe(0);
  });
});
