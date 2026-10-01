import { describe, it, expect } from 'vitest';
import type { Env } from '../../src/env';
import {
  DEFAULT_SETTINGS, EDITABLE_KEYS, ALLOWED_MODELS,
  getSettings, setSetting, validateSetting, logJob, type Settings,
} from '../../src/lib/settings';

// 最小的假 D1：記下 SQL 與 bind 參數，all() 回傳指定的列
function fakeEnv(rows: { key: string; value: string }[] = [], opts: { throwOnRun?: boolean } = {}) {
  const log: { sql: string; args: unknown[] }[] = [];
  const DB = {
    prepare(sql: string) {
      const entry = { sql, args: [] as unknown[] };
      log.push(entry);
      const stmt = {
        bind(...args: unknown[]) {
          entry.args = args;
          return stmt;
        },
        async all() {
          return { results: rows, success: true, meta: {} };
        },
        async run() {
          if (opts.throwOnRun) throw new Error('D1 掛了');
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
  };
  return { env: { DB } as unknown as Env, log };
}

describe('DEFAULT_SETTINGS / EDITABLE_KEYS', () => {
  it('預設模型在允許清單裡', () => {
    expect((ALLOWED_MODELS as readonly string[]).includes(DEFAULT_SETTINGS.llm_model)).toBe(true);
  });

  it('EDITABLE_KEYS 都是真的設定，而且不含系統寫入的 next_allowed_at', () => {
    for (const k of EDITABLE_KEYS) expect(k in DEFAULT_SETTINGS).toBe(true);
    expect(EDITABLE_KEYS).not.toContain('next_allowed_at');
  });

  it('預設值本身都通過 validateSetting', () => {
    for (const k of EDITABLE_KEYS) expect(validateSetting(k, DEFAULT_SETTINGS[k])).toBeNull();
  });
});

describe('getSettings（DB 只存改過的值，讀的時候轉型）', () => {
  it('沒有任何列 → 全部預設值', async () => {
    const { env } = fakeEnv([]);
    expect(await getSettings(env)).toEqual(DEFAULT_SETTINGS);
  });

  it('數字、布林、字串都轉對型別', async () => {
    const { env } = fakeEnv([
      { key: 'hourly_cap', value: '5' },
      { key: 'similarity_block', value: '0.75' },
      { key: 'morning_report', value: 'false' },
      { key: 'flex_clipboard', value: '1' },
      { key: 'open_external_browser', value: 'true' },
      { key: 'llm_model', value: 'claude-haiku-4-5' },
      { key: 'night_start', value: '23:30' },
      { key: 'started_at', value: '1790000000000' },
    ]);
    const s = await getSettings(env);
    expect(s.hourly_cap).toBe(5);
    expect(s.similarity_block).toBe(0.75);
    expect(s.morning_report).toBe(false);
    expect(s.flex_clipboard).toBe(true);
    expect(s.open_external_browser).toBe(true);
    expect(s.llm_model).toBe('claude-haiku-4-5');
    expect(s.night_start).toBe('23:30');
    expect(s.started_at).toBe(1790000000000);
    expect(typeof s.started_at).toBe('number');
  });

  it('壞掉的數字 → 退回預設值，不是 NaN', async () => {
    const { env } = fakeEnv([{ key: 'daily_cap', value: 'abc' }]);
    const s = await getSettings(env);
    expect(s.daily_cap).toBe(DEFAULT_SETTINGS.daily_cap);
  });

  it('不認得的 key 忽略', async () => {
    const { env } = fakeEnv([{ key: 'hacker_key', value: '1' }]);
    const s = (await getSettings(env)) as unknown as Record<string, unknown>;
    expect('hacker_key' in s).toBe(false);
  });

  it('不會改到 DEFAULT_SETTINGS 本身', async () => {
    const before = { ...DEFAULT_SETTINGS };
    const { env } = fakeEnv([{ key: 'hourly_cap', value: '9' }]);
    await getSettings(env);
    expect(DEFAULT_SETTINGS).toEqual(before);
  });
});

describe('setSetting', () => {
  it('用 upsert 寫入，值存成字串', async () => {
    const { env, log } = fakeEnv();
    await setSetting(env, 'hourly_cap', 4);
    await setSetting(env, 'morning_report', false);
    expect(log[0].sql).toMatch(/INSERT INTO settings/i);
    expect(log[0].sql).toMatch(/ON CONFLICT/i);
    expect(log[0].args[0]).toBe('hourly_cap');
    expect(log[0].args[1]).toBe('4');
    expect(log[1].args[1]).toBe('false');
    expect(typeof log[0].args[2]).toBe('number');
  });
});

describe('validateSetting', () => {
  const bad = (k: keyof Settings, v: unknown) => expect(validateSetting(k, v)).toEqual(expect.any(String));
  const ok = (k: keyof Settings, v: unknown) => expect(validateSetting(k, v)).toBeNull();

  it('數字：0 以上、有限值、要是 number', () => {
    ok('daily_cap', 0);
    ok('daily_cap', 30);
    bad('daily_cap', -1);
    bad('daily_cap', Number.NaN);
    bad('daily_cap', Number.POSITIVE_INFINITY);
    bad('daily_cap', '10');
  });

  it('similarity_block 在 0..1', () => {
    ok('similarity_block', 0);
    ok('similarity_block', 1);
    bad('similarity_block', 1.01);
  });

  it('布林只收 true/false', () => {
    ok('morning_report', true);
    ok('morning_report', false);
    bad('morning_report', 'true');
    bad('morning_report', 1);
  });

  it('模型只能選允許清單', () => {
    for (const m of ALLOWED_MODELS) ok('llm_model', m);
    bad('llm_model', 'gpt-5');
    bad('llm_model', 'claude-opus-4-1');
  });

  it('effort 只能 low/medium/high', () => {
    ok('llm_effort', 'low');
    ok('llm_effort', 'high');
    bad('llm_effort', 'max');
  });

  it('時間格式 HH:MM（00:00–23:59）', () => {
    ok('night_start', '00:00');
    ok('night_end', '23:59');
    bad('night_start', '24:00');
    bad('night_start', '7:00');
    bad('night_end', '07:60');
    bad('night_end', 700);
  });

  it('錯誤訊息是中文', () => {
    expect(validateSetting('daily_cap', -1)).toMatch(/[一-鿿]/);
    expect(validateSetting('llm_model', 'x')).toMatch(/[一-鿿]/);
  });
});

describe('logJob', () => {
  it('detail 截到 2000 字，ok 存成 1/0', async () => {
    const { env, log } = fakeEnv();
    await logJob(env, 'hourly', true, 'x'.repeat(3000));
    await logJob(env, 'daily', false);
    expect(log[0].args[0]).toBe('hourly');
    expect(log[0].args[1]).toBe(1);
    expect((log[0].args[2] as string).length).toBe(2000);
    expect(log[1].args[1]).toBe(0);
    expect(log[1].args[2]).toBeNull();
  });

  it('DB 出錯也不丟例外（記 log 失敗不能讓主流程掛掉）', async () => {
    const { env } = fakeEnv([], { throwOnRun: true });
    await expect(logJob(env, 'x', true, 'y')).resolves.toBeUndefined();
  });
});
