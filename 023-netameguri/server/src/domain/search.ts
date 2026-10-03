import { j } from '../db/db.js';
import { hashVector, vecCosine, topKeywords } from '../lib/text.js';
import { getSettings, requirePerm, type Ctx } from './context.js';
import { PLATFORMS, PLATFORM_IDS, type PlatformId } from './platforms.js';
import { contentRow, listContent } from './content.js';
import { ideaMemory, listIdeas, type Idea } from './ideas.js';
import { feedback, latestMetrics, engagementRate, recyclingCandidates } from './performance.js';
import { campaignGuard, listCampaigns } from './campaigns.js';
import { median } from '../lib/util.js';
import { sourcesAllowAI, brandAllows } from './sources.js';

export interface Citation { refType: 'source' | 'idea' | 'content' | 'campaign' | 'performance'; refId: string; title: string; url?: string | null }
export interface SearchHit { refType: string; refId: string; title: string; snippet: string; score: number; matchedBy: string[]; citation: Citation; meta?: Record<string, unknown> }

const PLATFORM_WORDS: [RegExp, PlatformId][] = [
  [/threads|スレッズ/i, 'threads'], [/\bx\b|twitter|ツイッター|エックス/i, 'x'], [/linkedin|リンクトイン/i, 'linkedin'], [/instagram|インスタ/i, 'instagram'],
  [/facebook|フェイスブック/i, 'facebook'], [/tiktok|ティックトック/i, 'tiktok'], [/shorts|ショート/i, 'youtube_shorts'], [/ブログ|blog/i, 'blog'], [/ニュースレター|newsletter|メルマガ/i, 'newsletter'],
];

export function parseQuery(q: string) {
  const platform = PLATFORM_WORDS.find(([re]) => re.test(q))?.[1] ?? null;
  const unused = /使ってない|使っていない|未使用|まだ.*ない|unused/i.test(q);
  const highPerf = /反応が良|反応の良|伸びた|好評|high.?perform|バズ/i.test(q);
  const angle = /失敗談|失敗/.test(q) ? 'failure_story' : /チェックリスト/.test(q) ? 'checklist' : /手順|how.?to/i.test(q) ? 'how_to' : null;
  const cleaned = q
    .replace(/まだ|使ってない|使っていない|未使用|ネタ|関連の?|過去に|反応が良かった|反応の良い|Idea|アイデア|で|の|を|に|は|が|unused/gi, ' ')
    .replace(/threads|スレッズ|twitter|linkedin|instagram|インスタ|facebook|tiktok|shorts|ブログ|ニュースレター/gi, ' ')
    .replace(/\bx\b/gi, ' ');
  const terms = topKeywords(cleaned, 6).concat(cleaned.split(/\s+/).filter((w) => /^[A-Za-z0-9]{3,}$/.test(w))).filter((v, i, a) => a.indexOf(v) === i);
  return { platform, unused, highPerf, angle, terms };
}

export function search(ctx: Ctx, q: string, filters: { types?: string[]; status?: string; platform?: string; campaignId?: string; from?: string; to?: string; reuseState?: string; limit?: number } = {}) {
  requirePerm(ctx, 'read');
  const db = ctx.app.db;
  const parsed = parseQuery(q);
  const types = filters.types?.length ? filters.types : ['source', 'idea', 'content'];
  const scores = new Map<string, { type: string; id: string; score: number; by: Set<string> }>();
  const bump = (type: string, rid: string, s: number, by: string) => {
    const k = `${type}:${rid}`;
    const cur = scores.get(k) ?? { type, id: rid, score: 0, by: new Set<string>() };
    cur.score += s;
    cur.by.add(by);
    scores.set(k, cur);
  };
  // full-text (trigram FTS needs ≥3 chars; shorter terms use LIKE)
  for (const t of parsed.terms) {
    if ([...t].length >= 3) {
      for (const r of db.all('SELECT ref_type, ref_id, bm25(search_fts) AS rank FROM search_fts WHERE search_fts MATCH ? AND workspace_id = ? LIMIT 300', `"${t.replace(/"/g, '')}"`, ctx.workspaceId)) {
        if (types.includes(r.ref_type)) bump(r.ref_type, r.ref_id, 1 + Math.min(2, -r.rank / 5), 'fulltext');
      }
    } else {
      for (const r of db.all("SELECT ref_type, ref_id FROM search_fts WHERE workspace_id = ? AND (title LIKE ? OR body LIKE ?) LIMIT 300", ctx.workspaceId, `%${t}%`, `%${t}%`)) {
        if (types.includes(r.ref_type)) bump(r.ref_type, r.ref_id, 0.8, 'fulltext');
      }
    }
  }
  // semantic (optional; local hashing vector unless an embedding provider is configured)
  const s = getSettings(db, ctx.workspaceId);
  if (s.embeddingProvider !== 'off' && parsed.terms.length) {
    const qv = hashVector(parsed.terms.join(' '));
    for (const e of db.all("SELECT ref_type, ref_id, vector FROM embeddings WHERE workspace_id = ? AND model = 'local-hash-v1' ORDER BY created_at DESC LIMIT 5000", ctx.workspaceId)) {
      if (!types.includes(e.ref_type)) continue;
      const sim = vecCosine(qv, JSON.parse(e.vector));
      if (sim > 0.25) bump(e.ref_type, e.ref_id, sim * 2, 'semantic');
    }
  }
  // structured intents
  if (parsed.unused || parsed.angle || parsed.highPerf || !parsed.terms.length) {
    if (types.includes('idea')) {
      for (const i of listIdeas(ctx, { limit: 1000 })) {
        if (parsed.angle && i.angle !== parsed.angle) continue;
        if (parsed.unused) {
          const usedOnPlatform = parsed.platform ? !!db.get('SELECT 1 FROM idea_uses WHERE idea_id = ? AND platform = ?', i.id, parsed.platform) : i.useCount > 0;
          if (usedOnPlatform || i.status === 'retired') continue;
        }
        bump('idea', i.id, parsed.terms.length ? 0.5 : 1, parsed.unused ? (parsed.platform ? `unused_on_${parsed.platform}` : 'unused') : parsed.angle ? `angle:${parsed.angle}` : 'filter');
      }
    }
    if (parsed.highPerf && types.includes('content')) {
      const pub = listContent(ctx, { status: 'published', limit: 2000 });
      const ers = pub.map((c) => ({ c, er: latestMetrics(ctx, c.id) })).map((x) => ({ c: x.c, er: x.er ? engagementRate(x.er) : null })).filter((x) => x.er != null);
      const byPlat = new Map<string, number[]>();
      for (const x of ers) byPlat.set(x.c.platform, [...(byPlat.get(x.c.platform) ?? []), x.er!]);
      for (const x of ers) if (x.er! >= median(byPlat.get(x.c.platform)!) * 1.2 || x.c.recycleState === 'high_performer') bump('content', x.c.id, 1.5, 'high_performance');
    }
  }
  // When the query has structured intent, require those intents to match.
  let entries = [...scores.values()];
  if (parsed.unused) entries = entries.filter((e) => e.type !== 'idea' || [...e.by].some((b) => b.startsWith('unused')));
  if (parsed.highPerf) entries = entries.filter((e) => e.by.has('high_performance') || e.type !== 'content');
  if (parsed.highPerf && parsed.angle) entries = entries.filter((e) => e.type === 'content' && e.by.has('high_performance'));
  const hits: SearchHit[] = [];
  for (const e of entries.sort((a, b) => b.score - a.score)) {
    const h = hydrate(ctx, e.type, e.id);
    if (!h) continue;
    if (filters.platform && h.meta?.platform && h.meta.platform !== filters.platform) continue;
    if (filters.status && h.meta?.status !== filters.status) continue;
    if (filters.campaignId && h.meta?.campaignId !== filters.campaignId) continue;
    if (filters.reuseState && h.meta?.recycleState !== filters.reuseState && h.meta?.status !== filters.reuseState) continue;
    if (filters.from && String(h.meta?.date ?? '') < filters.from) continue;
    if (filters.to && String(h.meta?.date ?? '') >= filters.to) continue;
    if (parsed.angle && e.type === 'content' && !parsed.highPerf) {
      /* angle applies to ideas */
    }
    hits.push({ ...h, score: Math.round(e.score * 100) / 100, matchedBy: [...e.by] });
    if (hits.length >= (filters.limit ?? 30)) break;
  }
  return { query: q, parsed, hits };
}

function hydrate(ctx: Ctx, type: string, rid: string): Omit<SearchHit, 'score' | 'matchedBy'> | null {
  const db = ctx.app.db;
  if (type === 'source') {
    const r = db.get('SELECT id, title, url, text, type, imported_at FROM sources WHERE id = ? AND workspace_id = ?', rid, ctx.workspaceId);
    if (!r) return null;
    return { refType: 'source', refId: r.id, title: r.title, snippet: (r.text ?? '').slice(0, 140), citation: { refType: 'source', refId: r.id, title: r.title, url: r.url }, meta: { type: r.type, date: r.imported_at } };
  }
  if (type === 'idea') {
    const r = db.get('SELECT * FROM ideas WHERE id = ? AND workspace_id = ?', rid, ctx.workspaceId);
    if (!r) return null;
    const src = j<string[]>(r.source_ids, [])[0];
    const st = src ? db.get('SELECT title, url FROM sources WHERE id = ?', src) : null;
    return { refType: 'idea', refId: r.id, title: `${r.topic}｜${r.angle}`, snippet: r.core_idea.slice(0, 140), citation: { refType: 'idea', refId: r.id, title: st ? `${st.title}` : r.core_idea.slice(0, 40), url: st?.url }, meta: { status: r.status, useCount: r.use_count, sourceId: src, date: r.created_at } };
  }
  if (type === 'content') {
    const r = db.get('SELECT * FROM content_items WHERE id = ? AND workspace_id = ?', rid, ctx.workspaceId);
    if (!r) return null;
    const c = contentRow(r);
    return { refType: 'content', refId: c.id, title: `${PLATFORMS[c.platform].label}｜${(c.title ?? c.body).slice(0, 30)}`, snippet: c.body.slice(0, 140), citation: { refType: 'content', refId: c.id, title: (c.title ?? c.body).slice(0, 40), url: c.externalUrl }, meta: { platform: c.platform, status: c.status, recycleState: c.recycleState, campaignId: c.campaignId, date: c.publishedAt ?? c.createdAt, metrics: latestMetrics(ctx, c.id) } };
  }
  return null;
}

// ---------------------------------------------------------------- AI Content Strategist

export interface StrategistAnswer {
  intent: string;
  answer: string;
  suggestions: { ideaId?: string; contentId?: string; label: string; reason: string; citation: Citation; action?: { type: string; platform?: string; ideaId?: string; contentId?: string; mode?: string } }[];
  facts: string[];
  citations: Citation[];
  generatedBy: string;
  caveats: string[];
}

function ideaCitation(ctx: Ctx, i: Idea): Citation {
  const src = i.sourceIds[0] ? ctx.app.db.get('SELECT title, url FROM sources WHERE id = ? AND workspace_id = ?', i.sourceIds[0], ctx.workspaceId) : null;
  return { refType: 'idea', refId: i.id, title: src ? `${src.title}` : i.coreIdea.slice(0, 40), url: src?.url };
}

/**
 * Answers are built from NetaMeguri data only. Every suggestion carries a citation.
 * The optional AI phrasing step is fact-guarded; numbers come from computed facts only.
 */
export async function askStrategist(ctx: Ctx, question: string, opts: { platform?: string } = {}): Promise<StrategistAnswer> {
  requirePerm(ctx, 'read');
  const q = parseQuery(question);
  const platform = (opts.platform as PlatformId) ?? q.platform ?? null;
  const mem = ideaMemory(ctx);
  const caveats = ['NetaMeguri内のデータのみを根拠にしています。', '過去の反応から将来の成果は保証できません。'];
  let intent = 'search';
  const suggestions: StrategistAnswer['suggestions'] = [];
  const facts: string[] = [];

  const usedOn = (iid: string, p: string) => !!ctx.app.db.get('SELECT 1 FROM idea_uses WHERE idea_id = ? AND platform = ?', iid, p);
  const topicFb = feedback(ctx, 'topic', { days: 90 });
  const goodTopics = new Set(topicFb.groups.filter((g) => g.enough && topicFb.overallMedian != null && g.medianEngagement > topicFb.overallMedian).map((g) => g.key));
  const rankIdeas = (ideas: Idea[]) => [...ideas].sort((a, b) => Number(goodTopics.has(b.topic ?? '')) - Number(goodTopics.has(a.topic ?? '')) || (a.useCount - b.useCount));

  if (/今日|何を投稿|なに.*投稿|投稿したい/.test(question)) {
    intent = 'what_to_post_today';
    const p = platform ?? 'threads';
    const pool = rankIdeas([...mem.unused, ...mem.reusable].filter((i) => !usedOn(i.id, p) && i.status !== 'needs_update'));
    for (const i of pool.slice(0, 3)) suggestions.push({ ideaId: i.id, label: i.coreIdea.slice(0, 60), reason: `${i.useCount === 0 ? '未使用' : `再利用可能（最終使用 ${i.lastUsedAt?.slice(0, 10)}）`}${goodTopics.has(i.topic ?? '') ? '・反応が良い傾向のTopic' : ''}`, citation: ideaCitation(ctx, i), action: { type: 'draft_for_platform', platform: p, ideaId: i.id } });
    facts.push(`未使用Idea: ${mem.unused.length}件`, `直近${getSettings(ctx.app.db, ctx.workspaceId).reuseRules.recentlyUsedDays}日に使用: ${mem.recentlyUsed.length}件`);
    if (topicFb.groups.length) facts.push(topicFb.insight);
  } else if (/使いすぎ|多すぎ|overuse/i.test(question)) {
    intent = 'overused_topics';
    const since = new Date(ctx.app.clock.now().getTime() - 30 * 86400_000).toISOString();
    const rows = ctx.app.db.all('SELECT i.topic, COUNT(*) n FROM idea_uses u JOIN ideas i ON i.id = u.idea_id WHERE u.workspace_id = ? AND u.used_at >= ? GROUP BY i.topic ORDER BY n DESC LIMIT 5', ctx.workspaceId, since);
    for (const r of rows) facts.push(`Topic「${r.topic}」: 過去30日で${r.n}回使用`);
    for (const i of mem.overused.slice(0, 5)) suggestions.push({ ideaId: i.id, label: i.coreIdea.slice(0, 60), reason: `${i.useCount}回使用（Overused）`, citation: ideaCitation(ctx, i) });
  } else if (/反応.*良|伸び|別角度/.test(question)) {
    intent = 'high_performers_new_angle';
    const cands = recyclingCandidates(ctx).filter((c) => c.content.recycleState === 'high_performer');
    const hp = cands.length ? cands.map((c) => c.content) : listContent(ctx, { status: 'published', limit: 500 }).filter((c) => c.recycleState === 'high_performer');
    for (const c of hp.slice(0, 5)) {
      const m = latestMetrics(ctx, c.id);
      suggestions.push({ contentId: c.id, label: (c.title ?? c.body).slice(0, 60), reason: `High Performer（${PLATFORMS[c.platform].label}${m ? `, engagement ${(engagementRate(m)! * 100).toFixed(1)}%` : ''}）`, citation: { refType: 'content', refId: c.id, title: (c.title ?? c.body).slice(0, 40), url: c.externalUrl }, action: { type: 'recycle', contentId: c.id, mode: 'new_angle', platform: platform ?? undefined } });
    }
    facts.push(topicFb.insight);
  } else if (/campaign|キャンペーン/i.test(question) && /足りない|不足|gap/i.test(question)) {
    intent = 'campaign_gaps';
    for (const c of listCampaigns(ctx).filter((c) => c.status !== 'archived' && c.status !== 'completed')) {
      const g = campaignGuard(ctx, c.id);
      for (const w of g.warnings) facts.push(`[${c.name}] ${w.message}`);
      suggestions.push({ label: c.name, reason: `${g.warnings.length}件の確認事項`, citation: { refType: 'campaign', refId: c.id, title: c.name } });
    }
  } else if (/動画|この素材|このソース|から.*案/.test(question)) {
    intent = 'ideas_from_source';
    const src = ctx.app.db.get("SELECT id, title, url FROM sources WHERE workspace_id = ? AND type IN ('video','podcast','audio') ORDER BY imported_at DESC LIMIT 1", ctx.workspaceId);
    const n = Number(/(\d+)\s*(つ|個|案)/.exec(question)?.[1] ?? 5);
    if (src) {
      const ideas = listIdeas(ctx, { sourceId: src.id, limit: 50 }).filter((i) => !platform || !usedOn(i.id, platform));
      for (const i of ideas.slice(0, n)) suggestions.push({ ideaId: i.id, label: i.coreIdea.slice(0, 60), reason: `「${src.title}」から抽出`, citation: { refType: 'source', refId: src.id, title: src.title, url: src.url }, action: { type: 'draft_for_platform', platform: platform ?? 'threads', ideaId: i.id } });
      facts.push(`対象Source: ${src.title}`);
    } else facts.push('動画/音声のSourceがまだありません');
  } else if (q.unused) {
    intent = 'unused_ideas';
    const pool = mem.unused.concat(mem.reusable).filter((i) => !platform || !usedOn(i.id, platform));
    for (const i of rankIdeas(pool).slice(0, 8)) suggestions.push({ ideaId: i.id, label: i.coreIdea.slice(0, 60), reason: platform ? `${PLATFORMS[platform].label}で未使用` : '未使用', citation: ideaCitation(ctx, i), action: { type: 'draft_for_platform', platform: platform ?? 'threads', ideaId: i.id } });
    facts.push(`未使用Idea: ${mem.unused.length}件`);
  } else {
    const r = search(ctx, question, { limit: 8 });
    for (const h of r.hits) suggestions.push({ label: h.title, reason: h.matchedBy.join(', '), citation: h.citation, ...(h.refType === 'idea' ? { ideaId: h.refId } : h.refType === 'content' ? { contentId: h.refId } : {}) });
  }

  const templ = [
    suggestions.length ? `候補を${suggestions.length}件見つけました。` : '該当するデータが見つかりませんでした。',
    ...suggestions.slice(0, 5).map((s, i) => `${i + 1}. ${s.label}（${s.reason}）`),
    ...facts.map((f) => `・${f}`),
  ].join('\n');
  const allowed = [templ, ...facts, ...suggestions.map((s) => `${s.label} ${s.reason}`)];
  const ai = await ctx.app.ai.run(
    ctx.workspaceId,
    { task: 'strategist', system: 'You are a content strategist inside NetaMeguri. Rephrase the provided findings in concise Japanese. Do not add facts, numbers, testimonials or promises of results.', instruction: `Question: ${question}\nRephrase these findings:`, data: templ },
    { eligible: strategistEligible(ctx, suggestions), allowed, fallback: () => templ },
  );
  return { intent, answer: ai.text, suggestions, facts, citations: suggestions.map((s) => s.citation), generatedBy: ai.usedProvider, caveats };
}

/** External rephrasing only if every idea/content/source behind the answer allows external AI. */
function strategistEligible(ctx: Ctx, suggestions: StrategistAnswer['suggestions']) {
  for (const s of suggestions) {
    let sourceIds: string[] = [];
    let brandId: string | null = null;
    if (s.ideaId) {
      const r = ctx.app.db.get('SELECT source_ids, brand_id FROM ideas WHERE id = ? AND workspace_id = ?', s.ideaId, ctx.workspaceId);
      sourceIds = j<string[]>(r?.source_ids, []);
      brandId = r?.brand_id ?? null;
    } else if (s.contentId) {
      const r = ctx.app.db.get('SELECT source_ids, brand_id FROM content_items WHERE id = ? AND workspace_id = ?', s.contentId, ctx.workspaceId);
      sourceIds = j<string[]>(r?.source_ids, []);
      brandId = r?.brand_id ?? null;
    } else if (s.citation.refType === 'source') sourceIds = [s.citation.refId];
    if (!sourcesAllowAI(ctx, sourceIds) || !brandAllows(ctx, brandId)) return false;
  }
  return true;
}
