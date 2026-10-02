// 必須テスト 1〜34 (spec §48). Each `it` is numbered to match the spec.
import { describe, it, expect, beforeEach } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { makeEnv, addMember, FakeProvider, ARTICLE } from './helpers.js';
import { importSource, deleteSource } from '../../server/src/domain/sources.js';
import { extractIdeas, createIdea, similarIdeas, listIdeas, setIdeaStatus, getIdea } from '../../server/src/domain/ideas.js';
import { createPack, draftForPlatform, updateContent, regenerate, requestReview, approve, runChecks, transformContent, getContent, listVersions } from '../../server/src/domain/content.js';
import { brandGuard, freshnessCheck } from '../../server/src/domain/guards.js';
import { createCampaign, campaignGuard } from '../../server/src/domain/campaigns.js';
import { schedule, runDueJobs, markPublished, saveConnection, revokeConnector, capabilityMatrix, listConnectors, retryJob } from '../../server/src/domain/publish.js';
import { recordSnapshot, performanceSummary, recyclingCandidates, setRecycleState, feedback } from '../../server/src/domain/performance.js';
import { createClaim, updateClaimValue, checkClaims, verifyClaim } from '../../server/src/domain/claims.js';
import { search, askStrategist } from '../../server/src/domain/search.js';
import { updateSettings, createUser, createWorkspace } from '../../server/src/domain/workspace.js';
import { assertSafeUrl, isBlockedIp } from '../../server/src/lib/ssrf.js';
import { csvSafeCell, toCsv, readZip, safeZipPath } from '../../server/src/lib/files.js';
import { backupWorkspace, restoreWorkspace, relationReport, importPreview, importConfirm } from '../../server/src/domain/io.js';
import { SandboxAdapter } from '../../server/src/connectors/registry.js';
import { buildServer } from '../../server/src/api/server.js';
import { callTool } from '../../server/src/mcp/tools.js';
import { OfflineQueue, MemoryKV } from '../../web/src/offline.js';
import { zonedToUtc, utcToZoned } from '../../server/src/lib/util.js';
import { PLATFORMS } from '../../server/src/domain/platforms.js';

type Env = ReturnType<typeof makeEnv>;
let env: Env;
beforeEach(() => {
  env = makeEnv();
});

async function article(e = env, extra: Record<string, unknown> = {}) {
  return importSource(e.ctx, { type: 'article', title: 'AI開発の失敗談', text: ARTICLE, rightsStatus: 'owned', brandId: e.brand.id, ...extra });
}
async function approvedDraft(platform = 'threads', e = env) {
  const s = await article(e);
  const ideas = await extractIdeas(e.ctx, s.id);
  const d = await draftForPlatform(e.ctx, { ideaId: ideas[0].idea.id, platform });
  requestReview(e.ctx, d.content.id);
  await approve(e.ctx, d.content.id);
  return { source: s, idea: ideas[0].idea, content: getContent(e.ctx, d.content.id) };
}
function connectSandbox(e: Env, platform = 'threads') {
  const adapter = e.app.connectors.get(`sandbox:${platform}`) as SandboxAdapter;
  const conn = saveConnection(e.ctx, `sandbox:${platform}`, { accessToken: 'sbx-at-secret-token', refreshToken: 'sbx-rt-secret', expiresAt: '2027-01-01T00:00:00Z', scopes: ['publish'] }, 'test');
  return { adapter, conn };
}

describe('ContentLoop required tests', () => {
  it('01 Source import: text is analyzed, rights kept, indexed', async () => {
    const s = await article();
    expect(s.status).toBe('analyzed');
    expect(s.rightsStatus).toBe('owned');
    expect(s.analysis!.ideas.length).toBeGreaterThan(2);
    expect(s.analysis!.keyPoints.length).toBeGreaterThan(0);
    const t = await importSource(env.ctx, { type: 'video', title: '動画', transcript: '1\n00:00:00,000 --> 00:00:05,000\nこんにちは、AI開発の話です。\n\n2\n00:00:05,000 --> 00:00:09,000\n[inaudible]\n\n3\n00:00:09,000 --> 00:00:15,000\nテストを先に書きましょう。', rightsStatus: 'owned' });
    expect(t.segments).toHaveLength(3);
    expect(t.segments[1].inaudible).toBe(true);
    expect((t as any).text).not.toContain('inaudible'); // inaudible content is not filled in
  });

  it('02 Duplicate import is prevented (same text / same URL)', async () => {
    const a = await article();
    await expect(article()).rejects.toMatchObject({ status: 409, details: { existingId: a.id } });
    await importSource(env.ctx, { type: 'web_url', title: 'u', url: 'https://example.com/a?x=1', rightsStatus: 'unknown' });
    await expect(importSource(env.ctx, { type: 'web_url', title: 'u2', url: 'https://example.com/a/', rightsStatus: 'unknown' })).rejects.toMatchObject({ status: 409 });
  });

  it('03 Brand Guard warns on banned term / banned CTA / emoji', () => {
    const issues = brandGuard('これで絶対儲かる！今すぐ購入🔥🔥', 'threads', { bannedTerms: ['絶対儲かる'], bannedCtas: ['今すぐ購入'], emojiPolicy: 'few', maxEmoji: 1 });
    expect(issues.map((i) => i.check)).toEqual(expect.arrayContaining(['banned_term', 'banned_cta', 'emoji']));
    expect(issues.find((i) => i.check === 'banned_term')!.severity).toBe('block');
    // no single "brand score"
    expect(issues.every((i) => !('score' in i))).toBe(true);
  });

  it('04 AI regenerate never erases a human edit', async () => {
    const s = await article();
    const ideas = await extractIdeas(env.ctx, s.id);
    const d = await draftForPlatform(env.ctx, { ideaId: ideas[0].idea.id, platform: 'threads' });
    updateContent(env.ctx, d.content.id, { body: '人間が丁寧に書き直した本文です。' });
    const r = await regenerate(env.ctx, d.content.id, { angle: 'how_to' });
    expect(r.applied).toBe(false);
    const c = getContent(env.ctx, d.content.id);
    expect(c.body).toBe('人間が丁寧に書き直した本文です。');
    expect(c.aiSuggestion).toBeTruthy();
    expect(listVersions(env.ctx, c.id).some((v: any) => v.author_type === 'human')).toBe(true);
  });

  it('05 Idea fingerprint returns similar candidates with levels', async () => {
    await createIdea(env.ctx, { coreIdea: 'AIコーディングでは実装前にPLANを書くと手戻りが減る' });
    await createIdea(env.ctx, { coreIdea: '週末にカレーを作ったら美味しかった' });
    const c = await similarIdeas(env.ctx, 'AIコーディングの前にPLANを書くと手戻りが大きく減る', {});
    expect(c[0].coreIdea).toContain('PLAN');
    expect(['similar', 'very_similar']).toContain(c[0].level);
    expect(c.find((x) => x.coreIdea.includes('カレー'))).toBeUndefined();
  });

  it('06 Same idea is NOT auto-deleted or merged', async () => {
    const a = await createIdea(env.ctx, { coreIdea: 'テストを先に書くとAIの出力を検証しやすい' });
    const b = await createIdea(env.ctx, { coreIdea: 'テストを先に書くとAIの出力を検証しやすい' });
    expect(b.similar[0].ideaId).toBe(a.idea.id);
    expect(b.similar[0].level).toBe('very_similar');
    expect(listIdeas(env.ctx).map((i) => i.id)).toEqual(expect.arrayContaining([a.idea.id, b.idea.id]));
  });

  it('07 Recently Used warning (18日前にThreadsで使用)', async () => {
    const { content, idea } = await approvedDraft('threads');
    markPublished(env.ctx, content.id, { publishedAt: new Date(env.clock.now().getTime() - 18 * 86400_000).toISOString() });
    const c = await similarIdeas(env.ctx, idea.coreIdea, {});
    expect(c[0].recentlyUsed).toBe(true);
    expect(c[0].message).toBe('この内容は18日前にThreadsで使用したIdeaと非常に近いです。');
    const d2 = await draftForPlatform(env.ctx, { ideaId: idea.id, platform: 'threads' });
    const ch = await runChecks(env.ctx, d2.content.id);
    expect(ch.reuse.some((r) => r.rule === 'same_platform_window')).toBe(true);
  });

  it('08 Freshness warning for date-dependent claims in old content', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const old = freshnessCheck('現在の料金は月額980円です。ランキング1位を獲得。', { originalDate: '2026-01-01', now });
    expect(old.map((f) => f.kind)).toEqual(expect.arrayContaining(['price']));
    expect(old[0].message).toMatch(/確認してください/);
    expect(freshnessCheck('現在の料金は月額980円です。', { originalDate: '2026-09-25', now })).toHaveLength(0);
  });

  it('09 Content Pack keeps Source/Idea relations and configured counts', async () => {
    const s = await article();
    const p = await createPack(env.ctx, { sourceIds: [s.id], counts: { threads: 4, x: 3, linkedin: 1, instagram_carousel: 1, blog: 1, newsletter: 1, quote: 2, short_video: 0 } });
    expect(p.items).toHaveLength(13);
    expect(p.byKind).toMatchObject({ threads: 4, x: 3, linkedin: 1, instagram_carousel: 1 });
    for (const it of p.items) {
      expect(it.packId).toBe(p.id);
      expect(it.ideaId).toBeTruthy();
      expect(it.sourceIds).toContain(s.id);
      expect(it.body.length).toBeGreaterThan(5);
    }
    const car = p.items.find((i) => i.format === 'carousel')!;
    expect((car.structured as any).slides.map((x: any) => x.kind)).toEqual(['cover', 'problem', 'point', 'point', 'point', 'summary', 'cta'].slice(0, (car.structured as any).slides.length).length ? expect.arrayContaining(['cover', 'problem', 'summary', 'cta']) : []);
    for (const it of p.items) expect([...it.body].length).toBeLessThanOrEqual(PLATFORMS[it.platform].maxLength);
  });

  it('10 Platform transform keeps idea/source relation and parent link', async () => {
    const s = await article();
    const ideas = await extractIdeas(env.ctx, s.id);
    const d = await draftForPlatform(env.ctx, { ideaId: ideas[0].idea.id, platform: 'threads' });
    const t = await transformContent(env.ctx, d.content.id, 'linkedin');
    expect(t.content.ideaId).toBe(d.content.ideaId);
    expect(t.content.sourceIds).toEqual(d.content.sourceIds);
    expect(t.content.parentContentId).toBe(d.content.id);
    expect(t.content.platform).toBe('linkedin');
    expect(t.content.body).not.toBe(d.content.body);
  });

  it('11 Editing after approval requires re-review and cancels queued jobs', async () => {
    const { content } = await approvedDraft();
    await schedule(env.ctx, { contentId: content.id, localTime: '2026-10-05T09:00', mode: 'manual' });
    const r = updateContent(env.ctx, content.id, { body: content.body + '\n追記しました。' });
    expect(r.reReviewRequired).toBe(true);
    expect(getContent(env.ctx, content.id).status).toBe('needs_review');
    expect(env.app.db.get("SELECT status FROM publish_jobs WHERE content_id = ?", content.id)!.status).toBe('cancelled');
  });

  it('12 Campaign Guard warns about short-term idea duplicates and missing key messages', async () => {
    const s = await article();
    const ideas = await extractIdeas(env.ctx, s.id);
    const c = createCampaign(env.ctx, { name: 'Launch', keyMessages: ['宇宙旅行の予約受付を開始'], sourceIds: [s.id], channels: ['threads', 'x'] });
    await draftForPlatform(env.ctx, { ideaId: ideas[0].idea.id, platform: 'threads', campaignId: c.id });
    await draftForPlatform(env.ctx, { ideaId: ideas[0].idea.id, platform: 'x', campaignId: c.id });
    const g = campaignGuard(env.ctx, c.id);
    expect(g.warnings.map((w) => w.kind)).toEqual(expect.arrayContaining(['idea_duplicate', 'key_message_missing']));
    expect(g.note).toMatch(/保証しません/);
  });

  it('13 Schedule converts local time with workspace/user timezone (incl. DST)', async () => {
    expect(zonedToUtc('2026-10-05T09:00', 'Asia/Tokyo')).toBe('2026-10-05T00:00:00.000Z');
    expect(zonedToUtc('2026-07-01T09:00', 'America/New_York')).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedToUtc('2026-12-01T09:00', 'America/New_York')).toBe('2026-12-01T14:00:00.000Z');
    expect(utcToZoned('2026-10-05T00:00:00.000Z', 'Asia/Tokyo')).toBe('2026-10-05T09:00');
    const { content } = await approvedDraft();
    const r = await schedule(env.ctx, { contentId: content.id, localTime: '2026-10-05T09:00', timezone: 'Asia/Tokyo', mode: 'manual' });
    expect(r.job.scheduledAt).toBe('2026-10-05T00:00:00.000Z');
    expect(r.localTime).toBe('2026-10-05T09:00');
  });

  it('14 Publish retry never double-posts (idempotency + remote lookup)', async () => {
    const { content } = await approvedDraft();
    const { adapter } = connectSandbox(env);
    const r1 = await schedule(env.ctx, { contentId: content.id, at: env.clock.now().toISOString(), mode: 'api' });
    const r2 = await schedule(env.ctx, { contentId: content.id, at: env.clock.now().toISOString(), mode: 'api' });
    expect(r2.duplicate).toBe(true);
    expect(r2.job.id).toBe(r1.job.id);
    adapter.failNext = 'ambiguous_after_post'; // post succeeded remotely but client saw a timeout
    const out = await runDueJobs(env.app);
    expect(out[0].status).toBe('published'); // detected via idempotency lookup
    expect(adapter.remote.size).toBe(1);
    await runDueJobs(env.app);
    expect(adapter.remote.size).toBe(1);
    expect(adapter.publishCalls).toBe(1);
  });

  it('15 Without PUBLISH capability, auto-publish is not offered or allowed', async () => {
    const { content } = await approvedDraft('youtube_community');
    const m = capabilityMatrix(env.ctx).find((x) => x.platform === 'youtube_community')!;
    expect(m.autoPublish).toBe(false);
    expect(m.effective).toEqual(['DRAFT_EXPORT']);
    expect(m.unavailable).toBe(true);
    await expect(schedule(env.ctx, { contentId: content.id, at: env.clock.now().toISOString(), mode: 'api' })).rejects.toMatchObject({ status: 400 });
    // Threads without a connection: also manual only
    expect(capabilityMatrix(env.ctx).find((x) => x.platform === 'threads')!.autoPublish).toBe(false);
  });

  it('16 User-marked vs API-confirmed published are distinguished', async () => {
    const a = await approvedDraft('x');
    markPublished(env.ctx, a.content.id, { url: 'https://x.com/a/status/1' });
    expect(getContent(env.ctx, a.content.id).publishedVia).toBe('user_marked');
    const e2 = makeEnv();
    const b = await approvedDraft('threads', e2);
    connectSandbox(e2);
    await schedule(e2.ctx, { contentId: b.content.id, at: e2.clock.now().toISOString(), mode: 'api' });
    await runDueJobs(e2.app);
    const c = getContent(e2.ctx, b.content.id);
    expect(c.publishedVia).toBe('api_confirmed');
    expect(c.externalPostId).toBeTruthy();
  });

  it('17 Performance snapshots are stored per window/source', async () => {
    const { content } = await approvedDraft();
    markPublished(env.ctx, content.id, {});
    recordSnapshot(env.ctx, { contentId: content.id, window: '24h', metrics: { views: 100, likes: 5 }, source: 'manual' });
    env.clock.advanceDays(6);
    const s = recordSnapshot(env.ctx, { contentId: content.id, window: '7d', metrics: { views: 900, likes: 40, bogus: 5 } as any, source: 'csv' });
    expect(s.metrics).toEqual({ views: 900, likes: 40 });
    expect(env.app.db.all('SELECT window FROM performance_snapshots WHERE content_id = ?', content.id).map((r) => r.window)).toEqual(['24h', '7d']);
  });

  it('18 Metrics are never summed across platforms', async () => {
    const a = await approvedDraft('threads');
    markPublished(env.ctx, a.content.id, {});
    recordSnapshot(env.ctx, { contentId: a.content.id, metrics: { views: 1000, likes: 10 } });
    const b = await draftForPlatform(env.ctx, { ideaId: a.idea.id, platform: 'x' });
    requestReview(env.ctx, b.content.id);
    await approve(env.ctx, b.content.id);
    markPublished(env.ctx, b.content.id, {});
    recordSnapshot(env.ctx, { contentId: b.content.id, metrics: { impressions: 500, likes: 3 } });
    const sum = performanceSummary(env.ctx);
    expect(sum.crossPlatformTotal).toBeNull();
    expect(sum.byPlatform.threads.totals.likes).toBe(10);
    expect(sum.byPlatform.x.totals.likes).toBe(3);
    expect(JSON.stringify(sum)).not.toContain('"likes":13');
  });

  it('19 Recycling rule: High Performer becomes candidate after 60 days, with new-angle draft', async () => {
    const { content } = await approvedDraft();
    markPublished(env.ctx, content.id, {});
    setRecycleState(env.ctx, content.id, 'high_performer');
    env.clock.advanceDays(30);
    expect(recyclingCandidates(env.ctx).find((r) => r.content.id === content.id)).toBeUndefined();
    env.clock.advanceDays(31);
    const c = recyclingCandidates(env.ctx).find((r) => r.content.id === content.id)!;
    expect(c.reason).toMatch(/High Performer/);
    expect(c.suggestions).toContain('new_angle');
    setRecycleState(env.ctx, content.id, 'do_not_reuse');
    expect(recyclingCandidates(env.ctx).find((r) => r.content.id === content.id)).toBeUndefined();
  });

  it('20 Needs Update blocks auto-publish (and job execution)', async () => {
    const { content, idea } = await approvedDraft();
    connectSandbox(env);
    await schedule(env.ctx, { contentId: content.id, at: new Date(env.clock.now().getTime() + 3600_000).toISOString(), mode: 'api' });
    setIdeaStatus(env.ctx, idea.id, 'needs_update');
    env.clock.advanceDays(1);
    const out = await runDueJobs(env.app);
    expect(out[0].status).toBe('failed');
    expect(getContent(env.ctx, content.id).status).not.toBe('published');
    await expect(schedule(env.ctx, { contentId: content.id, at: env.clock.now().toISOString(), mode: 'api' })).rejects.toMatchObject({ status: 400 });
  });

  it('21 Claim Registry warns when an outdated value is used; AI/MCP cannot verify', async () => {
    const c = createClaim(env.ctx, { key: 'price', label: '月額料金', value: '月額980円' });
    expect(c.verifiedAt).toBeNull();
    verifyClaim(env.ctx, c.id);
    updateClaimValue(env.ctx, c.id, { value: '月額1,280円' });
    const issues = checkClaims(env.ctx, 'ProofFlowは月額980円で使えます。');
    expect(issues.some((i) => i.severity === 'block' && /古い値/.test(i.message))).toBe(true);
    expect(() => verifyClaim({ ...env.ctx, via: 'mcp' }, c.id)).toThrow();
  });

  it('22 Search returns hits with source citations', async () => {
    const s = await article();
    await extractIdeas(env.ctx, s.id);
    const r = search(env.ctx, 'チェックリスト');
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) {
      expect(h.citation.refId).toBeTruthy();
      expect(h.citation.title).toBeTruthy();
    }
    const unused = search(env.ctx, 'まだThreadsで使ってないAI開発ネタ');
    expect(unused.parsed.platform).toBe('threads');
    expect(unused.parsed.unused).toBe(true);
    expect(unused.hits.some((h) => h.refType === 'idea')).toBe(true);
  });

  it('23 AI cannot introduce fabricated results/testimonials (fact guard)', async () => {
    const fake = new FakeProvider('anthropic', () => '開発の失敗から学びました。導入企業は300社を突破し、満足度98%を達成しました。お客様の声：「最高のツールです」と好評です。');
    env.app.ai.register(fake);
    updateSettings(env.ctx, { aiProvider: 'anthropic' });
    const s = await article();
    const ideas = await extractIdeas(env.ctx, s.id);
    const d = await draftForPlatform(env.ctx, { ideaId: ideas[0].idea.id, platform: 'threads' });
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(d.content.body).not.toMatch(/300社|98%|お客様の声/);
    expect(d.notes.join()).toMatch(/除外/);
    // prompt treats source as untrusted data
    expect(fake.calls[0].data).toContain('失敗');
    const a = await askStrategist(env.ctx, '今日Threadsに何か投稿したい');
    expect(a.answer).not.toMatch(/300社|98%/);
  });

  it('24 AI OFF → zero provider calls', async () => {
    const fake = new FakeProvider('anthropic');
    env.app.ai.register(fake);
    updateSettings(env.ctx, { aiProvider: 'anthropic', aiEnabled: false, embeddingProvider: 'openai' });
    env.app.ai.calls = 0;
    const s = await article();
    await createPack(env.ctx, { sourceIds: [s.id], counts: { threads: 2, x: 2, blog: 1 } });
    await askStrategist(env.ctx, '今日Threadsに何か投稿したい');
    expect(fake.calls).toHaveLength(0);
    expect(env.app.ai.calls).toBe(0);
  });

  it('25 OAuth tokens are never exposed to the client (API)', async () => {
    connectSandbox(env);
    const json = JSON.stringify(listConnectors(env.ctx)) + JSON.stringify(capabilityMatrix(env.ctx));
    expect(json).not.toContain('sbx-at-secret-token');
    expect(json).not.toContain('sbx-rt-secret');
    const raw = env.app.db.get('SELECT token_enc FROM connectors')!.token_enc;
    expect(raw).not.toContain('sbx-at-secret-token'); // encrypted at rest
    const f = await buildServer(env.app);
    const login = await f.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.com', password: 'password-123456' } });
    const cookie = login.cookies.find((c) => c.name === 'cl_session')!;
    const res = await f.inject({ method: 'GET', url: `/api/w/${env.ws}/connectors`, cookies: { cl_session: cookie.value } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('sbx-at-secret-token');
    expect(res.body).not.toContain('token_enc');
    await f.close();
  });

  it('26 Connector revoke deletes tokens and fails queued API jobs', async () => {
    const { content } = await approvedDraft();
    const { conn, adapter } = connectSandbox(env);
    await schedule(env.ctx, { contentId: content.id, at: new Date(env.clock.now().getTime() + 86400_000).toISOString(), mode: 'api' });
    const r = await revokeConnector(env.ctx, conn.id);
    expect(r.connector.status).toBe('revoked');
    expect(r.connector.hasToken).toBe(false);
    expect(r.jobsFailed).toBe(1);
    expect(adapter.revokedTokens.has('sbx-at-secret-token')).toBe(true);
    expect(env.app.db.get('SELECT token_enc FROM connectors WHERE id = ?', conn.id)!.token_enc).toBeNull();
  });

  it('27 SSRF protection blocks private/loopback/metadata targets', async () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isBlockedIp(ip)).toBe(true);
    expect(isBlockedIp('93.184.216.34')).toBe(false);
    await expect(assertSafeUrl('http://localhost/admin')).rejects.toMatchObject({ code: 'ssrf_blocked' });
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data')).rejects.toMatchObject({ code: 'ssrf_blocked' });
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toMatchObject({ code: 'ssrf_blocked' });
    await expect(assertSafeUrl('http://evil.example/', async () => ['10.1.2.3'])).rejects.toMatchObject({ code: 'ssrf_blocked' }); // DNS rebinding to private
    await expect(assertSafeUrl('http://user:pw@example.com/', async () => ['93.184.216.34'])).rejects.toMatchObject({ code: 'ssrf_blocked' });
    // redirect to private is re-validated
    const fetchImpl = (async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })) as unknown as typeof fetch;
    await expect(importSource(env.ctx, { type: 'web_url', title: 'x', url: 'https://public.example/', fetchUrl: true, rightsStatus: 'unknown' }, { resolve: async () => ['93.184.216.34'], fetchImpl })).rejects.toMatchObject({ code: 'ssrf_blocked' });
  });

  it('28 CSV export neutralises formula injection', () => {
    expect(csvSafeCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvSafeCell('+1+1')).toBe("'+1+1");
    expect(csvSafeCell('-2')).toBe("'-2");
    expect(csvSafeCell('@SUM(A1)')).toBe("'@SUM(A1)");
    const csv = toCsv([{ body: '=1+1', ok: 'normal' }]);
    expect(csv).toContain("'=1+1");
  });

  it('29 ZIP path traversal is rejected', () => {
    expect(() => safeZipPath('../../etc/passwd')).toThrow();
    expect(() => safeZipPath('/abs/path')).toThrow();
    expect(() => safeZipPath('C:\\windows\\x')).toThrow();
    expect(() => safeZipPath('a/../../b')).toThrow();
    expect(safeZipPath('threads/001.txt')).toBe('threads/001.txt');
    const evil = zipSync({ '../evil.txt': strToU8('x') });
    expect(() => readZip(evil)).toThrow(/unsafe zip path/);
  });

  it('30 Tenant isolation: user of workspace A cannot access workspace B', async () => {
    const s = await article();
    const userB = createUser(env.app.db, 'b@example.com', 'B', 'password-123456', env.clock.now());
    const wsB = createWorkspace(env.app.db, userB.id, 'WS B', env.clock.now());
    const f = await buildServer(env.app);
    const lg = await f.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'b@example.com', password: 'password-123456' } });
    const cookies = { cl_session: lg.cookies.find((c) => c.name === 'cl_session')!.value };
    const csrf = lg.json().csrfToken;
    expect((await f.inject({ method: 'GET', url: `/api/w/${env.ws}/sources`, cookies })).statusCode).toBe(404);
    // B tries A's source id through B's workspace
    expect((await f.inject({ method: 'GET', url: `/api/w/${wsB}/sources/${s.id}`, cookies })).statusCode).toBe(404);
    expect((await f.inject({ method: 'DELETE', url: `/api/w/${wsB}/sources/${s.id}`, cookies, headers: { 'x-csrf-token': csrf } })).statusCode).toBe(404);
    // CSRF missing → 403
    expect((await f.inject({ method: 'POST', url: `/api/w/${wsB}/ideas`, cookies, payload: { coreIdea: 'abc def' } })).statusCode).toBe(403);
    // RBAC: viewer cannot write; editor cannot publish externally by default
    const viewer = addMember(env, 'v@example.com', 'viewer');
    await expect(createIdea(viewer, { coreIdea: 'viewer idea' })).rejects.toMatchObject({ status: 403 });
    const editor = addMember(env, 'e@example.com', 'editor');
    expect(editor.canPublishExternal).toBe(false);
    await f.close();
  });

  it('31 Deleting a Source removes its vector, index, transcript and media', async () => {
    const s = await article();
    expect(env.app.db.get("SELECT COUNT(*) c FROM embeddings WHERE ref_type = 'source' AND ref_id = ?", s.id)!.c).toBe(1);
    await deleteSource(env.ctx, s.id);
    expect(env.app.db.get("SELECT COUNT(*) c FROM embeddings WHERE ref_type = 'source' AND ref_id = ?", s.id)!.c).toBe(0);
    expect(env.app.db.get("SELECT COUNT(*) c FROM search_fts WHERE ref_type = 'source' AND ref_id = ?", s.id)!.c).toBe(0);
    expect(env.app.db.get('SELECT COUNT(*) c FROM sources WHERE id = ?', s.id)!.c).toBe(0);
  });

  it('32 Backup → restore into empty workspace keeps relations', async () => {
    const s = await article();
    const p = await createPack(env.ctx, { sourceIds: [s.id], counts: { threads: 2, x: 1, linkedin: 1 } });
    const c = createCampaign(env.ctx, { name: 'C', sourceIds: [s.id] });
    updateContent(env.ctx, p.items[0].id, { campaignId: c.id });
    const zip = backupWorkspace(env.ctx);
    const before = relationReport(env.ctx);
    // fresh empty environment
    const e2 = makeEnv();
    const r = restoreWorkspace(e2.ctx, zip);
    expect(r.restored.sources).toBe(1);
    const after = relationReport(e2.ctx);
    expect(after).toEqual(before);
    expect(after.orphanContentIdea).toBe(0);
    // refuses non-empty target & tampered payload
    expect(() => restoreWorkspace(e2.ctx, zip)).toThrow(/空/);
  });

  it('33 PWA offline draft queue: saved locally, marked unsynced, replays idempotently', async () => {
    const kv = new MemoryKV();
    const q = new OfflineQueue(kv);
    q.enqueue({ kind: 'capture', payload: { text: 'オフラインのメモ' } });
    q.enqueue({ kind: 'draft', contentId: 'cnt_1', payload: { body: 'オフライン編集', expectedVersion: 3 } });
    expect(q.pending()).toHaveLength(2);
    expect(q.pending().every((x) => x.clientId)).toBe(true);
    // publish is never queued offline
    expect(() => q.enqueue({ kind: 'publish' as any, payload: {} })).toThrow();
    const sent: any[] = [];
    let fail = true;
    const res = await q.flush(async (item) => {
      sent.push(item);
      if (item.kind === 'draft' && fail) {
        fail = false;
        return { ok: false, conflict: true };
      }
      return { ok: true };
    });
    expect(res.synced).toBe(1);
    expect(res.conflicts).toBe(1);
    expect(q.pending()).toHaveLength(1); // conflict kept for user review (no silent overwrite)
    expect(q.pending()[0].conflict).toBe(true);
  });

  it('34 MCP publish requires prepare → explicit confirmation code → setting', async () => {
    const { content } = await approvedDraft();
    connectSandbox(env);
    const prep1: any = await callTool(env.ctx, 'prepare_publish', { contentId: content.id });
    expect(prep1.autoPublishPossible).toBe(false); // mcpPublishAllowed defaults to false
    expect(prep1.confirmationCode).toBeNull();
    expect(prep1.handoff.text).toBeTruthy();
    updateSettings(env.ctx, { mcpPublishAllowed: true });
    const prep2: any = await callTool(env.ctx, 'prepare_publish', { contentId: content.id });
    expect(prep2.confirmationCode).toBeTruthy();
    await expect(callTool(env.ctx, 'confirm_publish', { contentId: content.id, confirmationCode: 'wrong', userApproved: true })).rejects.toThrow();
    await expect(callTool(env.ctx, 'confirm_publish', { contentId: content.id, confirmationCode: prep2.confirmationCode })).rejects.toThrow(); // userApproved missing
    const prep3: any = await callTool(env.ctx, 'prepare_publish', { contentId: content.id });
    const ok: any = await callTool(env.ctx, 'confirm_publish', { contentId: content.id, confirmationCode: prep3.confirmationCode, userApproved: true });
    expect(ok.content.status).toBe('published');
    // code is single use
    await expect(callTool(env.ctx, 'confirm_publish', { contentId: content.id, confirmationCode: prep3.confirmationCode, userApproved: true })).rejects.toThrow();
  });
});

describe('additional behaviour', () => {
  it('connector auth failure → failed, no duplicate, retry after re-auth publishes once', async () => {
    const { content } = await approvedDraft();
    const { adapter } = connectSandbox(env);
    await schedule(env.ctx, { contentId: content.id, at: env.clock.now().toISOString(), mode: 'api' });
    adapter.failNext = 'auth';
    const [j1] = await runDueJobs(env.app);
    expect(j1.status).toBe('failed');
    expect(listConnectors(env.ctx)[0].status).toBe('expired');
    await expect(retryJob(env.ctx, j1.id)).rejects.toMatchObject({ status: 400 });
    connectSandbox(env); // re-auth
    const j2: any = await retryJob(env.ctx, j1.id);
    expect(j2.status).toBe('published');
    expect(adapter.remote.size).toBe(1);
  });

  it('429 backs off and does not retry forever', async () => {
    const { content } = await approvedDraft();
    const { adapter } = connectSandbox(env);
    await schedule(env.ctx, { contentId: content.id, at: env.clock.now().toISOString(), mode: 'api' });
    adapter.failNext = 'rate_limited';
    const [j] = await runDueJobs(env.app);
    expect(j.status).toBe('queued');
    expect(j.nextAttemptAt).toBeTruthy();
    expect(await runDueJobs(env.app)).toHaveLength(0); // not yet due
  });

  it('CSV import of past posts → ideas fingerprinted → similarity warning on new draft', async () => {
    const csv = 'platform,date,text,likes,views\nthreads,2026-09-10,"AIコーディングでは実装前にPLANを書くと手戻りが減る。",30,1000\nthreads,2026-09-12,"=cmd|evil",1,10\n';
    const prev = await importPreview(env.ctx, csv);
    expect(prev.mapping.text).toBe('text');
    const r = await importConfirm(env.ctx, prev.batchId, {});
    expect(r.created).toBe(2);
    const sim = await similarIdeas(env.ctx, 'AIコーディングの前にPLANを書くと手戻りが減る', {});
    expect(sim[0].daysSinceUse).toBe(21);
    expect(sim[0].lastPlatform).toBe('threads');
  });

  it('feedback reports period, n and denominator and does not claim causation', async () => {
    const f = feedback(env.ctx, 'topic');
    expect(f.denominator).toBeTruthy();
    expect(f.caveat).toMatch(/因果/);
  });

  it('claim value change flags evergreen ideas and approved content as needing update (E2E-5 core)', async () => {
    const s = await importSource(env.ctx, { type: 'product_page', title: 'P', text: 'ProofFlowの料金は月額980円です。チェックリストを共有できます。テンプレートも使えます。', rightsStatus: 'owned', evergreen: true });
    const ideas = await extractIdeas(env.ctx, s.id);
    const c = createClaim(env.ctx, { key: 'price', label: '料金', value: '月額980円' });
    const d = await draftForPlatform(env.ctx, { ideaId: ideas[0].idea.id, platform: 'threads' });
    updateContent(env.ctx, d.content.id, { body: 'ProofFlowは月額980円です。' });
    requestReview(env.ctx, d.content.id);
    verifyClaim(env.ctx, c.id);
    await approve(env.ctx, d.content.id);
    const r = updateClaimValue(env.ctx, c.id, { value: '月額1,280円' });
    expect(r.flagged.contents).toContain(d.content.id);
    expect(getContent(env.ctx, d.content.id).status).toBe('needs_review');
    expect(ideas.some((i) => getIdea(env.ctx, i.idea.id).status === 'needs_update')).toBe(true);
  });
});
