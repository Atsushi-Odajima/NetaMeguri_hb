import { z } from 'zod';
import { j } from '../db/db.js';
import { id, badRequest, median } from '../lib/util.js';
import { decryptSecret } from '../lib/util.js';
import { audit, getScoped, getSettings, nowIso, requirePerm, type Ctx } from './context.js';
import { getContent, contentRow, draftForPlatform } from './content.js';
import { PLATFORMS, type PlatformId } from './platforms.js';
import { notify } from './notifications.js';
import { getIdea } from './ideas.js';

// Metric names are platform-specific. They are stored as reported and NEVER summed across platforms.
export const METRIC_KEYS = ['impressions', 'views', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks', 'watch_time_sec', 'followers_delta'] as const;
export const METRIC_DEFINITIONS: Partial<Record<PlatformId, string>> = {
  threads: 'views/likes/replies(comments)/reposts(shares)/quotes。定義はThreads Insights準拠（要確認）',
  x: 'impressions/likes/replies/reposts/bookmarks(saves)/url clicks。非公開指標は自投稿のみ',
  linkedin: 'impressions/reactions(likes)/comments/reshares/clicks',
  instagram: 'views(旧impressions)/reach/likes/comments/shares/saves',
  facebook: 'views/reactions/comments/shares/clicks（Meta指標移行中）',
  youtube_shorts: 'views/likes/comments/shares/watch time',
  tiktok: 'views/likes/comments/shares',
  blog: 'pageviews(views)/clicks（外部Analyticsから手動/CSV）',
  newsletter: 'opens(views)/clicks',
};

export const SnapshotInput = z.object({
  contentId: z.string(),
  window: z.enum(['24h', '7d', '30d', 'custom']).default('custom'),
  capturedAt: z.string().optional(),
  metrics: z.record(z.string(), z.number().min(0).max(1e12)),
  source: z.enum(['connector', 'csv', 'manual']).default('manual'),
});

export function recordSnapshot(ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'write');
  const s = SnapshotInput.parse(input);
  const c = getContent(ctx, s.contentId);
  if (c.status !== 'published') throw badRequest('公開済みContentのみ反応を記録できます');
  const metrics: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.metrics)) if ((METRIC_KEYS as readonly string[]).includes(k)) metrics[k] = v;
  const sid = id('perf');
  ctx.app.db.insert('performance_snapshots', { id: sid, workspace_id: ctx.workspaceId, content_id: c.id, platform: c.platform, captured_at: s.capturedAt ?? nowIso(ctx), window: s.window, metrics, source: s.source });
  classifyRecycle(ctx, c.id);
  return snapshotRow(getScoped(ctx, 'performance_snapshots', sid));
}

const snapshotRow = (r: any) => ({ id: r.id, contentId: r.content_id, platform: r.platform, capturedAt: r.captured_at, window: r.window, metrics: j<Record<string, number>>(r.metrics, {}), source: r.source });

export function listSnapshots(ctx: Ctx, contentId: string) {
  requirePerm(ctx, 'read');
  getScoped(ctx, 'content_items', contentId);
  return ctx.app.db.all('SELECT * FROM performance_snapshots WHERE workspace_id = ? AND content_id = ? ORDER BY captured_at', ctx.workspaceId, contentId).map(snapshotRow);
}

/** Pull metrics from a connector with ANALYTICS_READ (sandbox in this build). */
export async function pullConnectorMetrics(ctx: Ctx, contentId: string, window: '24h' | '7d' | '30d') {
  const c = getContent(ctx, contentId);
  if (c.publishedVia !== 'api_confirmed' || !c.externalPostId) throw badRequest('API経由で公開したContentのみConnectorから取得できます');
  const conn = ctx.app.db.get("SELECT * FROM connectors WHERE workspace_id = ? AND platform = ? AND status = 'connected' LIMIT 1", ctx.workspaceId, c.platform);
  const a = conn ? ctx.app.connectors.get(conn.adapter) : null;
  if (!conn || !a?.fetchMetrics || !a.capabilities.includes('ANALYTICS_READ')) throw badRequest('このPlatformのAnalytics取得は利用できません（CSV/手入力を使ってください）');
  const m = await a.fetchMetrics({ accessToken: decryptSecret(conn.token_enc), scopes: [] }, c.externalPostId);
  return recordSnapshot(ctx, { contentId, window, metrics: m, source: 'connector' });
}

export function latestMetrics(ctx: Ctx, contentId: string): Record<string, number> | null {
  const r = ctx.app.db.get('SELECT metrics FROM performance_snapshots WHERE workspace_id = ? AND content_id = ? ORDER BY captured_at DESC LIMIT 1', ctx.workspaceId, contentId);
  return r ? j(r.metrics, {}) : null;
}

/** Engagement rate for ONE post on ONE platform: interactions / (impressions|views|reach). Null if no denominator. */
export function engagementRate(m: Record<string, number>): number | null {
  const denom = m.impressions ?? m.views ?? m.reach;
  if (!denom) return null;
  const inter = (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0) + (m.clicks ?? 0);
  return inter / denom;
}

/**
 * Per-platform summary. Totals are computed per platform only; there is intentionally no cross-platform total.
 */
export function performanceSummary(ctx: Ctx, opts: { days?: number } = {}) {
  requirePerm(ctx, 'read');
  const since = new Date(ctx.app.clock.now().getTime() - (opts.days ?? 90) * 86400_000).toISOString();
  const rows = ctx.app.db.all("SELECT * FROM content_items WHERE workspace_id = ? AND status = 'published' AND published_at >= ?", ctx.workspaceId, since).map(contentRow);
  const byPlatform: Record<string, { posts: number; withMetrics: number; totals: Record<string, number>; medianEngagement: number | null; definition: string }> = {};
  for (const c of rows) {
    const b = (byPlatform[c.platform] ??= { posts: 0, withMetrics: 0, totals: {}, medianEngagement: null, definition: METRIC_DEFINITIONS[c.platform] ?? '' });
    b.posts++;
    const m = latestMetrics(ctx, c.id);
    if (!m) continue;
    b.withMetrics++;
    for (const [k, v] of Object.entries(m)) b.totals[k] = (b.totals[k] ?? 0) + v;
  }
  for (const [p, b] of Object.entries(byPlatform)) {
    const ers = rows.filter((c) => c.platform === p).map((c) => latestMetrics(ctx, c.id)).filter(Boolean).map((m) => engagementRate(m!)).filter((x): x is number => x != null);
    b.medianEngagement = ers.length ? median(ers) : null;
  }
  return { periodDays: opts.days ?? 90, since, byPlatform, crossPlatformTotal: null, note: 'Platformごとに指標の定義が異なるため、Platform間の合算は行いません。' };
}

/**
 * Feedback Loop: compare median engagement by dimension (topic/angle/format/platform/length/cta).
 * Reports period, n and denominator. Correlation only — not causation, no guarantee of future results.
 */
export function feedback(ctx: Ctx, dimension: 'topic' | 'angle' | 'format' | 'platform' | 'length' | 'cta' | 'hook', opts: { days?: number; minN?: number } = {}) {
  requirePerm(ctx, 'read');
  const days = opts.days ?? 90;
  const since = new Date(ctx.app.clock.now().getTime() - days * 86400_000).toISOString();
  const rows = ctx.app.db.all("SELECT c.*, i.topic AS idea_topic, i.angle AS idea_angle FROM content_items c LEFT JOIN ideas i ON i.id = c.idea_id WHERE c.workspace_id = ? AND c.status = 'published' AND c.published_at >= ?", ctx.workspaceId, since);
  const groups = new Map<string, number[]>();
  let withMetrics = 0;
  for (const r of rows) {
    const m = latestMetrics(ctx, r.id);
    const er = m ? engagementRate(m) : null;
    if (er == null) continue;
    withMetrics++;
    const len = [...r.body].length;
    const key =
      dimension === 'topic' ? r.idea_topic ?? '(なし)'
      : dimension === 'angle' ? r.idea_angle ?? '(なし)'
      : dimension === 'format' ? r.format
      : dimension === 'platform' ? r.platform
      : dimension === 'length' ? (len < 100 ? '短 (<100)' : len < 300 ? '中 (100-299)' : '長 (300+)')
      : dimension === 'cta' ? (/[?？]\s*$|教えて|コメント|保存|返信/.test(r.body) ? 'CTAあり' : 'CTAなし')
      : (r.body.split('\n')[0] ?? '').slice(0, 12);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(er);
  }
  const all = [...groups.values()].flat();
  const overall = all.length ? median(all) : null;
  const minN = opts.minN ?? 3;
  const result = [...groups.entries()].map(([key, xs]) => ({ key, n: xs.length, medianEngagement: median(xs), enough: xs.length >= minN })).sort((a, b) => b.medianEngagement - a.medianEngagement);
  const top = result.find((r) => r.enough);
  const label: Record<string, string> = { topic: 'Topic', angle: 'Angle', format: 'Format', platform: 'Platform', length: '長さ', cta: 'CTA', hook: 'Hook' };
  const insight = top && overall != null && top.medianEngagement > overall
    ? `過去${days}日、${label[dimension]}「${top.key}」は他よりmedian engagementが高い傾向でした（${top.key}: n=${top.n}、全体: n=${all.length}、分母=impressions/views）。相関であり因果関係や将来の成果は保証しません。`
    : `過去${days}日のデータでは、十分な件数(n≥${minN})で目立つ差は確認できませんでした（対象 ${all.length}件）。`;
  return { dimension, periodDays: days, since, totalPublished: rows.length, withMetrics, denominator: 'impressions → views → reach の順で利用可能なもの', overallMedian: overall, groups: result, insight, caveat: 'Platform間で指標定義が異なります。相関のみで因果関係は示しません。' };
}

// ---------------------------------------------------------------- Recycling

export const RECYCLE_STATES = ['evergreen', 'update_needed', 'seasonal', 'high_performer', 'reusable', 'do_not_reuse'] as const;

/** Classify a published item. High performer = engagement ≥ 1.5x platform median with n≥3 peers. */
export function classifyRecycle(ctx: Ctx, contentId: string) {
  const c = getContent(ctx, contentId);
  if (c.recycleState === 'do_not_reuse' || c.recycleState === 'update_needed' || c.recycleState === 'seasonal') return c.recycleState;
  const m = latestMetrics(ctx, contentId);
  const er = m ? engagementRate(m) : null;
  const peers = ctx.app.db.all("SELECT id FROM content_items WHERE workspace_id = ? AND platform = ? AND status = 'published' AND id != ?", ctx.workspaceId, c.platform, c.id).map((r) => latestMetrics(ctx, r.id)).filter(Boolean).map((x) => engagementRate(x!)).filter((x): x is number => x != null);
  let state: string = c.recycleState ?? 'reusable';
  if (er != null && peers.length >= 3 && er >= median(peers) * 1.5) state = 'high_performer';
  else if (c.ideaId) {
    const idea = getIdea(ctx, c.ideaId);
    if (idea.evergreen) state = 'evergreen';
  }
  if (state !== c.recycleState) ctx.app.db.update('content_items', contentId, ctx.workspaceId, { recycle_state: state, updated_at: nowIso(ctx) });
  return state;
}

export function setRecycleState(ctx: Ctx, contentId: string, state: string, seasonalMonths?: number[]) {
  requirePerm(ctx, 'write');
  if (!(RECYCLE_STATES as readonly string[]).includes(state)) throw badRequest('invalid recycle state');
  getScoped(ctx, 'content_items', contentId);
  ctx.app.db.update('content_items', contentId, ctx.workspaceId, { recycle_state: state, updated_at: nowIso(ctx) });
  if (state === 'seasonal' && seasonalMonths) {
    const s = getSettings(ctx.app.db, ctx.workspaceId);
    const rules = { ...s.reuseRules, seasonalMonths: { ...s.reuseRules.seasonalMonths, [contentId]: seasonalMonths } };
    ctx.app.db.run('UPDATE workspaces SET settings = ? WHERE id = ?', JSON.stringify({ ...s, reuseRules: rules }), ctx.workspaceId);
  }
  audit(ctx, 'content.recycle_state', 'content', contentId, { state });
  return getContent(ctx, contentId);
}

/**
 * Recycling candidates per Reuse Rules:
 *  - high_performer after highPerformerReuseDays → suggest different angle
 *  - evergreen/reusable after recyclingCandidateAfterDays
 *  - seasonal only in configured months
 *  - update_needed: listed but auto-publish forbidden; do_not_reuse excluded
 */
export function recyclingCandidates(ctx: Ctx, opts: { notify?: boolean } = {}) {
  requirePerm(ctx, 'read');
  const s = getSettings(ctx.app.db, ctx.workspaceId);
  const r = s.reuseRules;
  const now = ctx.app.clock.now();
  const month = now.getUTCMonth() + 1;
  const out: { content: ReturnType<typeof contentRow>; reason: string; suggestions: string[]; daysSincePublish: number; autoPublishAllowed: boolean; metrics: Record<string, number> | null }[] = [];
  for (const row of ctx.app.db.all("SELECT * FROM content_items WHERE workspace_id = ? AND status = 'published' AND COALESCE(recycle_state,'') != 'do_not_reuse'", ctx.workspaceId)) {
    const c = contentRow(row);
    const days = Math.floor((now.getTime() - new Date(c.publishedAt!).getTime()) / 86400_000);
    const state = c.recycleState ?? 'reusable';
    let reason: string | null = null;
    let suggestions: string[] = [];
    if (state === 'high_performer' && days >= r.highPerformerReuseDays) {
      reason = `High Performer・公開から${days}日（${r.highPerformerReuseDays}日ルール）`;
      suggestions = ['new_angle', 'different_platform', 'story', 'checklist'];
    } else if (state === 'seasonal') {
      const months = r.seasonalMonths[c.id] ?? [];
      if (months.includes(month)) {
        reason = `Seasonal（${months.join(',')}月指定）`;
        suggestions = ['updated_facts', 'different_platform'];
      }
    } else if (state === 'update_needed') {
      reason = '情報更新が必要（自動投稿禁止）';
      suggestions = ['updated_facts'];
    } else if ((state === 'evergreen' || state === 'reusable') && days >= r.recyclingCandidateAfterDays) {
      reason = `${state === 'evergreen' ? 'Evergreen' : 'Reusable'}・公開から${days}日`;
      suggestions = ['shorter', 'longer', 'different_platform', 'new_angle'];
    }
    if (!reason) continue;
    out.push({ content: c, reason, suggestions, daysSincePublish: days, autoPublishAllowed: state !== 'update_needed', metrics: latestMetrics(ctx, c.id) });
    if (opts.notify) notify(ctx, { kind: 'recycling_candidate', message: `再利用候補: ${PLATFORMS[c.platform].label}「${(c.title ?? c.body).slice(0, 24)}」(${reason})`, targetType: 'content', targetId: c.id, dedupeKey: `recycle:${c.id}` });
  }
  return out;
}

const RECYCLE_ANGLE: Record<string, string | undefined> = { new_angle: 'story', story: 'story', checklist: 'checklist', updated_facts: 'update', shorter: undefined, longer: undefined, different_platform: undefined };

/** Turn a published item into a new Draft (different angle / platform / length). Never auto-publishes. */
export async function recycle(ctx: Ctx, contentId: string, input: { mode: string; platform?: string }) {
  requirePerm(ctx, 'write');
  const c = getContent(ctx, contentId);
  if (!c.ideaId) throw badRequest('Ideaに紐づかないContentは再構成できません');
  if (c.recycleState === 'do_not_reuse') throw badRequest('Do Not Reuseに設定されています');
  const platform = input.platform ?? (input.mode === 'longer' ? 'blog' : input.mode === 'shorter' ? 'x' : input.mode === 'different_platform' ? (c.platform === 'linkedin' ? 'threads' : 'linkedin') : c.platform);
  if (input.mode === 'different_platform' && platform === c.platform) throw badRequest('別Platformを指定してください');
  let angle = RECYCLE_ANGLE[input.mode];
  if (input.mode === 'new_angle') {
    const idea = getIdea(ctx, c.ideaId);
    angle = ['story', 'checklist', 'how_to', 'why', 'faq'].find((a) => a !== idea.angle);
  }
  const r = await draftForPlatform(ctx, { ideaId: c.ideaId, platform, angle, parentContentId: c.id, campaignId: c.campaignId, variant: 1 });
  ctx.app.db.update('content_items', r.content.id, ctx.workspaceId, { structured: { ...(r.content.structured ?? {}), recycledFrom: c.id, recycleMode: input.mode } });
  audit(ctx, 'content.recycled', 'content', c.id, { newContent: r.content.id, mode: input.mode });
  return { ...r, content: getContent(ctx, r.content.id) };
}
