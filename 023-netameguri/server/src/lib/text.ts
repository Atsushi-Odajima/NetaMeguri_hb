// Lightweight, dependency-free text utilities for Japanese + English.
// These are lexical heuristics; they do not "understand" text.

const SENTENCE_SPLIT = /(?<=[。！？!?])\s*|\n+|(?<=[.])\s+(?=[A-Z0-9"'「])/u;

export function splitSentences(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#＃][\p{L}\p{N}_]+/gu, ' ')
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim();
}

const JA_STOP = new Set([
  'こと', 'もの', 'これ', 'それ', 'あれ', 'ため', 'よう', 'さん', 'ところ', 'とき', '場合', '今回', '自分', '私たち',
  'する', 'した', 'して', 'です', 'ます', 'でした', 'という', 'ような', 'ここ', 'そこ', 'みんな', '本当', '感じ',
]);
const EN_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'for', 'with', 'at',
  'by', 'it', 'this', 'that', 'we', 'you', 'i', 'our', 'your', 'from', 'as', 'not', 'can', 'will', 'do', 'have', 'has',
]);

/** Extract candidate keywords: ASCII words, katakana runs, kanji runs (2+ chars). */
export function keywords(text: string): string[] {
  const t = text.normalize('NFKC');
  const out: string[] = [];
  const re = /[A-Za-z][A-Za-z0-9+.#-]{1,}|[\p{Script=Katakana}ー]{2,}|[\p{Script=Han}]{2,}|[\p{Script=Han}][\p{Script=Hiragana}]{0,1}[\p{Script=Han}]+/gu;
  for (const m of t.matchAll(re)) {
    let w = m[0].replace(/[.-]+$/, '');
    if (w.length < 2) continue;
    if (JA_STOP.has(w) || EN_STOP.has(w.toLowerCase())) continue;
    out.push(w);
  }
  return out;
}

export function topKeywords(text: string, n = 10): string[] {
  const freq = new Map<string, number>();
  for (const k of keywords(text)) freq.set(k, (freq.get(k) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, n)
    .map(([k]) => k);
}

/** Character trigram TF map over normalized text (spaces removed for CJK). */
export function trigrams(text: string): Map<string, number> {
  const n = normalize(text).replace(/\s+/g, ' ');
  const m = new Map<string, number>();
  const chars = [...n];
  for (let i = 0; i + 3 <= chars.length; i++) {
    const g = chars.slice(i, i + 3).join('');
    if (g.trim().length < 2) continue;
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 32-bit FNV-1a */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Hashing-trick vector (lexical approximation, NOT a true semantic embedding). */
export function hashVector(text: string, dim = 256): number[] {
  const v = new Array(dim).fill(0);
  for (const [g, c] of trigrams(text)) v[fnv1a(g) % dim] += c;
  for (const k of keywords(text)) v[fnv1a('k:' + k) % dim] += 2;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => Math.round((x / norm) * 1e4) / 1e4);
}

export function vecCosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function countGraphemes(s: string): number {
  // Intl.Segmenter counts emoji/combined chars as 1.
  const seg = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  let n = 0;
  for (const _ of seg.segment(s)) n++;
  return n;
}

export function countEmoji(s: string): number {
  return [...s.matchAll(/\p{Extended_Pictographic}/gu)].length;
}

export function truncateAtSentence(s: string, max: number): string {
  if (countGraphemes(s) <= max) return s;
  const sentences = s.split(/(?<=[。！？!?\n])/u);
  let out = '';
  for (const sen of sentences) {
    if (countGraphemes(out + sen) > max) break;
    out += sen;
  }
  if (!out) out = [...s].slice(0, Math.max(0, max - 1)).join('') + '…';
  return out.trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
