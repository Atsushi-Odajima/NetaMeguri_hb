import { z } from 'zod';
import { j } from '../db/db.js';
import { id, badRequest, utcToZoned } from '../lib/util.js';
import { keywords, trigrams, cosine } from '../lib/text.js';
import { audit, getScoped, getTimezone, nowIso, requirePerm, type Ctx } from './context.js';
import { contentRow, draftForPlatform, listContent } from './content.js';
import { listIdeas } from './ideas.js';
import { fingerprintSimilarity, makeFingerprint } from './fingerprint.js';
import { isPlatform, PLATFORMS, type PlatformId } from './platforms.js';
import { notify } from './notifications.js';

export const CampaignInput = z.object({
  name: z.string().min(1).max(200),
  objective: z.string().max(2000).optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  product: z.string().max(200).optional().nullable(),
  audience: z.string().max(500).optional().nullable(),
  keyMessages: z.array(z.string().max(300)).max(30).default([]),
  sourceIds: z.array(z.string()).max(50).default([]),
  channels: z.array(z.string()).max(11).default([]),
  brandId: z.string().optional().nullable(),
  status: z.enum(['planning', 'active', 'completed', 'archived']).default('planning'),
});

export const STAGES = [
  { stage: 'teaser', label: 'Teaser', angle: 'story' },
  { stage: 'problem', label: 'Problem', angle: 'why' },
  { stage: 'story', label: 'Story', angle: 'story' },
  { stage: 'demo', label: 'Demo', angle: 'how_to' },
  { stage: 'release', label: 'Release', angle: 'update' },
  { stage: 'use_case', label: 'Use Case', angle: 'how_to' },
  { stage: 'faq', label: 'FAQ', angle: 'faq' },
  { stage: 'reminder', label: 'Reminder', angle: 'checklist' },
];

export function campaignRow(r: any) {
  return { id: r.id, brandId: r.brand_id, name: r.name, objective: r.objective, startDate: r.start_date, endDate: r.end_date, product: r.product, audience: r.audience, keyMessages: j<string[]>(r.key_messages, []), sourceIds: j<string[]>(r.source_ids, []), channels: j<string[]>(r.channels, []), status: r.status, createdAt: r.created_at };
}

export function createCampaign(ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'write');
  const c = CampaignInput.parse(input);
  for (const s of c.sourceIds) getScoped(ctx, 'sources', s);
  for (const ch of c.channels) if (!isPlatform(ch)) throw badRequest(`unknown channel ${ch}`);
  const cid = id('cmp');
  ctx.app.db.insert('campaigns', { id: cid, workspace_id: ctx.workspaceId, brand_id: c.brandId, name: c.name, objective: c.objective, start_date: c.startDate, end_date: c.endDate, product: c.product, audience: c.audience, key_messages: c.keyMessages, source_ids: c.sourceIds, channels: c.channels, status: c.status, created_at: nowIso(ctx) });
  audit(ctx, 'campaign.created', 'campaign', cid, { name: c.name });
  return getCampaign(ctx, cid);
}

export function updateCampaign(ctx: Ctx, cid: string, input: unknown) {
  requirePerm(ctx, 'write');
  getScoped(ctx, 'campaigns', cid);
  const c = CampaignInput.partial().parse(input);
  const map: Record<string, string> = { name: 'name', objective: 'objective', startDate: 'start_date', endDate: 'end_date', product: 'product', audience: 'audience', keyMessages: 'key_messages', sourceIds: 'source_ids', channels: 'channels', status: 'status', brandId: 'brand_id' };
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) if (v !== undefined && map[k]) patch[map[k]] = v;
  ctx.app.db.update('campaigns', cid, ctx.workspaceId, patch);
  audit(ctx, 'campaign.updated', 'campaign', cid, { fields: Object.keys(c) });
  return getCampaign(ctx, cid);
}

export function getCampaign(ctx: Ctx, cid: string) {
  requirePerm(ctx, 'read');
  const c = campaignRow(getScoped(ctx, 'campaigns', cid));
  const steps = ctx.app.db.all('SELECT * FROM campaign_steps WHERE workspace_id = ? AND campaign_id = ? ORDER BY ord', ctx.workspaceId, cid).map((s) => ({ id: s.id, stage: s.stage, order: s.ord, plannedDate: s.planned_date, platform: s.platform, contentId: s.content_id, keyMessage: s.key_message, note: s.note }));
  const items = listContent(ctx, { campaignId: cid, limit: 500 });
  return { ...c, steps, items };
}

export function listCampaigns(ctx: Ctx) {
  requirePerm(ctx, 'read');
  return ctx.app.db.all('SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY created_at DESC', ctx.workspaceId).map(campaignRow);
}

/** Draft an 8-stage sequence (Teaser→…→Reminder). This is a draft plan, not an "optimal" schedule. */
export function draftSequence(ctx: Ctx, cid: string) {
  requirePerm(ctx, 'write');
  const c = campaignRow(getScoped(ctx, 'campaigns', cid));
  const channels = (c.channels.length ? c.channels : ['threads', 'x', 'linkedin']) as PlatformId[];
  const start = c.startDate ? new Date(c.startDate + 'T00:00:00Z') : ctx.app.clock.now();
  const end = c.endDate ? new Date(c.endDate + 'T00:00:00Z') : new Date(start.getTime() + 14 * 86400_000);
  const span = Math.max(1, (end.getTime() - start.getTime()) / 86400_000);
  ctx.app.db.run('DELETE FROM campaign_steps WHERE workspace_id = ? AND campaign_id = ? AND content_id IS NULL', ctx.workspaceId, cid);
  const existing = ctx.app.db.all('SELECT stage FROM campaign_steps WHERE workspace_id = ? AND campaign_id = ?', ctx.workspaceId, cid).map((r) => r.stage);
  STAGES.forEach((s, i) => {
    if (existing.includes(s.stage)) return;
    const d = new Date(start.getTime() + Math.round((span * i) / (STAGES.length - 1)) * 86400_000);
    ctx.app.db.insert('campaign_steps', { id: id('stp'), workspace_id: ctx.workspaceId, campaign_id: cid, stage: s.stage, ord: i, planned_date: d.toISOString().slice(0, 10), platform: channels[i % channels.length], content_id: null, key_message: c.keyMessages.length ? c.keyMessages[i % c.keyMessages.length] : null, note: `${s.label}: 推奨angle=${s.angle}（Draft案）` });
  });
  audit(ctx, 'campaign.sequence_drafted', 'campaign', cid);
  return getCampaign(ctx, cid);
}

/** Generate a draft for a step from campaign sources' ideas (matching the stage angle when possible). */
export async function draftStep(ctx: Ctx, cid: string, stepId: string) {
  requirePerm(ctx, 'write');
  const c = campaignRow(getScoped(ctx, 'campaigns', cid));
  const step = getScoped(ctx, 'campaign_steps', stepId);
  if (step.campaign_id !== cid) throw badRequest('step mismatch');
  const stage = STAGES.find((s) => s.stage === step.stage)!;
  const used = new Set(listContent(ctx, { campaignId: cid, limit: 500 }).map((x) => x.ideaId));
  let ideas = c.sourceIds.flatMap((s) => listIdeas(ctx, { sourceId: s, limit: 100 })).filter((i) => i.status !== 'retired' && i.status !== 'needs_update');
  if (!ideas.length) ideas = listIdeas(ctx, { limit: 100 }).filter((i) => i.status === 'new' || i.status === 'reusable');
  if (!ideas.length) throw badRequest('Campaign用のIdeaがありません。SourceからIdeaを抽出してください');
  const km = step.key_message ? new Set(keywords(step.key_message)) : null;
  const scored = ideas.map((i) => ({ i, s: (used.has(i.id) ? -2 : 0) + (i.angle === stage.angle ? 1 : 0) + (km ? keywords(i.coreIdea).filter((k) => km.has(k)).length : 0) })).sort((a, b) => b.s - a.s);
  const r = await draftForPlatform(ctx, { ideaId: scored[0].i.id, platform: step.platform ?? 'threads', angle: stage.angle, campaignId: cid, extraFacts: c.keyMessages });
  ctx.app.db.update('campaign_steps', stepId, ctx.workspaceId, { content_id: r.content.id });
  return r;
}

/** Campaign Guard: informational warnings. Never claims a plan is "optimal". */
export function campaignGuard(ctx: Ctx, cid: string) {
  const c = getCampaign(ctx, cid);
  const items = c.items.filter((i) => i.status !== 'archived');
  const warnings: { kind: string; message: string; refs?: string[] }[] = [];
  // 1) short-term idea duplicates
  const byIdea = new Map<string, typeof items>();
  for (const it of items) if (it.ideaId) byIdea.set(it.ideaId, [...(byIdea.get(it.ideaId) ?? []), it]);
  for (const [ideaId, its] of byIdea) {
    const dates = its.map((i) => new Date(i.scheduledAt ?? i.publishedAt ?? i.createdAt).getTime()).sort();
    for (let k = 1; k < dates.length; k++) if (dates[k] - dates[k - 1] < 7 * 86400_000) {
      warnings.push({ kind: 'idea_duplicate', message: `同じIdeaが7日以内に${its.length}回使われています`, refs: its.map((i) => i.id).concat(ideaId) });
      break;
    }
  }
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    if (items[a].ideaId && items[a].ideaId === items[b].ideaId) continue;
    const s = fingerprintSimilarity(makeFingerprint(items[a].body), makeFingerprint(items[b].body));
    if (s >= 0.58) warnings.push({ kind: 'similar_content', message: `内容が非常に近い投稿があります（類似度${s}）`, refs: [items[a].id, items[b].id] });
  }
  // 2) key message coverage
  for (const km of c.keyMessages) {
    const tg = trigrams(km);
    const kk = new Set(keywords(km));
    const covered = items.some((i) => cosine(tg, trigrams(i.body)) > 0.2 || keywords(i.body).filter((k) => kk.has(k)).length >= Math.min(2, kk.size));
    if (!covered) warnings.push({ kind: 'key_message_missing', message: `Key Message「${km}」を扱う投稿がありません` });
  }
  // 3) platform bias
  if (items.length >= 4) {
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.platform] = (counts[i.platform] ?? 0) + 1;
    for (const [p, n] of Object.entries(counts)) if (n / items.length > 0.6) warnings.push({ kind: 'platform_bias', message: `${PLATFORMS[p as PlatformId].label}に${Math.round((n / items.length) * 100)}%偏っています` });
    const missing = c.channels.filter((ch) => !counts[ch]);
    if (missing.length) warnings.push({ kind: 'channel_unused', message: `予定Channelで未使用: ${missing.map((m) => PLATFORMS[m as PlatformId]?.label ?? m).join(', ')}` });
  }
  // 4) unused sources
  for (const sid of c.sourceIds) {
    if (!items.some((i) => i.sourceIds.includes(sid))) {
      const t = ctx.app.db.get('SELECT title FROM sources WHERE id = ?', sid)?.title;
      warnings.push({ kind: 'source_unused', message: `Source「${t ?? sid}」がまだ使われていません`, refs: [sid] });
    }
  }
  // 5) steps without content
  const empty = c.steps.filter((s) => !s.contentId);
  if (empty.length) warnings.push({ kind: 'steps_without_content', message: `${empty.length}個のステップに投稿が未作成です（${empty.map((s) => s.stage).join(', ')}）` });
  if (warnings.some((w) => w.kind === 'steps_without_content' || w.kind === 'key_message_missing')) {
    notify(ctx, { kind: 'campaign_gap', message: `Campaign「${c.name}」に不足があります`, targetType: 'campaign', targetId: cid, dedupeKey: `cgap:${cid}` });
  }
  return { campaignId: cid, warnings, note: '表示は確認用のヒントです。最適な計画であることは保証しません。' };
}

// ---------------------------------------------------------------- Calendar

const CALENDAR_LIMIT = 1500;
export function calendar(ctx: Ctx, from: string, to: string) {
  requirePerm(ctx, 'read');
  const tz = getTimezone(ctx.app.db, ctx.workspaceId);
  const rows = ctx.app.db
    .all(
      `SELECT * FROM content_items WHERE workspace_id = ? AND status != 'archived' AND COALESCE(scheduled_at, published_at) >= ? AND COALESCE(scheduled_at, published_at) < ? ORDER BY COALESCE(scheduled_at, published_at) LIMIT ?`,
      ctx.workspaceId, from, to, CALENDAR_LIMIT + 1,
    )
    .map(contentRow);
  const jobs = ctx.app.db.all("SELECT content_id, mode, status FROM publish_jobs WHERE workspace_id = ? AND status IN ('queued','failed','handoff','running') AND scheduled_at >= ? AND scheduled_at < ?", ctx.workspaceId, from, to);
  const steps = ctx.app.db.all('SELECT s.*, c.name AS campaign_name FROM campaign_steps s JOIN campaigns c ON c.id = s.campaign_id WHERE s.workspace_id = ? AND s.planned_date >= ? AND s.planned_date < ? AND s.content_id IS NULL', ctx.workspaceId, from.slice(0, 10), to.slice(0, 10));
  const truncated = rows.length > CALENDAR_LIMIT;
  if (truncated) rows.length = CALENDAR_LIMIT;
  return {
    timezone: tz,
    truncated,
    entries: rows.map((c) => {
      const at = c.scheduledAt ?? c.publishedAt!;
      const job = jobs.find((x) => x.content_id === c.id);
      return { contentId: c.id, platform: c.platform, title: (c.title ?? c.body).slice(0, 40), status: c.status, at, localDate: utcToZoned(at, tz).slice(0, 10), localTime: utcToZoned(at, tz).slice(11, 16), mode: job?.mode ?? null, jobStatus: job?.status ?? null, publishedVia: c.publishedVia, campaignId: c.campaignId };
    }),
    plannedSteps: steps.map((s) => ({ stepId: s.id, campaignId: s.campaign_id, campaignName: s.campaign_name, stage: s.stage, date: s.planned_date, platform: s.platform })),
  };
}

// ---------------------------------------------------------------- Series & Brief

export function createSeries(ctx: Ctx, input: { name: string; theme?: string; cadence?: string; format?: string; brandId?: string }) {
  requirePerm(ctx, 'write');
  if (!input.name?.trim()) throw badRequest('name required');
  const sid = id('ser');
  ctx.app.db.insert('series', { id: sid, workspace_id: ctx.workspaceId, brand_id: input.brandId, name: input.name, theme: input.theme, cadence: input.cadence, format: input.format, idea_pool: '[]', created_at: nowIso(ctx) });
  return getSeries(ctx, sid);
}
export function getSeries(ctx: Ctx, sid: string) {
  const r = getScoped(ctx, 'series', sid);
  const ideas = listIdeas(ctx, { limit: 1000 }).filter((i) => i.seriesId === sid);
  const items = ctx.app.db.all('SELECT * FROM content_items WHERE workspace_id = ? AND series_id = ?', ctx.workspaceId, sid).map(contentRow);
  // duplicate check inside the series
  const dups: { a: string; b: string; score: number }[] = [];
  for (let x = 0; x < ideas.length; x++) for (let y = x + 1; y < ideas.length; y++) {
    const s = fingerprintSimilarity(makeFingerprint(ideas[x].coreIdea), makeFingerprint(ideas[y].coreIdea));
    if (s >= 0.4) dups.push({ a: ideas[x].id, b: ideas[y].id, score: s });
  }
  return { id: r.id, name: r.name, theme: r.theme, cadence: r.cadence, format: r.format, ideas, items, duplicates: dups };
}
export function listSeries(ctx: Ctx) {
  requirePerm(ctx, 'read');
  return ctx.app.db.all('SELECT * FROM series WHERE workspace_id = ? ORDER BY created_at DESC', ctx.workspaceId).map((r) => ({ id: r.id, name: r.name, theme: r.theme, cadence: r.cadence, format: r.format }));
}

export const BriefInput = z.object({ objective: z.string().max(1000), audience: z.string().max(500).optional(), message: z.string().max(1000).optional(), cta: z.string().max(300).optional(), platform: z.string().max(30).optional(), sourceIds: z.array(z.string()).default([]), constraints: z.string().max(2000).optional(), brandId: z.string().optional() });
export function createBrief(ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'write');
  const b = BriefInput.parse(input);
  for (const s of b.sourceIds) getScoped(ctx, 'sources', s);
  const bid = id('brf');
  ctx.app.db.insert('briefs', { id: bid, workspace_id: ctx.workspaceId, brand_id: b.brandId, objective: b.objective, audience: b.audience, message: b.message, cta: b.cta, platform: b.platform, source_ids: b.sourceIds, constraints: b.constraints, created_at: nowIso(ctx) });
  return ctx.app.db.get('SELECT * FROM briefs WHERE id = ?', bid);
}
export function listBriefs(ctx: Ctx) {
  requirePerm(ctx, 'read');
  return ctx.app.db.all('SELECT * FROM briefs WHERE workspace_id = ? ORDER BY created_at DESC', ctx.workspaceId);
}
