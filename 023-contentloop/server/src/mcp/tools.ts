import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Ctx } from '../domain/context.js';
import { getSettings, can, audit } from '../domain/context.js';
import { importSource } from '../domain/sources.js';
import { createPack, draftForPlatform, runChecks, getContent } from '../domain/content.js';
import { ideaMemory, similarIdeas } from '../domain/ideas.js';
import { getCampaign, campaignGuard } from '../domain/campaigns.js';
import { recyclingCandidates, performanceSummary, feedback } from '../domain/performance.js';
import { search } from '../domain/search.js';
import { capabilityMatrix, handoff, schedule, runDueJobs } from '../domain/publish.js';
import { PLATFORMS } from '../domain/platforms.js';
import { token } from '../lib/util.js';

/**
 * MCP tool definitions (transport-agnostic). External publishing is NEVER done implicitly:
 *  prepare_publish → returns preview, checks, capability and a one-time confirmation code
 *  confirm_publish → requires that code, workspace setting mcpPublishAllowed=true, publish permission and Approved content.
 */
export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  run: (ctx: Ctx, args: any) => Promise<unknown>;
}

const confirmations = new Map<string, { contentId: string; workspaceId: string; version: number; expires: number; bodyHash: string }>();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export const TOOLS: ToolDef[] = [
  {
    name: 'capture_source', description: 'テキスト/URLをSourceとしてContentLoopに取り込みます（URLは1ページのみ・SSRF対策あり）。',
    input: { type: z.enum(['article', 'blog', 'transcript', 'web_url', 'manual_idea', 'product_page', 'other']).default('manual_idea'), title: z.string(), text: z.string().optional(), url: z.string().optional(), rightsStatus: z.enum(['owned', 'licensed', 'public_reference', 'unknown']).default('unknown'), fetchUrl: z.boolean().default(false) },
    run: async (ctx, a) => {
      const s = await importSource(ctx, a);
      return { sourceId: s.id, title: s.title, status: s.status, topics: s.analysis?.topics ?? [] };
    },
  },
  {
    name: 'create_content_pack', description: '1つ以上のSourceからContent Pack（Platform別Draft一式）を作成します。投稿はしません。',
    input: { sourceIds: z.array(z.string()).min(1), counts: z.record(z.string(), z.number().int().min(0).max(20)).optional() },
    run: async (ctx, a) => {
      const p = await createPack(ctx, { sourceIds: a.sourceIds, counts: a.counts ?? { threads: 3, x: 3, linkedin: 1 } });
      return { packId: p.id, byKind: p.byKind, items: p.items.map((i) => ({ id: i.id, platform: i.platform, preview: i.body.slice(0, 120) })) };
    },
  },
  {
    name: 'find_unused_ideas', description: '未使用/再利用可能なIdeaを返します（platform指定でそのPlatformでの未使用）。', annotations: { readOnlyHint: true },
    input: { platform: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) },
    run: async (ctx, a) => {
      const mem = ideaMemory(ctx);
      const pool = [...mem.unused, ...mem.reusable].filter((i) => !a.platform || !ctx.app.db.get('SELECT 1 FROM idea_uses WHERE idea_id = ? AND platform = ?', i.id, a.platform));
      return { ideas: pool.slice(0, a.limit).map((i) => ({ ideaId: i.id, coreIdea: i.coreIdea, topic: i.topic, angle: i.angle, status: i.status, lastUsedAt: i.lastUsedAt, sourceIds: i.sourceIds })), recentlyUsed: mem.recentlyUsed.slice(0, 10).map((i) => ({ ideaId: i.id, coreIdea: i.coreIdea, lastUsedAt: i.lastUsedAt })) };
    },
  },
  {
    name: 'check_idea_similarity', description: '文章と過去Ideaの類似候補を返します（重複の断定はしません）。', annotations: { readOnlyHint: true },
    input: { text: z.string().min(3) },
    run: async (ctx, a) => ({ candidates: await similarIdeas(ctx, a.text, {}), note: '類似は候補です。そのまま/別角度/最新情報追加/別Platform/使わない から選んでください。' }),
  },
  {
    name: 'draft_for_platform', description: 'IdeaからPlatform別Draftを作成し、Brand/重複/Claim/Freshnessチェック結果を返します。投稿はしません。',
    input: { ideaId: z.string(), platform: z.string(), angle: z.string().optional() },
    run: async (ctx, a) => {
      const r = await draftForPlatform(ctx, a);
      return { contentId: r.content.id, platform: r.content.platform, body: r.content.body, status: r.content.status, checks: summarizeChecks(r.checks) };
    },
  },
  {
    name: 'get_campaign', description: 'CampaignとCampaign Guard（不足/重複/偏り）を返します。', annotations: { readOnlyHint: true },
    input: { campaignId: z.string() },
    run: async (ctx, a) => {
      const c = getCampaign(ctx, a.campaignId);
      return { campaign: { id: c.id, name: c.name, objective: c.objective, keyMessages: c.keyMessages, steps: c.steps }, guard: campaignGuard(ctx, a.campaignId) };
    },
  },
  {
    name: 'review_draft', description: 'Draftのチェック結果（Brand Guard/重複/Claim/Freshness/Reuse rule）とプレビューを返します。', annotations: { readOnlyHint: true },
    input: { contentId: z.string() },
    run: async (ctx, a) => {
      const c = getContent(ctx, a.contentId);
      return { content: { id: c.id, platform: c.platform, status: c.status, body: c.body, version: c.version }, checks: summarizeChecks(await runChecks(ctx, a.contentId)) };
    },
  },
  {
    name: 'get_recycling_candidates', description: 'Reuse Rulesに基づく再利用候補を返します。', annotations: { readOnlyHint: true },
    input: {},
    run: async (ctx) => ({ candidates: recyclingCandidates(ctx).slice(0, 20).map((r) => ({ contentId: r.content.id, platform: r.content.platform, reason: r.reason, suggestions: r.suggestions, autoPublishAllowed: r.autoPublishAllowed })) }),
  },
  {
    name: 'search_content', description: 'Source/Idea/Contentを横断検索し、引用(citation)付きで返します。', annotations: { readOnlyHint: true },
    input: { query: z.string() },
    run: async (ctx, a) => ({ hits: search(ctx, a.query, { limit: 15 }).hits.map((h) => ({ type: h.refType, id: h.refId, title: h.title, snippet: h.snippet, citation: h.citation })) }),
  },
  {
    name: 'get_performance_summary', description: 'Platform別のPerformance要約と傾向（期間・件数・分母付き、合算なし）。', annotations: { readOnlyHint: true },
    input: { days: z.number().int().min(7).max(365).default(90) },
    run: async (ctx, a) => ({ summary: performanceSummary(ctx, { days: a.days }), topicTrend: feedback(ctx, 'topic', { days: a.days }).insight }),
  },
  {
    name: 'prepare_publish', description: '投稿前の最終確認。プレビュー・チェック・Connector capabilityを返し、自動投稿可能な場合のみ確認コードを発行します。これ自体は投稿しません。', annotations: { readOnlyHint: true },
    input: { contentId: z.string() },
    run: async (ctx, a) => {
      const c = getContent(ctx, a.contentId);
      const checks = await runChecks(ctx, a.contentId);
      const cap = capabilityMatrix(ctx).find((m) => m.platform === c.platform)!;
      const s = getSettings(ctx.app.db, ctx.workspaceId);
      const blockers: string[] = [];
      if (s.requireApprovalBeforePublish && c.status !== 'approved') blockers.push('Approvedではありません（レビュー/承認が必要）');
      if (checks.blocking) blockers.push('ブロック項目があります');
      if (!cap.autoPublish) blockers.push(`${PLATFORMS[c.platform].label}はAPI投稿に対応/接続されていません → 手動投稿(handoff)`);
      if (!s.mcpPublishAllowed) blockers.push('Workspace設定でMCPからの投稿が許可されていません');
      if (!can(ctx, 'publish')) blockers.push('外部投稿権限がありません');
      let confirmationCode: string | null = null;
      if (!blockers.length) {
        confirmationCode = token(9);
        confirmations.set(confirmationCode, { contentId: c.id, workspaceId: ctx.workspaceId, version: c.version, expires: Date.now() + 10 * 60_000, bodyHash: hash(c.body) });
      }
      return {
        preview: { platform: PLATFORMS[c.platform].label, body: c.body, status: c.status, version: c.version },
        checks: summarizeChecks(checks), capability: cap.effective, autoPublishPossible: !blockers.length, blockers,
        handoff: blockers.length ? handoff(ctx, c.id) : null, confirmationCode,
        instruction: confirmationCode ? 'ユーザーに本文を見せ、明示的な承認を得た場合のみ confirm_publish を確認コード付きで呼んでください。' : '自動投稿はできません。handoffのテキストをコピーして手動投稿してください。',
      };
    },
  },
  {
    name: 'confirm_publish', description: 'prepare_publishで発行された確認コードとユーザーの明示承認がある場合のみ、API対応Platformへ投稿します。', annotations: { destructiveHint: true, openWorldHint: true },
    input: { contentId: z.string(), confirmationCode: z.string(), userApproved: z.literal(true) },
    run: async (ctx, a) => {
      const conf = confirmations.get(a.confirmationCode);
      confirmations.delete(a.confirmationCode);
      if (!conf || conf.contentId !== a.contentId || conf.workspaceId !== ctx.workspaceId || conf.expires < Date.now()) throw new Error('確認コードが無効または期限切れです。prepare_publishからやり直してください');
      const c = getContent(ctx, a.contentId);
      if (c.version !== conf.version || hash(c.body) !== conf.bodyHash) throw new Error('確認後に本文が変更されています。prepare_publishからやり直してください');
      if (!getSettings(ctx.app.db, ctx.workspaceId).mcpPublishAllowed) throw new Error('MCPからの投稿は許可されていません');
      audit(ctx, 'mcp.publish_confirmed', 'content', c.id);
      const r = await schedule(ctx, { contentId: c.id, at: ctx.app.clock.now().toISOString(), mode: 'api' });
      await runDueJobs(ctx.app);
      return { job: r.job, content: { id: c.id, status: getContent(ctx, c.id).status } };
    },
  },
];

function summarizeChecks(ch: Awaited<ReturnType<typeof runChecks>>) {
  return {
    blocking: ch.blocking,
    brandGuard: ch.brandGuard.map((g) => `${g.severity}: ${g.message}`),
    similar: ch.similar.slice(0, 3).map((s) => `${s.level}: ${s.message}`),
    reuse: ch.reuse.map((r) => r.message),
    freshness: ch.freshness.map((f) => f.message),
    claims: ch.claims.map((c) => c.message),
  };
}

export async function callTool(ctx: Ctx, name: string, args: unknown) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  const parsed = z.object(t.input).parse(args ?? {});
  return t.run({ ...ctx, via: 'mcp' }, parsed);
}
