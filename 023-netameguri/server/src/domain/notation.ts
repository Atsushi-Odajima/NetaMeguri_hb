// NetaMeguri 表記ゆれチェック: workspace-level notation dictionary + checks/replacement on drafts.
// Matching logic lives in lib/notation.ts (faithful port of the standalone tool); this module adds tenancy,
// permissions, persistence and the bridge to ContentItem versioning (updateContent).
import { z } from 'zod';
import { j } from '../db/db.js';
import { id, badRequest, conflict, notFound } from '../lib/util.js';
import {
  NOTATION_LIMITS, analyzeDictionary, contextOf, createRule, detect, dictionaryToJson, findingKey, parseDictionaryJson, parseDocument,
  parseVariantLines, replaceFinding, serializeDocument, validateRule, type Finding, type NotationDictionary, type NotationRule,
} from '../lib/notation.js';
import { audit, nowIso, requirePerm, type Ctx } from './context.js';
import { getContent, updateContent } from './content.js';

const DEFAULT_NAME = '表記ゆれ辞書';

function loadRaw(ctx: Ctx) {
  return ctx.app.db.get('SELECT * FROM notation_dictionaries WHERE workspace_id = ?', ctx.workspaceId);
}

/** Internal read (no permission check): used by checks that already verified 'read'. */
export function loadDictionary(ctx: Ctx): NotationDictionary & { updatedAt: string | null } {
  const r = loadRaw(ctx);
  if (!r) return { name: DEFAULT_NAME, rules: [], updatedAt: null };
  return { name: r.name, rules: j<NotationRule[]>(r.rules, []), updatedAt: r.updated_at };
}

function persist(ctx: Ctx, dict: NotationDictionary) {
  if (dict.rules.length > NOTATION_LIMITS.maxRules) throw badRequest(`ルール数が多すぎます（${NOTATION_LIMITS.maxRules}件まで）`);
  const ids = new Set<string>();
  for (const r of dict.rules) {
    if (ids.has(r.ruleId)) throw badRequest(`ruleId「${r.ruleId}」が重複しています`);
    ids.add(r.ruleId);
    const v = validateRule(r);
    if (v.errors.length) throw badRequest(`ルール「${r.correct || '空'}」: ${v.errors.join(' ')}`, { ruleId: r.ruleId, errors: v.errors });
  }
  const now = nowIso(ctx);
  const existing = loadRaw(ctx);
  if (existing) ctx.app.db.run('UPDATE notation_dictionaries SET name = ?, rules = ?, updated_by = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', dict.name, JSON.stringify(dict.rules), ctx.userId, now, existing.id, ctx.workspaceId);
  else ctx.app.db.insert('notation_dictionaries', { id: id('ntd'), workspace_id: ctx.workspaceId, name: dict.name, rules: JSON.stringify(dict.rules), updated_by: ctx.userId, updated_at: now });
}

function view(ctx: Ctx) {
  const d = loadDictionary(ctx);
  const a = analyzeDictionary(d.rules);
  return {
    name: d.name,
    updatedAt: d.updatedAt,
    rules: d.rules.map((r) => ({ ...r, warnings: validateRule(r).warnings })),
    conflicts: a.conflicts,
    limits: NOTATION_LIMITS,
  };
}

export function getDictionary(ctx: Ctx) {
  requirePerm(ctx, 'read');
  return view(ctx);
}

const RuleInput = z.object({
  correct: z.string().max(NOTATION_LIMITS.maxTermLength + 50),
  variants: z.union([z.array(z.string().max(NOTATION_LIMITS.maxTermLength + 50)).max(NOTATION_LIMITS.maxVariantsPerRule + 1), z.string().max(100_000)]),
  caseSensitive: z.boolean().optional(),
  matchMode: z.enum(['string', 'word']).optional(),
  enabled: z.boolean().optional(),
});
const normVariants = (v: string[] | string) => (typeof v === 'string' ? parseVariantLines(v) : v.map((s) => s.trim()));

/** Dictionary edits share the Brand Voice permission (terminology is brand policy): owner/admin. */
export function addRule(ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'manage_brand');
  const p = RuleInput.parse(input);
  const d = loadDictionary(ctx);
  const rule = createRule({ correct: p.correct.trim(), variants: normVariants(p.variants), caseSensitive: p.caseSensitive, matchMode: p.matchMode, enabled: p.enabled });
  persist(ctx, { name: d.name, rules: [...d.rules, rule] });
  audit(ctx, 'notation.rule_added', 'notation_rule', rule.ruleId, { variants: rule.variants.length });
  return { ruleId: rule.ruleId, dictionary: view(ctx) };
}

export function updateRule(ctx: Ctx, ruleId: string, input: unknown) {
  requirePerm(ctx, 'manage_brand');
  const p = RuleInput.partial().parse(input);
  const d = loadDictionary(ctx);
  const idx = d.rules.findIndex((r) => r.ruleId === ruleId);
  if (idx < 0) throw notFound('notation_rule');
  const cur = d.rules[idx];
  const next: NotationRule = {
    ...cur,
    ...(p.correct !== undefined ? { correct: p.correct.trim() } : {}),
    ...(p.variants !== undefined ? { variants: normVariants(p.variants) } : {}),
    ...(p.caseSensitive !== undefined ? { caseSensitive: p.caseSensitive } : {}),
    ...(p.matchMode !== undefined ? { matchMode: p.matchMode } : {}),
    ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
  };
  const rules = d.rules.slice();
  rules[idx] = next;
  persist(ctx, { name: d.name, rules });
  audit(ctx, 'notation.rule_updated', 'notation_rule', ruleId, { fields: Object.keys(p) });
  return view(ctx);
}

export function deleteRule(ctx: Ctx, ruleId: string) {
  requirePerm(ctx, 'manage_brand');
  const d = loadDictionary(ctx);
  if (!d.rules.some((r) => r.ruleId === ruleId)) throw notFound('notation_rule');
  persist(ctx, { name: d.name, rules: d.rules.filter((r) => r.ruleId !== ruleId) });
  audit(ctx, 'notation.rule_deleted', 'notation_rule', ruleId);
  return view(ctx);
}

export function renameDictionary(ctx: Ctx, name: string) {
  requirePerm(ctx, 'manage_brand');
  const d = loadDictionary(ctx);
  persist(ctx, { name: String(name ?? '').trim().slice(0, 100) || DEFAULT_NAME, rules: d.rules });
  return view(ctx);
}

/**
 * Import dictionary JSON (same schema as the standalone tool, schemaVersion 1). All-or-nothing:
 * decode → JSON.parse → validate all → replace. On any error the current dictionary is unchanged.
 */
export function importDictionary(ctx: Ctx, input: { json?: unknown }) {
  requirePerm(ctx, 'manage_brand');
  const text = typeof input?.json === 'string' ? input.json : input?.json && typeof input.json === 'object' ? JSON.stringify(input.json) : '';
  if (!text) throw badRequest('辞書JSONを指定してください');
  const res = parseDictionaryJson(text);
  if (!res.ok) throw badRequest('辞書ファイルを読み込めませんでした。現在の辞書はそのままです。', { errors: res.errors.slice(0, 50) });
  persist(ctx, res.dictionary);
  audit(ctx, 'notation.imported', 'notation_dictionary', ctx.workspaceId, { rules: res.dictionary.rules.length });
  return view(ctx);
}

export function exportDictionary(ctx: Ctx) {
  requirePerm(ctx, 'export');
  const d = loadDictionary(ctx);
  const safe = d.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60) || 'dictionary';
  return { filename: `${safe}.json`, mime: 'application/json; charset=utf-8', body: dictionaryToJson(d, ctx.app.clock.now()) };
}

// ---------------------------------------------------------------- checks on drafts

function findingView(doc: ReturnType<typeof parseDocument>, f: Finding) {
  const c = contextOf(doc, f);
  return { key: findingKey(f), lineNo: f.lineNo, lineIdx: f.lineIdx, start: f.start, end: f.end, matched: f.matched, correct: f.correct, corrects: f.corrects, ruleIds: f.ruleIds, conflict: f.conflict, status: f.status, context: c };
}

/** Group by "detected form → correct form" (same unit as the standalone tool's bulk replace). */
function groups(findings: Finding[]) {
  const m = new Map<string, { matched: string; correct: string; total: number; pending: number; conflict: boolean }>();
  for (const f of findings) {
    const k = f.matched + '\u0000' + f.correct;
    const g = m.get(k) ?? { matched: f.matched, correct: f.correct, total: 0, pending: 0, conflict: false };
    g.total++;
    if (f.status === 'pending') g.pending++;
    if (f.conflict) g.conflict = true;
    m.set(k, g);
  }
  return [...m.values()];
}

function summarize(doc: ReturnType<typeof parseDocument>, findings: Finding[]) {
  const count = (s: string) => findings.filter((f) => f.status === s).length;
  return {
    findings: findings.map((f) => findingView(doc, f)),
    groups: groups(findings),
    counts: { total: findings.length, pending: count('pending'), replaced: count('replaced'), ignored: count('ignored'), conflict: findings.filter((f) => f.conflict && f.status === 'pending').length },
  };
}

/**
 * Check one ContentItem body. `ignoredKeys` (lineIdx:start:matched) is client-held state, as in the
 * standalone tool (ignores are per review session, not persisted).
 */
export function checkContent(ctx: Ctx, contentId: string, ignoredKeys: string[] = []) {
  requirePerm(ctx, 'read');
  const c = getContent(ctx, contentId);
  const dict = loadDictionary(ctx);
  const doc = parseDocument(c.body);
  const r = detect(doc, dict.rules, { ignoredKeys: new Set(ignoredKeys) });
  return { contentId: c.id, version: c.version, enabledRules: dict.rules.filter((x) => x.enabled).length, ...summarize(doc, r.findings) };
}

/** Check arbitrary text (no persistence). */
export function checkText(ctx: Ctx, text: string) {
  requirePerm(ctx, 'read');
  const doc = parseDocument(String(text ?? '').slice(0, 200_000));
  const r = detect(doc, loadDictionary(ctx).rules);
  return summarize(doc, r.findings);
}

const ReplaceInput = z.object({
  mode: z.enum(['one', 'group']),
  key: z.string().max(500).optional(), // mode=one: finding key
  matched: z.string().max(1000).optional(), // mode=group
  correct: z.string().max(1000).optional(),
  ignoredKeys: z.array(z.string().max(500)).max(5000).optional(),
  expectedVersion: z.number().int().optional(),
});

/**
 * Apply replacement(s) to the draft and save it through updateContent (new version, re-review rules apply).
 * Uses the original algorithm: re-detect on the current body, then replaceFinding() in order so later hits shift.
 * Ignored and conflicting hits are never replaced.
 */
export function replaceInContent(ctx: Ctx, contentId: string, input: unknown) {
  requirePerm(ctx, 'write');
  const p = ReplaceInput.parse(input);
  const c = getContent(ctx, contentId);
  if (p.expectedVersion != null && p.expectedVersion !== c.version) throw conflict('他の編集が先に保存されています。再チェックしてください', { currentVersion: c.version });
  const doc = parseDocument(c.body);
  const r = detect(doc, loadDictionary(ctx).rules, { ignoredKeys: new Set(p.ignoredKeys ?? []) });
  let targets: Finding[];
  if (p.mode === 'one') {
    const f = r.findings.find((x) => findingKey(x) === p.key);
    if (!f) throw badRequest('検出箇所が見つかりません。再チェックしてください');
    targets = [f];
  } else {
    targets = r.findings.filter((x) => x.matched === p.matched && x.correct === p.correct && x.status === 'pending' && !x.conflict);
  }
  let done = 0;
  const failures: string[] = [];
  for (const f of targets) {
    const res = replaceFinding(doc, r.findings, f);
    if (res.ok) done++;
    else failures.push(res.reason ?? 'failed');
  }
  if (p.mode === 'one' && !done) throw badRequest(failures[0] ?? '置換できませんでした');
  let reReviewRequired = false;
  let version = c.version;
  if (done) {
    const u = updateContent(ctx, contentId, { body: serializeDocument(doc), expectedVersion: c.version });
    reReviewRequired = u.reReviewRequired;
    version = u.content.version;
    audit(ctx, 'notation.replaced', 'content', contentId, { count: done, mode: p.mode });
  }
  // Findings are returned with shifted positions so the client can keep its ignore keys in sync.
  return { replaced: done, failed: failures.length, version, reReviewRequired, ...summarize(doc, r.findings) };
}

/** Workspace scan: hit counts per content item (drafts / in review by default). */
export function scanContent(ctx: Ctx, q: { status?: string; limit?: number } = {}) {
  requirePerm(ctx, 'read');
  const rules = loadDictionary(ctx).rules;
  const statuses = q.status ? [q.status] : ['draft', 'needs_review', 'approved', 'scheduled'];
  const rows = ctx.app.db.all(
    `SELECT id, platform, title, body, status, updated_at FROM content_items WHERE workspace_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT ?`,
    ctx.workspaceId, ...statuses, Math.min(q.limit ?? 300, 2000),
  );
  const out = [];
  for (const row of rows) {
    const r = detect(parseDocument(row.body), rules);
    if (!r.findings.length) continue;
    out.push({ contentId: row.id, platform: row.platform, title: row.title, status: row.status, hits: r.findings.length, conflicts: r.findings.filter((f) => f.conflict).length, sample: [...new Set(r.findings.map((f) => `${f.matched} → ${f.correct}`))].slice(0, 5) });
  }
  return { scanned: rows.length, items: out };
}
