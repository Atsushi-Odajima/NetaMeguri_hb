import { z } from 'zod';
import { j } from '../db/db.js';
import { id, badRequest, conflict } from '../lib/util.js';
import { transform, supportingSentences, ANGLE_LABELS, type Angle, type Segment, type SourceLite } from '../ai/local.js';
import { PACK_KINDS, PLATFORMS, isPlatform, type FormatId, type PlatformId } from './platforms.js';
import { audit, getScoped, getSettings, nowIso, requirePerm, type Ctx } from './context.js';
import { brandForGuard, brandLite, defaultBrand, getBrand, type Brand } from './brand.js';
import { extractIdeas, getIdea, listIdeas, similarIdeas, type Idea } from './ideas.js';
import { getSegments, sourceLite, sourcesAllowAI } from './sources.js';
import { brandGuard, freshnessCheck } from './guards.js';
import { checkClaims, listClaims } from './claims.js';
import { indexDoc } from './index.js';
import { notify } from './notifications.js';

export const CONTENT_STATUSES = ['draft', 'needs_review', 'approved', 'scheduled', 'published', 'failed', 'archived', 'recycling_candidate'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export function contentRow(r: any) {
  return {
    id: r.id, packId: r.pack_id, ideaId: r.idea_id, sourceIds: j<string[]>(r.source_ids, []), platform: r.platform as PlatformId, format: r.format as FormatId,
    title: r.title, body: r.body, structured: j<Record<string, any> | null>(r.structured, null), mediaRefs: j<string[]>(r.media_refs, []),
    status: r.status as ContentStatus, brandId: r.brand_id, campaignId: r.campaign_id, seriesId: r.series_id, scheduledAt: r.scheduled_at,
    publishedAt: r.published_at, publishedVia: r.published_via as 'user_marked' | 'api_confirmed' | 'imported' | null, externalPostId: r.external_post_id,
    externalUrl: r.external_url, createdBy: r.created_by, reviewedBy: r.reviewed_by, humanEdited: !!r.human_edited, aiSuggestion: j(r.ai_suggestion, null),
    version: r.version, approvedVersion: r.approved_version, recycleState: r.recycle_state, locale: r.locale, parentContentId: r.parent_content_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export type ContentItem = ReturnType<typeof contentRow>;

export function getContent(ctx: Ctx, cid: string) {
  requirePerm(ctx, 'read');
  return contentRow(getScoped(ctx, 'content_items', cid));
}

export function listContent(ctx: Ctx, q: { status?: string; platform?: string; campaignId?: string; packId?: string; ideaId?: string; from?: string; to?: string; limit?: number } = {}) {
  requirePerm(ctx, 'read');
  return ctx.app.db
    .all(
      `SELECT * FROM content_items WHERE workspace_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR platform = ?) AND (? IS NULL OR campaign_id = ?)
       AND (? IS NULL OR pack_id = ?) AND (? IS NULL OR idea_id = ?)
       AND (? IS NULL OR COALESCE(scheduled_at, published_at, created_at) >= ?) AND (? IS NULL OR COALESCE(scheduled_at, published_at, created_at) < ?)
       ORDER BY COALESCE(scheduled_at, published_at, updated_at) DESC LIMIT ?`,
      ctx.workspaceId, q.status ?? null, q.status ?? null, q.platform ?? null, q.platform ?? null, q.campaignId ?? null, q.campaignId ?? null,
      q.packId ?? null, q.packId ?? null, q.ideaId ?? null, q.ideaId ?? null, q.from ?? null, q.from ?? null, q.to ?? null, q.to ?? null, Math.min(q.limit ?? 200, 2000),
    )
    .map(contentRow);
}

// ---------------------------------------------------------------- generation

interface GenInput {
  idea: Idea | { id?: string; coreIdea: string; angle: string; topic: string; sourceIds: string[]; startMs?: number; endMs?: number };
  platform: PlatformId;
  format: FormatId;
  brand: Brand | null;
  variant?: number;
  angleOverride?: string;
  locale?: string;
  brief?: any;
  extraFacts?: string[];
}

function loadSources(ctx: Ctx, ids: string[]) {
  const rows = ids.map((s) => ctx.app.db.get('SELECT * FROM sources WHERE id = ? AND workspace_id = ?', s, ctx.workspaceId)).filter(Boolean) as any[];
  return rows;
}

/** Produce a platform-specific draft. Local extractive engine first; external AI may polish it (fact-guarded). */
export async function generateDraft(ctx: Ctx, g: GenInput) {
  const srcRows = loadSources(ctx, g.idea.sourceIds);
  const sources: SourceLite[] = srcRows.map(sourceLite);
  const sourceText = srcRows.map((s) => s.text ?? '').join('\n');
  const segments: Segment[] = srcRows.length ? getSegments(ctx, srcRows[0].id) : [];
  const idea = { ...g.idea, angle: g.angleOverride ?? g.idea.angle };
  const ex = srcRows[0]?.analysis ? j<any>(srcRows[0].analysis, null)?.ideas?.find((x: any) => x.coreIdea === g.idea.coreIdea) : null;
  const local = transform({
    idea: { coreIdea: idea.coreIdea, angle: idea.angle as Angle, topic: idea.topic, startMs: ex?.startMs, endMs: ex?.endMs },
    supporting: sourceText ? supportingSentences(sourceText, idea) : [],
    platform: g.platform, format: g.format, brand: brandLite(g.brand, g.locale), sources, variant: g.variant, segments,
  });
  const p = PLATFORMS[g.platform];
  const allowed = [sourceText, idea.coreIdea, ...(g.extraFacts ?? []), ...listClaims(ctx).map((c) => `${c.label} ${c.value}`)];
  const eligible = (g.brand?.aiEligible ?? true) && srcRows.every((s) => !!s.ai_eligible);
  const ai = await ctx.app.ai.run(
    ctx.workspaceId,
    {
      task: 'platform_draft',
      system: `You rewrite social media drafts for ${p.label}. Max ${p.maxLength} characters. Brand: ${g.brand?.name ?? ''}. Voice: ${g.brand?.voiceSummary ?? ''}. Tone: ${g.brand?.tone ?? ''}. Banned terms: ${(g.brand?.bannedTerms ?? []).join(', ')}. Angle: ${ANGLE_LABELS[idea.angle as Angle] ?? idea.angle}. Language: ${g.locale ?? g.brand?.language ?? 'ja'}.`,
      instruction: `Improve this draft for ${p.label} while keeping every fact traceable to the source data. Draft:\n${local.body}${g.brief ? `\nBrief: ${JSON.stringify(g.brief)}` : ''}`,
      data: sourceText.slice(0, 12000),
      maxTokens: 1500,
    },
    { eligible, allowed, fallback: () => local.body },
  );
  const notes = [...local.notes];
  if (ai.removed.length) notes.push(`AI出力から根拠のない主張を${ai.removed.length}件除外しました`);
  return { title: local.title, body: ai.text, structured: local.structured, notes, generator: ai.usedProvider === 'local' ? 'local-extractive-v1' : ai.usedProvider, removed: ai.removed };
}

function insertContent(ctx: Ctx, row: Record<string, any>, authorType: 'ai' | 'human' | 'import', note?: string) {
  const cid = id('cnt');
  const now = nowIso(ctx);
  ctx.app.db.insert('content_items', { id: cid, workspace_id: ctx.workspaceId, version: 1, created_by: ctx.userId, created_at: now, updated_at: now, ...row });
  ctx.app.db.insert('content_versions', { id: id('ver'), workspace_id: ctx.workspaceId, content_id: cid, version: 1, title: row.title, body: row.body, author_type: authorType, author_id: ctx.userId, note, created_at: now });
  indexDoc(ctx.app.db, ctx.workspaceId, 'content', cid, row.title ?? '', row.body);
  return cid;
}

export const PackInput = z.object({
  sourceIds: z.array(z.string()).min(1).max(20),
  brandId: z.string().optional().nullable(),
  campaignId: z.string().optional().nullable(),
  briefId: z.string().optional().nullable(),
  counts: z.record(z.string(), z.number().int().min(0).max(50)).optional(),
  locale: z.string().max(10).optional(),
});

/** Content Pack: 1+ Source → many ContentItems, each linked to Idea + Source. */
export async function createPack(ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'write');
  const p = PackInput.parse(input);
  for (const s of p.sourceIds) getScoped(ctx, 'sources', s);
  const brand = p.brandId ? getBrand(ctx, p.brandId) : defaultBrand(ctx);
  if (p.campaignId) getScoped(ctx, 'campaigns', p.campaignId);
  const brief = p.briefId ? getScoped(ctx, 'briefs', p.briefId) : null;
  const counts = { ...getSettings(ctx.app.db, ctx.workspaceId).packDefaults, ...(p.counts ?? {}) };
  for (const k of Object.keys(counts)) if (!PACK_KINDS[k]) throw badRequest(`unknown pack kind: ${k}`);

  let ideas: Idea[] = [];
  for (const sid of p.sourceIds) {
    let si = listIdeas(ctx, { sourceId: sid, limit: 50 }).filter((i) => i.status !== 'retired');
    if (!si.length) si = (await extractIdeas(ctx, sid)).map((x) => x.idea);
    ideas.push(...si);
  }
  if (!ideas.length) throw badRequest('Ideaを抽出できませんでした。Sourceの本文/Transcriptを確認してください');
  ideas = ideas.filter((i) => i.status !== 'needs_update').concat(ideas.filter((i) => i.status === 'needs_update'));

  const packId = id('pack');
  ctx.app.db.insert('content_packs', { id: packId, workspace_id: ctx.workspaceId, source_ids: p.sourceIds, brand_id: brand?.id, campaign_id: p.campaignId, brief_id: p.briefId, generation_config: { counts, locale: p.locale }, status: 'draft', generator: 'pending', created_by: ctx.userId, created_at: nowIso(ctx) });
  const itemIds: string[] = [];
  let generator = 'local-extractive-v1';
  for (const [kind, n] of Object.entries(counts)) {
    const k = PACK_KINDS[kind];
    const preferred = ideas.filter((i) => (k.format === 'carousel' ? ['how_to', 'checklist', 'comparison'].includes(i.angle) : true));
    const pool = preferred.length ? preferred : ideas;
    for (let i = 0; i < n; i++) {
      const idea = pool[i % pool.length];
      const variant = Math.floor(i / pool.length);
      const d = await generateDraft(ctx, { idea, platform: k.platform, format: k.format, brand, variant, locale: p.locale, brief });
      generator = d.generator;
      itemIds.push(insertContent(ctx, {
        pack_id: packId, idea_id: idea.id, source_ids: idea.sourceIds.length ? idea.sourceIds : p.sourceIds, platform: k.platform, format: k.format,
        title: d.title, body: d.body, structured: d.structured ? { ...d.structured, packKind: kind, notes: d.notes } : { packKind: kind, notes: d.notes },
        status: 'draft', brand_id: brand?.id, campaign_id: p.campaignId, locale: p.locale ?? null,
      }, 'ai', `pack:${kind}`));
    }
  }
  ctx.app.db.update('content_packs', packId, ctx.workspaceId, { generator });
  audit(ctx, 'pack.created', 'content_pack', packId, { items: itemIds.length, generator });
  return getPack(ctx, packId);
}

export function getPack(ctx: Ctx, packId: string) {
  requirePerm(ctx, 'read');
  const r = getScoped(ctx, 'content_packs', packId);
  const items = listContent(ctx, { packId, limit: 500 });
  const byKind: Record<string, number> = {};
  for (const it of items) {
    const k = (it.structured as any)?.packKind ?? it.platform;
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  return { id: r.id, sourceIds: j<string[]>(r.source_ids, []), brandId: r.brand_id, campaignId: r.campaign_id, briefId: r.brief_id, generationConfig: j(r.generation_config, {}), status: r.status, generator: r.generator, createdAt: r.created_at, byKind, items };
}
export function listPacks(ctx: Ctx) {
  requirePerm(ctx, 'read');
  return ctx.app.db.all('SELECT p.*, (SELECT COUNT(*) FROM content_items c WHERE c.pack_id = p.id) AS item_count FROM content_packs p WHERE p.workspace_id = ? ORDER BY created_at DESC LIMIT 100', ctx.workspaceId).map((r) => ({ id: r.id, sourceIds: j(r.source_ids, []), status: r.status, generator: r.generator, itemCount: r.item_count, createdAt: r.created_at, campaignId: r.campaign_id }));
}

/** Create a single draft from an idea for a platform (used by MCP draft_for_platform, Strategist, recycling). */
export async function draftForPlatform(ctx: Ctx, input: { ideaId: string; platform: string; format?: string; angle?: string; campaignId?: string | null; parentContentId?: string | null; variant?: number; extraFacts?: string[]; locale?: string }) {
  requirePerm(ctx, 'write');
  if (!isPlatform(input.platform)) throw badRequest('unknown platform');
  const idea = getIdea(ctx, input.ideaId);
  const format = (input.format as FormatId) ?? PLATFORMS[input.platform].formats[0];
  if (!PLATFORMS[input.platform].formats.includes(format)) throw badRequest(`${input.platform}は${format}形式に対応していません`);
  const brand = idea.brandId ? getBrand(ctx, idea.brandId) : defaultBrand(ctx);
  const d = await generateDraft(ctx, { idea, platform: input.platform, format, brand, angleOverride: input.angle, variant: input.variant, extraFacts: input.extraFacts, locale: input.locale });
  const cid = insertContent(ctx, {
    idea_id: idea.id, source_ids: idea.sourceIds, platform: input.platform, format, title: d.title, body: d.body,
    structured: { ...(d.structured ?? {}), notes: d.notes, angle: input.angle ?? idea.angle }, status: 'draft', brand_id: brand?.id,
    campaign_id: input.campaignId ?? null, parent_content_id: input.parentContentId ?? null, locale: input.locale ?? null,
  }, 'ai', input.angle ? `angle:${input.angle}` : 'draft');
  audit(ctx, 'content.drafted', 'content', cid, { platform: input.platform, generator: d.generator });
  return { content: getContent(ctx, cid), checks: await runChecks(ctx, cid), notes: d.notes };
}

/** Same idea → another platform. Keeps idea/source relation and parent link. */
export async function transformContent(ctx: Ctx, cid: string, platform: string, format?: string) {
  const c = getContent(ctx, cid);
  if (!c.ideaId) throw badRequest('Ideaに紐づかないContentは変換できません');
  return draftForPlatform(ctx, { ideaId: c.ideaId, platform, format, campaignId: c.campaignId, parentContentId: c.id });
}

// ---------------------------------------------------------------- checks

export async function runChecks(ctx: Ctx, cid: string, opts: { skipSimilarity?: boolean } = {}) {
  const c = getContent(ctx, cid);
  const brand = c.brandId ? getBrand(ctx, c.brandId) : defaultBrand(ctx);
  const claims = listClaims(ctx);
  const text = `${c.title ?? ''}\n${c.body}`;
  const guard = brandGuard(c.body, c.platform, brandForGuard(brand, c.locale ?? undefined), { registeredClaimValues: claims.map((x) => x.value) });
  const similar = opts.skipSimilarity ? [] : await similarIdeas(ctx, text, { excludeIds: c.ideaId ? [c.ideaId] : [] });
  const rules = getSettings(ctx.app.db, ctx.workspaceId).reuseRules;
  const reuse: { rule: string; message: string; severity: 'warn' | 'block' }[] = [];
  let idea: ReturnType<typeof getIdea> | null = null;
  if (c.ideaId) {
    idea = getIdea(ctx, c.ideaId);
    const now = ctx.app.clock.now().getTime();
    const samePlat = idea.uses.find((u: any) => u.platform === c.platform && u.content_id !== c.id);
    if (samePlat) {
      const days = Math.floor((now - new Date(samePlat.used_at).getTime()) / 86400_000);
      if (days <= rules.samePlatformWarnDays) reuse.push({ rule: 'same_platform_window', severity: 'warn', message: `このIdeaは${days}日前に同じ${PLATFORMS[c.platform].label}で使用済みです（${rules.samePlatformWarnDays}日以内）` });
    }
    const anyUse = idea.uses.find((u: any) => u.content_id !== c.id);
    if (anyUse) {
      const days = Math.floor((now - new Date(anyUse.used_at).getTime()) / 86400_000);
      if (days <= rules.recentlyUsedDays && !samePlat) reuse.push({ rule: 'recently_used', severity: 'warn', message: `このIdeaは${days}日前に${PLATFORMS[anyUse.platform as PlatformId]?.label ?? anyUse.platform}で使用されています（Recently Used）` });
    }
    if (idea.status === 'needs_update') reuse.push({ rule: 'needs_update', severity: 'block', message: 'IdeaがNeeds Updateです。内容を更新するまで自動投稿できません' });
    if (idea.status === 'overused') reuse.push({ rule: 'overused', severity: 'warn', message: `このIdeaは${idea.useCount}回使用されています（Overused）` });
    if (idea.status === 'retired') reuse.push({ rule: 'retired', severity: 'warn', message: 'このIdeaはRetiredです' });
  }
  const srcRows = loadSources(ctx, c.sourceIds);
  const origin = srcRows.map((s) => s.published_at ?? s.imported_at).sort()[0] ?? (c.parentContentId ? getContent(ctx, c.parentContentId).publishedAt : null);
  const freshness = freshnessCheck(c.body, { originalDate: origin, now: ctx.app.clock.now(), staleAfterDays: 30 });
  const claimIssues = checkClaims(ctx, text);
  const blocking = guard.some((g) => g.severity === 'block') || reuse.some((r) => r.severity === 'block') || claimIssues.some((x) => x.severity === 'block');
  return { brandGuard: guard, similar, reuse, freshness, claims: claimIssues, blocking, sourceRefs: srcRows.map(sourceLite), checkedAt: nowIso(ctx) };
}

// ---------------------------------------------------------------- editor

export function listVersions(ctx: Ctx, cid: string) {
  requirePerm(ctx, 'read');
  getScoped(ctx, 'content_items', cid);
  return ctx.app.db.all('SELECT version, title, body, author_type, author_id, note, created_at FROM content_versions WHERE workspace_id = ? AND content_id = ? ORDER BY version DESC', ctx.workspaceId, cid);
}

/**
 * Human edit. Optimistic concurrency via expectedVersion. Editing an approved/scheduled item
 * sends it back to review when reReviewOnEditAfterApproval is on (default).
 */
export function updateContent(ctx: Ctx, cid: string, input: { title?: string | null; body?: string; structured?: any; expectedVersion?: number; autosave?: boolean; mediaRefs?: string[]; seriesId?: string | null; campaignId?: string | null }) {
  requirePerm(ctx, 'write');
  const c = getContent(ctx, cid);
  if (c.status === 'published') throw badRequest('公開済みのContentは編集できません。再利用（Recycling）で新しいDraftを作成してください');
  if (input.expectedVersion != null && input.expectedVersion !== c.version) throw conflict('他の編集が先に保存されています。最新版を確認してください', { currentVersion: c.version });
  const now = nowIso(ctx);
  const bodyChanged = input.body != null && input.body !== c.body;
  const titleChanged = input.title !== undefined && input.title !== c.title;
  const patch: Record<string, any> = { updated_at: now };
  if (input.structured !== undefined) patch.structured = input.structured;
  if (input.mediaRefs) patch.media_refs = input.mediaRefs;
  if (input.seriesId !== undefined) patch.series_id = input.seriesId;
  if (input.campaignId !== undefined) patch.campaign_id = input.campaignId;
  let newVersion = c.version;
  let reReview = false;
  if (bodyChanged || titleChanged) {
    const last = ctx.app.db.get('SELECT * FROM content_versions WHERE workspace_id = ? AND content_id = ? ORDER BY version DESC LIMIT 1', ctx.workspaceId, cid)!;
    const coalesce = input.autosave && last.author_type === 'human' && last.author_id === ctx.userId && ctx.app.clock.now().getTime() - new Date(last.created_at).getTime() < 120_000 && c.approvedVersion !== c.version;
    if (coalesce) {
      ctx.app.db.run('UPDATE content_versions SET title = ?, body = ?, created_at = ? WHERE id = ?', input.title ?? c.title, input.body ?? c.body, now, last.id);
    } else {
      newVersion = c.version + 1;
      ctx.app.db.insert('content_versions', { id: id('ver'), workspace_id: ctx.workspaceId, content_id: cid, version: newVersion, title: input.title ?? c.title, body: input.body ?? c.body, author_type: 'human', author_id: ctx.userId, note: input.autosave ? 'autosave' : null, created_at: now });
    }
    Object.assign(patch, { title: input.title !== undefined ? input.title : c.title, body: input.body ?? c.body, human_edited: 1, version: newVersion });
    if ((c.status === 'approved' || c.status === 'scheduled') && getSettings(ctx.app.db, ctx.workspaceId).reReviewOnEditAfterApproval) {
      patch.status = 'needs_review';
      reReview = true;
      ctx.app.db.run("UPDATE publish_jobs SET status = 'cancelled', last_error = 'content edited after approval' WHERE workspace_id = ? AND content_id = ? AND status = 'queued'", ctx.workspaceId, cid);
      ctx.app.db.insert('approvals', { id: id('apv'), workspace_id: ctx.workspaceId, content_id: cid, action: 'invalidated_by_edit', actor_id: ctx.userId, version: newVersion, comment: null, created_at: now });
    }
  }
  ctx.app.db.update('content_items', cid, ctx.workspaceId, patch);
  if (bodyChanged || titleChanged) indexDoc(ctx.app.db, ctx.workspaceId, 'content', cid, patch.title ?? '', patch.body);
  if (reReview) audit(ctx, 'content.re_review_required', 'content', cid, { version: newVersion });
  return { content: getContent(ctx, cid), reReviewRequired: reReview };
}

/** AI regenerate never overwrites a human-edited body: result is stored as a suggestion instead. */
export async function regenerate(ctx: Ctx, cid: string, opts: { angle?: string; variant?: number } = {}) {
  requirePerm(ctx, 'write');
  const c = getContent(ctx, cid);
  if (!c.ideaId) throw badRequest('Ideaに紐づかないContentは再生成できません');
  const idea = getIdea(ctx, c.ideaId);
  const brand = c.brandId ? getBrand(ctx, c.brandId) : defaultBrand(ctx);
  const d = await generateDraft(ctx, { idea, platform: c.platform, format: c.format, brand, angleOverride: opts.angle, variant: opts.variant ?? c.version, locale: c.locale ?? undefined });
  const now = nowIso(ctx);
  if (c.humanEdited || c.status === 'approved' || c.status === 'scheduled') {
    ctx.app.db.update('content_items', cid, ctx.workspaceId, { ai_suggestion: { title: d.title, body: d.body, createdAt: now, generator: d.generator }, updated_at: now });
    return { content: getContent(ctx, cid), applied: false, message: '人間の編集を保護するため、AI案は「提案」として保存しました（本文は変更していません）' };
  }
  const v = c.version + 1;
  ctx.app.db.insert('content_versions', { id: id('ver'), workspace_id: ctx.workspaceId, content_id: cid, version: v, title: d.title, body: d.body, author_type: 'ai', author_id: ctx.userId, note: 'regenerate', created_at: now });
  ctx.app.db.update('content_items', cid, ctx.workspaceId, { title: d.title, body: d.body, structured: { ...(c.structured ?? {}), ...(d.structured ?? {}), notes: d.notes }, version: v, updated_at: now });
  return { content: getContent(ctx, cid), applied: true, message: 'AIで再生成しました' };
}

export function acceptSuggestion(ctx: Ctx, cid: string) {
  const c = getContent(ctx, cid);
  if (!c.aiSuggestion) throw badRequest('AI提案はありません');
  const s = c.aiSuggestion as any;
  const r = updateContent(ctx, cid, { title: s.title, body: s.body });
  ctx.app.db.update('content_items', cid, ctx.workspaceId, { ai_suggestion: null });
  return { ...r, content: getContent(ctx, cid) };
}

export function restoreVersion(ctx: Ctx, cid: string, version: number) {
  const v = ctx.app.db.get('SELECT * FROM content_versions WHERE workspace_id = ? AND content_id = ? AND version = ?', ctx.workspaceId, cid, version);
  if (!v) throw badRequest('version not found');
  return updateContent(ctx, cid, { title: v.title, body: v.body });
}

// ---------------------------------------------------------------- approval workflow

export function requestReview(ctx: Ctx, cid: string, comment?: string) {
  requirePerm(ctx, 'write');
  const c = getContent(ctx, cid);
  if (!['draft', 'needs_review', 'failed', 'recycling_candidate'].includes(c.status)) throw badRequest(`この状態(${c.status})からはレビュー依頼できません`);
  ctx.app.db.update('content_items', cid, ctx.workspaceId, { status: 'needs_review', updated_at: nowIso(ctx) });
  ctx.app.db.insert('approvals', { id: id('apv'), workspace_id: ctx.workspaceId, content_id: cid, action: 'review_requested', actor_id: ctx.userId, version: c.version, comment, created_at: nowIso(ctx) });
  notify(ctx, { kind: 'review_requested', message: `レビュー依頼: ${PLATFORMS[c.platform].label}「${(c.title ?? c.body).slice(0, 30)}」`, targetType: 'content', targetId: cid, dedupeKey: `review:${cid}:${c.version}` });
  audit(ctx, 'content.review_requested', 'content', cid, { version: c.version });
  return getContent(ctx, cid);
}

export async function approve(ctx: Ctx, cid: string, comment?: string) {
  requirePerm(ctx, 'review');
  const c = getContent(ctx, cid);
  if (c.status !== 'needs_review' && c.status !== 'draft') throw badRequest(`この状態(${c.status})は承認できません`);
  const checks = await runChecks(ctx, cid);
  if (checks.blocking) throw badRequest('ブロック項目（禁止表現/古いClaim/Needs Update等）があるため承認できません', checks);
  ctx.app.db.update('content_items', cid, ctx.workspaceId, { status: 'approved', approved_version: c.version, reviewed_by: ctx.userId, updated_at: nowIso(ctx) });
  ctx.app.db.insert('approvals', { id: id('apv'), workspace_id: ctx.workspaceId, content_id: cid, action: 'approved', actor_id: ctx.userId, version: c.version, comment, created_at: nowIso(ctx) });
  audit(ctx, 'content.approved', 'content', cid, { version: c.version });
  return getContent(ctx, cid);
}

export function requestChanges(ctx: Ctx, cid: string, comment: string) {
  requirePerm(ctx, 'review');
  const c = getContent(ctx, cid);
  ctx.app.db.update('content_items', cid, ctx.workspaceId, { status: 'draft', updated_at: nowIso(ctx) });
  ctx.app.db.insert('approvals', { id: id('apv'), workspace_id: ctx.workspaceId, content_id: cid, action: 'changes_requested', actor_id: ctx.userId, version: c.version, comment, created_at: nowIso(ctx) });
  addComment(ctx, cid, comment);
  notify(ctx, { kind: 'changes_requested', message: `修正依頼: ${comment.slice(0, 50)}`, targetType: 'content', targetId: cid, userId: c.createdBy });
  audit(ctx, 'content.changes_requested', 'content', cid, { version: c.version });
  return getContent(ctx, cid);
}

export function approvalHistory(ctx: Ctx, cid: string) {
  requirePerm(ctx, 'read');
  getScoped(ctx, 'content_items', cid);
  return ctx.app.db.all('SELECT a.*, u.name AS actor_name FROM approvals a LEFT JOIN users u ON u.id = a.actor_id WHERE a.workspace_id = ? AND a.content_id = ? ORDER BY a.created_at', ctx.workspaceId, cid);
}

export function addComment(ctx: Ctx, cid: string, body: string) {
  requirePerm(ctx, 'comment');
  getScoped(ctx, 'content_items', cid);
  if (!body.trim()) throw badRequest('empty comment');
  ctx.app.db.insert('comments', { id: id('cmt'), workspace_id: ctx.workspaceId, content_id: cid, user_id: ctx.userId, body: body.slice(0, 5000), created_at: nowIso(ctx) });
  return listComments(ctx, cid);
}
export function listComments(ctx: Ctx, cid: string) {
  return ctx.app.db.all('SELECT c.*, u.name AS user_name FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.workspace_id = ? AND c.content_id = ? ORDER BY c.created_at', ctx.workspaceId, cid);
}

export function archiveContent(ctx: Ctx, cid: string) {
  requirePerm(ctx, 'write');
  getScoped(ctx, 'content_items', cid);
  ctx.app.db.update('content_items', cid, ctx.workspaceId, { status: 'archived', updated_at: nowIso(ctx) });
  ctx.app.db.run("UPDATE publish_jobs SET status = 'cancelled' WHERE workspace_id = ? AND content_id = ? AND status = 'queued'", ctx.workspaceId, cid);
  audit(ctx, 'content.archived', 'content', cid);
  return getContent(ctx, cid);
}

/** Localization: requires external AI (no local translation). Locale profile applied; cultural fit not guaranteed. */
export async function localize(ctx: Ctx, cid: string, locale: string) {
  requirePerm(ctx, 'write');
  const c = getContent(ctx, cid);
  const brand = c.brandId ? getBrand(ctx, c.brandId) : defaultBrand(ctx);
  const lp = (brand?.localeProfiles as any)?.[locale] ?? {};
  const srcText = loadSources(ctx, c.sourceIds).map((s) => s.text ?? '').join('\n');
  let translated = false;
  const r = await ctx.app.ai.run(
    ctx.workspaceId,
    { task: 'localize', system: `Translate and adapt social copy into ${locale}. Keep brand voice: ${brand?.voiceSummary ?? ''}. Locale tone: ${lp.tone ?? ''}. Notes: ${lp.notes ?? ''}. Do not add facts.`, instruction: 'Localize this post. Output only the post.', data: c.body },
    { eligible: (brand?.aiEligible ?? true) && sourcesAllowAI(ctx, c.sourceIds), allowed: [c.body, srcText], fallback: () => '' },
  );
  translated = !!r.text && r.usedProvider !== 'local';
  if (!translated) throw badRequest('翻訳には外部AIプロバイダの設定とAI ONが必要です（AI OFF時は翻訳しません）');
  const nid = insertContent(ctx, { idea_id: c.ideaId, source_ids: c.sourceIds, platform: c.platform, format: c.format, title: c.title, body: r.text, structured: { notes: ['文化的な適合性は保証しません。ネイティブ確認を推奨します。'] }, status: 'draft', brand_id: c.brandId, campaign_id: c.campaignId, locale, parent_content_id: c.id }, 'ai', `localize:${locale}`);
  return getContent(ctx, nid);
}

export function createManualContent(ctx: Ctx, input: { platform: string; format?: string; title?: string; body: string; ideaId?: string; campaignId?: string; brandId?: string }) {
  requirePerm(ctx, 'write');
  if (!isPlatform(input.platform)) throw badRequest('unknown platform');
  let sourceIds: string[] = [];
  if (input.ideaId) sourceIds = getIdea(ctx, input.ideaId).sourceIds;
  if (input.campaignId) getScoped(ctx, 'campaigns', input.campaignId);
  const cid = insertContent(ctx, { idea_id: input.ideaId ?? null, source_ids: sourceIds, platform: input.platform, format: input.format ?? PLATFORMS[input.platform].formats[0], title: input.title ?? null, body: input.body, status: 'draft', brand_id: input.brandId ?? defaultBrand(ctx)?.id, campaign_id: input.campaignId ?? null, human_edited: 1 }, 'human');
  return getContent(ctx, cid);
}

export { insertContent };
