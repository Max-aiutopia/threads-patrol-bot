// 台北時間工具。台灣沒有日光節約，固定 UTC+8。
export const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

// 台北日期 'YYYY-MM-DD'
export function taipeiDate(ms: number): string {
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

// 台北當天 00:00 的 epoch ms
export function startOfTaipeiDay(ms: number): number {
  const shifted = ms + TAIPEI_OFFSET_MS;
  return shifted - (shifted % DAY) - TAIPEI_OFFSET_MS;
}

// 台北時間的「分鐘數」0..1439
export function taipeiMinuteOfDay(ms: number): number {
  const d = new Date(ms + TAIPEI_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// 台北時間 'HH:MM'
export function taipeiHHMM(ms: number): string {
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(11, 16);
}

// 台北時間 'M/D HH:MM'（LINE 訊息顯示用）
export function taipeiShort(ms: number): string {
  const d = new Date(ms + TAIPEI_OFFSET_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.toISOString().slice(11, 16)}`;
}

// 'HH:MM' → 分鐘數
export function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}

// 現在是否在夜間禁送時段 [start, end)，支援跨午夜
export function inWindow(ms: number, startHHMM: string, endHHMM: string): boolean {
  const now = taipeiMinuteOfDay(ms);
  const s = hhmmToMinutes(startHHMM);
  const e = hhmmToMinutes(endHHMM);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

// 夜間時段結束的時間點（ms）
export function windowEndAt(ms: number, startHHMM: string, endHHMM: string): number {
  if (!inWindow(ms, startHHMM, endHHMM)) return ms;
  const e = hhmmToMinutes(endHHMM);
  const dayStart = startOfTaipeiDay(ms);
  let end = dayStart + e * 60 * 1000;
  if (end <= ms) end += DAY;
  return end;
}

export function toUnixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}
