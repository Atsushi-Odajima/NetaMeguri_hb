import { z } from 'zod';
import { j } from '../db/db.js';
import { id, badRequest } from '../lib/util.js';
import { topKeywords, hashVector } from '../lib/text.js';
import { audit, getScoped, getSettings, nowIso, requirePerm, type Ctx } from './context.js';
import { compare, makeFingerprint, fingerprintSimilarity, type Fingerprint, type IdeaRecord, type SimilarityCandidate } from './fingerprint.js';
import { indexDoc, upsertEmbedding } from './index.js';
import { getSource } from './sources.js';

export const IDEA_STATUSES = ['new', 'used', 'reusable', 'overused', 'retired', 'needs_update'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export function ideaRow(r: any) {
  return {
    id: r.id, brandId: r.brand_id, coreIdea: r.core_idea, angle: r.angle, topic: r.topic, sourceIds: j<string[]>(r.source_ids, []),
    status: r.status as IdeaStatus, firstUsedAt: r.first_used_at, lastUsedAt: r.last_used_at, useCount: r.use_count,
    embeddingRef: r.embedding_ref, evergreen: !!r.evergreen, evergreenCategory: r.evergreen_category, seriesId: r.series_id,
    origin: r.origin, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export type Idea = ReturnType<typeof ideaRow>;

export const IdeaInput = z.object({
  coreIdea: z.string().min(3).max(1000),
  angle: z.string().max(40).optional().nullable(),
  topic: z.string().max(80).optional().nullable(),
  sourceIds: z.array(z.string()).max(50).default([]),
  brandId: z.string().optional().nullable(),
  evergreen: z.boolean().default(false),
  evergreenCategory: z.string().max(60).optional().nullable(),
  seriesId: z.string().optional().nullable(),
  origin: z.enum(['source', 'manual', 'import', 'inbox', 'recycle']).default('manual'),
});

export async function createIdea(ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'write');
  const i = IdeaInput.parse(input);
  for (const s of i.sourceIds) getScoped(ctx, 'sources', s); // tenant check
  const iid = id('idea');
  const topic = i.topic || topKeywords(i.coreIdea, 1)[0] || 'general';
  const similar = await similarIdeas(ctx, i.coreIdea, {});
  ctx.app.db.insert('ideas', {
    id: iid, workspace_id: ctx.workspaceId, brand_id: i.brandId, core_idea: i.coreIdea, angle: i.angle ?? 'insight', topic,
    source_ids: i.sourceIds, status: 'new', use_count: 0, fingerprint: JSON.stringify(makeFingerprint(`${i.coreIdea} ${topic}`)),
    evergreen: i.evergreen, evergreen_category: i.evergreenCategory, series_id: i.seriesId, origin: i.origin, created_at: nowIso(ctx), updated_at: nowIso(ctx),
  });
  indexDoc(ctx.app.db, ctx.workspaceId, 'idea', iid, topic, i.coreIdea);
  const eid = await upsertEmbedding(ctx, 'idea', iid, i.coreIdea);
  if (eid) ctx.app.db.update('ideas', iid, ctx.workspaceId, { embedding_ref: eid });
  audit(ctx, 'idea.created', 'idea', iid, { origin: i.origin });
  // Similar ideas are returned as candidates only. Nothing is merged or deleted automatically.
  return { idea: getIdea(ctx, iid), similar };
}

export function getIdea(ctx: Ctx, iid: string) {
  requirePerm(ctx, 'read');
  const r = getScoped(ctx, 'ideas', iid);
  const uses = ctx.app.db.all('SELECT platform, used_at, content_id FROM idea_uses WHERE workspace_id = ? AND idea_id = ? ORDER BY used_at DESC', ctx.workspaceId, iid);
  return { ...ideaRow(r), uses };
}

/** Extract ideas from a source's analysis. Similar existing ideas are reported, never auto-merged. */
export async function extractIdeas(ctx: Ctx, sid: string, opts: { max?: number } = {}) {
  requirePerm(ctx, 'write');
  const src = getSource(ctx, sid);
  if (!src.analysis) throw badRequest('Sourceがまだ解析されていません（本文またはTranscriptが必要です）');
  const created: { idea: Idea; similar: SimilarityCandidate[] }[] = [];
  for (const ex of src.analysis.ideas.slice(0, opts.max ?? 12)) {
    const r = await createIdea(ctx, { coreIdea: ex.coreIdea, angle: ex.angle, topic: ex.topic, sourceIds: [sid], brandId: src.brandId, origin: 'source', evergreen: src.evergreen, evergreenCategory: src.evergreenCategory });
    created.push(r);
  }
  ctx.app.db.update('sources', sid, ctx.workspaceId, { status: 'ideas_extracted' });
  return created;
}

export function listIdeas(ctx: Ctx, q: { status?: string; topic?: string; sourceId?: string; evergreen?: boolean; limit?: number } = {}) {
  requirePerm(ctx, 'read');
  const rows = ctx.app.db.all(
    `SELECT * FROM ideas WHERE workspace_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR topic = ?) AND (? IS NULL OR evergreen = ?)
     AND (? IS NULL OR source_ids LIKE ?) ORDER BY updated_at DESC LIMIT ?`,
    ctx.workspaceId, q.status ?? null, q.status ?? null, q.topic ?? null, q.topic ?? null, q.evergreen == null ? null : 1, q.evergreen ? 1 : 0,
    q.sourceId ?? null, q.sourceId ? `%"${q.sourceId}"%` : null, Math.min(q.limit ?? 200, 1000),
  );
  return rows.map(ideaRow);
}

function lastPlatformOf(ctx: Ctx, ideaId: string): string | null {
  return ctx.app.db.get('SELECT platform FROM idea_uses WHERE workspace_id = ? AND idea_id = ? ORDER BY used_at DESC LIMIT 1', ctx.workspaceId, ideaId)?.platform ?? null;
}

/** Load candidate pool. For large workspaces pre-filter by full-text on keywords. */
function candidatePool(ctx: Ctx, text: string): IdeaRecord[] {
  const db = ctx.app.db;
  const count = db.get<{ c: number }>('SELECT COUNT(*) c FROM ideas WHERE workspace_id = ?', ctx.workspaceId)!.c;
  let rows: any[];
  if (count <= 5000) {
    rows = db.all('SELECT id, core_idea, angle, topic, fingerprint, last_used_at, status FROM ideas WHERE workspace_id = ?', ctx.workspaceId);
  } else {
    const kws = topKeywords(text, 6).filter((k) => [...k].length >= 3).map((k) => `"${k.replace(/"/g, '')}"`);
    if (!kws.length) return [];
    rows = db.all(
      `SELECT i.id, i.core_idea, i.angle, i.topic, i.fingerprint, i.last_used_at, i.status FROM search_fts f JOIN ideas i ON i.id = f.ref_id
       WHERE search_fts MATCH ? AND f.workspace_id = ? AND f.ref_type = 'idea' LIMIT 3000`,
      kws.join(' OR '), ctx.workspaceId,
    );
  }
  return rows.map((r) => ({
    id: r.id, coreIdea: r.core_idea, angle: r.angle, topic: r.topic, fingerprint: JSON.parse(r.fingerprint) as Fingerprint,
    lastUsedAt: r.last_used_at, lastPlatform: null, status: r.status, vector: null,
  }));
}

/** Attach stored local vectors only to plausible candidates (cheap lexical pre-filter first). */
function attachVectors(ctx: Ctx, pool: IdeaRecord[]) {
  if (!pool.length) return;
  const byId = new Map(pool.map((p) => [p.id, p]));
  for (const e of ctx.app.db.all("SELECT ref_id, vector FROM embeddings WHERE workspace_id = ? AND ref_type = 'idea' AND model = 'local-hash-v1' AND ref_id IN (SELECT value FROM json_each(?))", ctx.workspaceId, JSON.stringify([...byId.keys()]))) {
    byId.get(e.ref_id)!.vector = JSON.parse(e.vector);
  }
}

export async function similarIdeas(ctx: Ctx, text: string, opts: { excludeIds?: string[]; limit?: number }) {
  requirePerm(ctx, 'read');
  const s = getSettings(ctx.app.db, ctx.workspaceId);
  const fp = makeFingerprint(text);
  const pool = candidatePool(ctx, text)
    .map((p) => ({ p, lex: fingerprintSimilarity(fp, p.fingerprint) }))
    .filter((x) => x.lex >= 0.12)
    .sort((a, b) => b.lex - a.lex)
    .slice(0, 400)
    .map((x) => x.p);
  const vector = s.embeddingProvider === 'off' ? null : hashVector(text);
  if (vector) attachVectors(ctx, pool);
  return compare(text, pool, { now: ctx.app.clock.now(), recentlyUsedDays: s.reuseRules.recentlyUsedDays, excludeIds: opts.excludeIds, vector, limit: opts.limit, platformOf: (iid) => lastPlatformOf(ctx, iid) });
}

export function recomputeIdeaStatus(ctx: Ctx, ideaId: string) {
  const r = getScoped(ctx, 'ideas', ideaId);
  if (r.status === 'retired' || r.status === 'needs_update') return r.status;
  const rules = getSettings(ctx.app.db, ctx.workspaceId).reuseRules;
  let status: IdeaStatus = 'new';
  if (r.use_count >= rules.overusedThreshold) status = 'overused';
  else if (r.use_count > 0) {
    const days = (ctx.app.clock.now().getTime() - new Date(r.last_used_at).getTime()) / 86400_000;
    status = days <= rules.recentlyUsedDays ? 'used' : 'reusable';
  }
  if (status !== r.status) ctx.app.db.update('ideas', ideaId, ctx.workspaceId, { status, updated_at: nowIso(ctx) });
  return status;
}

export function recordIdeaUse(ctx: Ctx, ideaId: string, contentId: string | null, platform: string, at: string) {
  const r = getScoped(ctx, 'ideas', ideaId);
  ctx.app.db.insert('idea_uses', { id: id('use'), workspace_id: ctx.workspaceId, idea_id: ideaId, content_id: contentId, platform, used_at: at });
  const first = r.first_used_at && r.first_used_at < at ? r.first_used_at : at;
  const last = r.last_used_at && r.last_used_at > at ? r.last_used_at : at;
  ctx.app.db.update('ideas', ideaId, ctx.workspaceId, { use_count: r.use_count + 1, first_used_at: first, last_used_at: last, updated_at: nowIso(ctx) });
  recomputeIdeaStatus(ctx, ideaId);
}

export function setIdeaStatus(ctx: Ctx, ideaId: string, status: IdeaStatus, note?: string) {
  requirePerm(ctx, 'write');
  if (!IDEA_STATUSES.includes(status)) throw badRequest('invalid status');
  getScoped(ctx, 'ideas', ideaId);
  ctx.app.db.update('ideas', ideaId, ctx.workspaceId, { status, updated_at: nowIso(ctx) });
  audit(ctx, 'idea.status_changed', 'idea', ideaId, { status, note });
  if (status !== 'retired' && status !== 'needs_update') recomputeIdeaStatus(ctx, ideaId);
  return getIdea(ctx, ideaId);
}

export function updateIdea(ctx: Ctx, ideaId: string, patch: { coreIdea?: string; angle?: string; topic?: string; evergreen?: boolean; seriesId?: string | null }) {
  requirePerm(ctx, 'write');
  const r = getScoped(ctx, 'ideas', ideaId);
  const core = patch.coreIdea ?? r.core_idea;
  const topic = patch.topic ?? r.topic;
  ctx.app.db.update('ideas', ideaId, ctx.workspaceId, {
    core_idea: core, angle: patch.angle ?? r.angle, topic, evergreen: patch.evergreen ?? !!r.evergreen,
    series_id: patch.seriesId !== undefined ? patch.seriesId : r.series_id, fingerprint: JSON.stringify(makeFingerprint(`${core} ${topic}`)), updated_at: nowIso(ctx),
  });
  indexDoc(ctx.app.db, ctx.workspaceId, 'idea', ideaId, topic, core);
  return getIdea(ctx, ideaId);
}

/** Idea Memory buckets for the dashboard / strategist. */
export function ideaMemory(ctx: Ctx) {
  requirePerm(ctx, 'read');
  const rules = getSettings(ctx.app.db, ctx.workspaceId).reuseRules;
  const all = listIdeas(ctx, { limit: 1000 });
  for (const i of all) if (i.useCount > 0 && i.status !== 'retired' && i.status !== 'needs_update') i.status = recomputeIdeaStatus(ctx, i.id) as IdeaStatus;
  const now = ctx.app.clock.now().getTime();
  const recent = (i: Idea) => i.lastUsedAt && (now - new Date(i.lastUsedAt).getTime()) / 86400_000 <= rules.recentlyUsedDays;
  return {
    unused: all.filter((i) => i.useCount === 0 && i.status === 'new'),
    usedOnce: all.filter((i) => i.useCount === 1),
    reusable: all.filter((i) => i.status === 'reusable'),
    recentlyUsed: all.filter((i) => recent(i)),
    overused: all.filter((i) => i.status === 'overused'),
    needsUpdate: all.filter((i) => i.status === 'needs_update'),
    retired: all.filter((i) => i.status === 'retired'),
  };
}
