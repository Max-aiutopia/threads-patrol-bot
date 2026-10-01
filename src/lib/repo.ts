// 多個模組共用的資料讀取。只放「很多地方都要用」的查詢；模組自己的查詢寫在模組裡。
import type { Env } from '../env';
import type { Persona, ProductCard } from '../types';
import { getSettings } from './settings';

interface PersonaRow {
  id: number; name: string; tone: string; identity_note: string | null;
  banned_words: string; examples: string; is_active: number; sort_order: number;
}

function parseJsonArray(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToPersona(r: PersonaRow): Persona {
  return {
    id: r.id,
    name: r.name,
    tone: r.tone,
    identityNote: r.identity_note,
    bannedWords: parseJsonArray(r.banned_words),
    examples: parseJsonArray(r.examples),
    isActive: r.is_active === 1,
    sortOrder: r.sort_order,
  };
}

export async function listPersonas(env: Env, activeOnly = false): Promise<Persona[]> {
  const sql = `SELECT * FROM personas ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order, id`;
  const { results } = await env.DB.prepare(sql).all<PersonaRow>();
  return (results ?? []).map(rowToPersona);
}

export async function getPersona(env: Env, id: number): Promise<Persona | null> {
  const r = await env.DB.prepare('SELECT * FROM personas WHERE id = ?1').bind(id).first<PersonaRow>();
  return r ? rowToPersona(r) : null;
}

// 目前使用中的人設：settings.active_persona_id，失效就用排序第一個啟用中的
export async function getActivePersona(env: Env): Promise<Persona | null> {
  const s = await getSettings(env);
  if (s.active_persona_id) {
    const p = await getPersona(env, s.active_persona_id);
    if (p && p.isActive) return p;
  }
  const list = await listPersonas(env, true);
  return list[0] ?? null;
}

export async function getActiveProduct(env: Env): Promise<ProductCard | null> {
  const r = await env.DB.prepare('SELECT * FROM product_facts WHERE is_active = 1 ORDER BY id LIMIT 1').first<{
    id: number; title: string; facts: string; cta_hint: string | null;
  }>();
  if (!r) return null;
  return { id: r.id, title: r.title, facts: parseJsonArray(r.facts), ctaHint: r.cta_hint };
}

// 最近送出過的留言文字（避免重複用）
export async function recentPostedTexts(env: Env, limit = 200): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT text FROM posted_comments ORDER BY posted_at DESC LIMIT ?1')
    .bind(limit)
    .all<{ text: string }>();
  return (results ?? []).map((r) => r.text);
}

// 本月（台北時間）Claude 花費
export async function monthLlmCostUsd(env: Env, now = Date.now()): Promise<number> {
  const d = new Date(now + 8 * 3600_000);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 8 * 3600_000;
  const r = await env.DB.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM llm_usage WHERE created_at >= ?1')
    .bind(monthStart)
    .first<{ c: number }>();
  return r?.c ?? 0;
}

export async function monthPushCount(env: Env, now = Date.now()): Promise<number> {
  // LINE 則數以日本時間 GMT+9 計算月份
  const d = new Date(now + 9 * 3600_000);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 9 * 3600_000;
  const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM line_push_log WHERE ok = 1 AND created_at >= ?1')
    .bind(monthStart)
    .first<{ c: number }>();
  return r?.c ?? 0;
}
