/**
 * NetaMeguri 表記ゆれチェック — matching core.
 *
 * Faithful TypeScript port of the standalone notation checker's `js/core.js` (dictionary validation,
 * conflict analysis, matcher construction, detection, per-hit replacement, dictionary JSON I/O).
 * Behaviour is intentionally identical; see DECISIONS.md (D-NOTATION-*) before changing it:
 * - NO Unicode normalization (NFC/NFKC). Full-width/half-width and variant kanji only match code-point exact.
 * - Case-insensitive rules use the JS `iu` flags (simple case folding).
 * - "word" mode adds ASCII-only boundaries `(?<![A-Za-z0-9_])` / `(?![A-Za-z0-9_])` only on the side whose
 *   first/last character is an ASCII word char. Japanese/symbols/spaces act as separators. `\b` is not used.
 * - The correct form itself, and matches fully inside an occurrence of the correct form on the same line, are skipped.
 * - Overlaps: sorted by start asc / length desc, greedy non-overlapping (longer variant wins).
 * - Conflicting rules (same variant → different correct forms, or a variant equal to another rule's correct form)
 *   are detected but never auto-replaced.
 * Pure functions only (no DB, no I/O) so they can be unit-tested and reused by API, MCP and UI.
 */

export const NOTATION_APP_ID = 'notation-checker'; // kept for dictionary JSON interoperability with the standalone tool
export const NOTATION_SCHEMA_VERSION = 1;
export const NOTATION_LIMITS = {
  maxRules: 2000,
  maxVariantsPerRule: 200,
  maxTermLength: 200,
  maxDictionaryBytes: 5 * 1024 * 1024,
};
const CONTEXT_CHARS = 20;

export type MatchMode = 'string' | 'word';
export interface NotationRule {
  ruleId: string;
  correct: string;
  variants: string[];
  caseSensitive: boolean;
  matchMode: MatchMode;
  enabled: boolean;
}
export interface NotationDictionary {
  name: string;
  rules: NotationRule[];
}
export type FindingStatus = 'pending' | 'replaced' | 'ignored';
export interface DocLine {
  no: number;
  text: string;
  eol: string;
  role: 'text';
}
export interface NotationDoc {
  lines: DocLine[];
}
export interface Finding {
  id: number;
  lineIdx: number;
  lineNo: number;
  start: number;
  end: number;
  matched: string;
  correct: string;
  corrects: string[];
  ruleIds: string[];
  ruleId: string;
  conflict: boolean;
  status: FindingStatus;
}
export interface Conflict {
  type: 'same-variant' | 'variant-is-correct';
  variant: string;
  corrects: string[];
  ruleIds: string[];
}

// ------------------------------------------------------------------ document (TXT semantics)

/** Split keeping each line's own EOL so serialize() is byte-identical for untouched parts. */
export function splitLines(text: string): { text: string; eol: string }[] {
  const lines: { text: string; eol: string }[] = [];
  const re = /\r\n|\n|\r/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lines.push({ text: text.slice(last, m.index), eol: m[0] });
    last = re.lastIndex;
  }
  lines.push({ text: text.slice(last), eol: '' });
  return lines;
}

export function parseDocument(text: string): NotationDoc {
  return { lines: splitLines(text).map((l, idx) => ({ no: idx + 1, text: l.text, eol: l.eol, role: 'text' as const })) };
}

export function serializeDocument(doc: NotationDoc): string {
  let out = '';
  for (const l of doc.lines) out += l.text + l.eol;
  return out;
}

// ------------------------------------------------------------------ dictionary

let idCounter = 0;
export function newRuleId(): string {
  idCounter++;
  return 'r' + Date.now().toString(36) + '_' + idCounter.toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
}

export function createRule(fields: Partial<NotationRule> = {}): NotationRule {
  return {
    ruleId: fields.ruleId || newRuleId(),
    correct: fields.correct || '',
    variants: Array.isArray(fields.variants) ? fields.variants.slice() : [],
    caseSensitive: fields.caseSensitive !== false,
    matchMode: fields.matchMode === 'word' ? 'word' : 'string',
    enabled: fields.enabled !== false,
  };
}

/** Variant textarea (one per line) → array. Trims and drops empty lines. */
export function parseVariantLines(text: string): string[] {
  return String(text || '')
    .split(/\r\n|\n|\r/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

const charLength = (s: string) => Array.from(s).length;

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** Validate one rule. errors block saving; warnings do not. */
export function validateRule(rule: Pick<NotationRule, 'correct' | 'variants' | 'caseSensitive'>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const correct = typeof rule.correct === 'string' ? rule.correct.trim() : '';
  const L = NOTATION_LIMITS;
  if (correct === '') errors.push('正しい表記が空です。');
  if (correct.length > L.maxTermLength) errors.push('正しい表記が長すぎます（' + L.maxTermLength + '文字まで）。');
  const variants = Array.isArray(rule.variants) ? rule.variants : [];
  if (variants.length === 0) errors.push('別表記が登録されていません（1つ以上必要です）。');
  if (variants.length > L.maxVariantsPerRule) errors.push('別表記が多すぎます（1ルール' + L.maxVariantsPerRule + '件まで）。');
  const seen: Record<string, boolean> = Object.create(null);
  const seenLower: Record<string, string> = Object.create(null);
  for (const v of variants) {
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push('空の別表記があります。');
      continue;
    }
    if (v.length > L.maxTermLength) errors.push('別表記「' + v.slice(0, 20) + '…」が長すぎます。');
    if (v === correct) errors.push('別表記「' + v + '」が正しい表記と同じです。');
    if (seen[v]) errors.push('別表記「' + v + '」が重複しています。');
    else if (!rule.caseSensitive && seenLower[v.toLowerCase()]) {
      warnings.push('別表記「' + v + '」は大文字小文字を区別しない設定では「' + seenLower[v.toLowerCase()] + '」と同じ扱いです。');
    }
    seen[v] = true;
    if (!seenLower[v.toLowerCase()]) seenLower[v.toLowerCase()] = v;
    if (charLength(v) === 1) warnings.push('別表記「' + v + '」は1文字のため、誤検出が多くなる可能性があります。');
  }
  if (correct !== '' && charLength(correct) === 1) warnings.push('正しい表記「' + correct + '」は1文字です。誤検出・誤置換に注意してください。');
  return { errors: dedupe(errors), warnings: dedupe(warnings) };
}

function termsCollide(a: string, aCase: boolean, b: string, bCase: boolean) {
  if (a === b) return true;
  if (!aCase || !bCase) return a.toLowerCase() === b.toLowerCase();
  return false;
}

const entryKey = (ruleId: string, variant: string) => ruleId + '\u0000' + variant;

/**
 * Conflicts among ENABLED rules:
 * 1) same variant registered for different correct forms; 2) a variant equals another rule's correct form.
 * Conflicting (rule × variant) entries are excluded from automatic replacement.
 */
export function analyzeDictionary(rules: NotationRule[]): { conflicts: Conflict[]; conflictKeys: Record<string, boolean> } {
  const enabled = rules.filter((r) => r.enabled);
  const conflicts: Conflict[] = [];
  const conflictKeys: Record<string, boolean> = Object.create(null);
  const byLower: Record<string, { rule: NotationRule; variant: string }[]> = Object.create(null);
  for (const r of enabled) for (const v of r.variants) (byLower[v.toLowerCase()] ??= []).push({ rule: r, variant: v });
  for (const k of Object.keys(byLower)) {
    const list = byLower[k];
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.rule === b.rule) continue;
        if (a.rule.correct === b.rule.correct) continue;
        if (!termsCollide(a.variant, a.rule.caseSensitive, b.variant, b.rule.caseSensitive)) continue;
        conflictKeys[entryKey(a.rule.ruleId, a.variant)] = true;
        conflictKeys[entryKey(b.rule.ruleId, b.variant)] = true;
        conflicts.push({ type: 'same-variant', variant: a.variant === b.variant ? a.variant : a.variant + ' / ' + b.variant, corrects: [a.rule.correct, b.rule.correct], ruleIds: [a.rule.ruleId, b.rule.ruleId] });
      }
    }
  }
  for (const x of enabled) {
    for (const v of x.variants) {
      for (const y of enabled) {
        if (y === x || y.correct === x.correct) continue;
        if (v === y.correct || (!x.caseSensitive && v.toLowerCase() === y.correct.toLowerCase())) {
          conflictKeys[entryKey(x.ruleId, v)] = true;
          conflicts.push({ type: 'variant-is-correct', variant: v, corrects: [x.correct, y.correct], ruleIds: [x.ruleId, y.ruleId] });
        }
      }
    }
  }
  return { conflicts, conflictKeys };
}

/** Validate a parsed dictionary object. Returns the dictionary only when EVERYTHING is valid (all-or-nothing). */
export function validateDictionaryData(data: unknown): { ok: true; errors: []; dictionary: NotationDictionary } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, errors: ['辞書ファイルの形式が正しくありません。'] };
  const d = data as Record<string, any>;
  if (!('schemaVersion' in d)) return { ok: false, errors: ['schemaVersion がありません。このアプリで保存した辞書ファイルを選んでください。'] };
  if (d.schemaVersion !== NOTATION_SCHEMA_VERSION) {
    return { ok: false, errors: ['対応していない辞書のバージョンです（schemaVersion: ' + String(d.schemaVersion).slice(0, 20) + '）。このバージョンで読み込めるのは ' + NOTATION_SCHEMA_VERSION + ' です。'] };
  }
  if ('name' in d && typeof d.name !== 'string') errors.push('辞書名（name）が文字列ではありません。');
  if (!Array.isArray(d.rules)) {
    errors.push('rules（ルール一覧）が配列ではありません。');
    return { ok: false, errors };
  }
  if (d.rules.length > NOTATION_LIMITS.maxRules) return { ok: false, errors: ['ルール数が多すぎます（' + NOTATION_LIMITS.maxRules + '件まで）。'] };
  const rules: NotationRule[] = [];
  const ids: Record<string, boolean> = Object.create(null);
  d.rules.forEach((r: any, idx: number) => {
    const label = idx + 1 + '番目のルール';
    if (!r || typeof r !== 'object' || Array.isArray(r)) return void errors.push(label + '：形式が正しくありません。');
    if (typeof r.correct !== 'string') return void errors.push(label + '：correct（正しい表記）が文字列ではありません。');
    if (!Array.isArray(r.variants)) return void errors.push(label + '：variants（別表記）が配列ではありません。');
    if (r.variants.some((v: unknown) => typeof v !== 'string')) return void errors.push(label + '：variants に文字列以外の値があります。');
    if ('caseSensitive' in r && typeof r.caseSensitive !== 'boolean') return void errors.push(label + '：caseSensitive は true / false で指定してください。');
    if ('enabled' in r && typeof r.enabled !== 'boolean') return void errors.push(label + '：enabled は true / false で指定してください。');
    if ('matchMode' in r && r.matchMode !== 'string' && r.matchMode !== 'word') return void errors.push(label + '：matchMode は "string" か "word" で指定してください。');
    if ('ruleId' in r && (typeof r.ruleId !== 'string' || r.ruleId === '' || r.ruleId.length > 100)) return void errors.push(label + '：ruleId が不正です。');
    if (r.ruleId && ids[r.ruleId]) return void errors.push(label + '：ruleId「' + r.ruleId + '」が重複しています。');
    const rule = createRule({ ruleId: r.ruleId, correct: r.correct.trim(), variants: r.variants.map((v: string) => v.trim()), caseSensitive: r.caseSensitive, matchMode: r.matchMode, enabled: r.enabled });
    const v = validateRule(rule);
    if (v.errors.length) return void errors.push(label + '（' + (rule.correct || '空') + '）：' + v.errors.join(' '));
    ids[rule.ruleId] = true;
    rules.push(rule);
  });
  if (errors.length) return { ok: false, errors };
  const name = typeof d.name === 'string' ? d.name.trim().slice(0, 100) : '';
  return { ok: true, errors: [], dictionary: { name: name || '無題の辞書', rules } };
}

/** Parse dictionary JSON text. Never throws. */
export function parseDictionaryJson(text: string) {
  if (Buffer.byteLength(text, 'utf8') > NOTATION_LIMITS.maxDictionaryBytes) return { ok: false as const, errors: ['辞書ファイルが大きすぎます（5MBまで）。'] };
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false as const, errors: ['JSON として読み込めませんでした。ファイルが壊れている可能性があります。'] };
  }
  return validateDictionaryData(data);
}

export function dictionaryToJson(dict: NotationDictionary, savedAt = new Date()): string {
  const data = {
    schemaVersion: NOTATION_SCHEMA_VERSION,
    app: NOTATION_APP_ID,
    name: dict.name || '無題の辞書',
    savedAt: savedAt.toISOString(),
    rules: dict.rules.map((r) => ({ ruleId: r.ruleId, correct: r.correct, variants: r.variants.slice(), caseSensitive: r.caseSensitive, matchMode: r.matchMode, enabled: r.enabled })),
  };
  return JSON.stringify(data, null, 2) + '\n';
}

// ------------------------------------------------------------------ detection

// With the `u` flag, escaping non-syntax chars (e.g. `\-`) is a SyntaxError, so only syntax chars are escaped.
const escapeRegExp = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const isAsciiWordChar = (ch: string | undefined) => !!ch && /^[A-Za-z0-9_]$/.test(ch);

/**
 * Build the matcher for one variant. Word mode: ASCII boundary only on the side whose edge char is an ASCII
 * word char. Non-ASCII (Japanese) acts as a separator — English word boundaries are not applied to Japanese.
 */
export function buildMatcher(variant: string, caseSensitive: boolean, matchMode: MatchMode): RegExp {
  let src = escapeRegExp(variant);
  if (matchMode === 'word') {
    const chars = Array.from(variant);
    if (isAsciiWordChar(chars[0])) src = '(?<![A-Za-z0-9_])' + src;
    if (isAsciiWordChar(chars[chars.length - 1])) src = src + '(?![A-Za-z0-9_])';
  }
  return new RegExp(src, 'gu' + (caseSensitive ? '' : 'i'));
}

interface Entry {
  ruleId: string;
  variant: string;
  correct: string;
  caseSensitive: boolean;
  re: RegExp;
  conflict: boolean;
}

export function compileRules(rules: NotationRule[]) {
  const analysis = analyzeDictionary(rules);
  const entries: Entry[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    if (validateRule(r).errors.length) continue;
    for (const v of r.variants) {
      entries.push({ ruleId: r.ruleId, variant: v, correct: r.correct, caseSensitive: r.caseSensitive, re: buildMatcher(v, r.caseSensitive, r.matchMode), conflict: !!analysis.conflictKeys[entryKey(r.ruleId, v)] });
    }
  }
  return { entries, analysis };
}

function correctSpans(text: string, correct: string): [number, number][] {
  const spans: [number, number][] = [];
  let from = 0;
  let idx: number;
  while ((idx = text.indexOf(correct, from)) !== -1) {
    spans.push([idx, idx + correct.length]);
    from = idx + 1;
  }
  return spans;
}

export function findInLine(text: string, entries: Entry[]) {
  const cands: { start: number; end: number; text: string; entry: Entry }[] = [];
  const spanCache: Record<string, [number, number][]> = Object.create(null);
  for (const en of entries) {
    if (en.caseSensitive && text.indexOf(en.variant) === -1) continue; // fast pre-check
    en.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = en.re.exec(text)) !== null) {
      const s = m.index;
      const t = m[0];
      if (t === '') {
        en.re.lastIndex++;
        continue;
      }
      const end = s + t.length;
      if (t === en.correct) continue; // the correct form itself is never a hit
      const spans = (spanCache[en.correct] ??= correctSpans(text, en.correct));
      if (spans.some(([a, b]) => a <= s && end <= b)) continue; // part of the correct form
      cands.push({ start: s, end, text: t, entry: en });
    }
  }
  if (!cands.length) return [];
  cands.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: { start: number; end: number; text: string; corrects: string[]; ruleIds: string[]; conflict: boolean }[] = [];
  let lastEnd = -1;
  let i = 0;
  while (i < cands.length) {
    const c = cands[i];
    const group = [c];
    let j = i + 1;
    while (j < cands.length && cands[j].start === c.start && cands[j].end === c.end) group.push(cands[j++]);
    i = j;
    if (c.start < lastEnd) continue; // overlap: the longer one (already taken) wins
    lastEnd = c.end;
    const corrects = dedupe(group.map((g) => g.entry.correct));
    const ruleIds = dedupe(group.map((g) => g.entry.ruleId));
    const conflict = corrects.length > 1 || group.some((g) => g.entry.conflict);
    out.push({ start: c.start, end: c.end, text: c.text, corrects, ruleIds, conflict });
  }
  return out;
}

export const findingKey = (f: Pick<Finding, 'lineIdx' | 'start' | 'matched'>) => f.lineIdx + ':' + f.start + ':' + f.matched;

export function detect(doc: NotationDoc, rules: NotationRule[], options: { ignoredKeys?: Record<string, boolean> | Set<string> | null } = {}) {
  const compiled = compileRules(rules);
  const ig = options.ignoredKeys;
  const isIgnored = (k: string) => (ig instanceof Set ? ig.has(k) : !!ig?.[k]);
  const findings: Finding[] = [];
  let id = 0;
  doc.lines.forEach((line, li) => {
    if (line.role !== 'text' || line.text === '') return;
    for (const hit of findInLine(line.text, compiled.entries)) {
      const f: Finding = { id: ++id, lineIdx: li, lineNo: line.no, start: hit.start, end: hit.end, matched: hit.text, correct: hit.corrects.join(' / '), corrects: hit.corrects, ruleIds: hit.ruleIds, ruleId: hit.ruleIds[0], conflict: hit.conflict, status: 'pending' };
      if (isIgnored(findingKey(f))) f.status = 'ignored';
      findings.push(f);
    }
  });
  return { findings, analysis: compiled.analysis, entryCount: compiled.entries.length };
}

// ------------------------------------------------------------------ replacement

/**
 * Replace one finding. Later findings on the same line are shifted by the length delta.
 * Refuses if not pending, conflicting, or the text at the position no longer matches.
 */
export function replaceFinding(doc: NotationDoc, findings: Finding[], f: Finding): { ok: boolean; reason?: string } {
  if (f.status !== 'pending') return { ok: false, reason: 'この箇所は未修正ではありません。' };
  if (f.conflict || f.corrects.length !== 1) return { ok: false, reason: '競合する辞書ルールのため置換できません。' };
  const line = doc.lines[f.lineIdx];
  if (!line || line.role !== 'text') return { ok: false, reason: '置換対象の行が見つかりません。' };
  if (line.text.slice(f.start, f.end) !== f.matched) return { ok: false, reason: '本文が変わっているため置換できません。再チェックしてください。' };
  const correct = f.corrects[0];
  const delta = correct.length - (f.end - f.start);
  line.text = line.text.slice(0, f.start) + correct + line.text.slice(f.end);
  const oldEnd = f.end;
  for (const g of findings) {
    if (g !== f && g.lineIdx === f.lineIdx && g.start >= oldEnd) {
      g.start += delta;
      g.end += delta;
    }
  }
  f.end = f.start + correct.length;
  f.status = 'replaced';
  return { ok: true };
}

export function contextOf(doc: NotationDoc, f: Pick<Finding, 'lineIdx' | 'start' | 'end'>, chars = CONTEXT_CHARS) {
  const text = doc.lines[f.lineIdx].text;
  const bs = Math.max(0, f.start - chars);
  const ae = Math.min(text.length, f.end + chars);
  return { before: (bs > 0 ? '…' : '') + text.slice(bs, f.start), target: text.slice(f.start, f.end), after: text.slice(f.end, ae) + (ae < text.length ? '…' : '') };
}
