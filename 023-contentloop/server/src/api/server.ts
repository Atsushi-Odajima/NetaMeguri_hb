import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import type { App, Ctx } from '../domain/context.js';
import { AppError, badRequest, escapeForHtml } from './helpers.js';
import * as W from '../domain/workspace.js';
import * as B from '../domain/brand.js';
import * as S from '../domain/sources.js';
import * as I from '../domain/ideas.js';
import * as C from '../domain/content.js';
import * as P from '../domain/publish.js';
import * as PF from '../domain/performance.js';
import * as CM from '../domain/campaigns.js';
import * as CL from '../domain/claims.js';
import * as SR from '../domain/search.js';
import * as IO from '../domain/io.js';
import * as M from '../domain/misc.js';
import * as N from '../domain/notifications.js';
import { PLATFORMS, PACK_KINDS } from '../domain/platforms.js';
import { buildSubtitles } from '../ai/transcription.js';
import { getSegments } from '../domain/sources.js';
import { seedSample } from '../seed/sample.js';
import { getScoped } from '../domain/context.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { userId: string; email: string; name: string; csrfToken: string };
    sessionId?: string;
  }
}

const COOKIE = 'cl_session';

// simple fixed-window rate limiter (per IP + bucket)
const windows = new Map<string, { n: number; reset: number }>();
function rateLimit(key: string, max: number, windowMs = 60_000) {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || w.reset < now) {
    windows.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  if (++w.n > max) throw new AppError(429, 'rate_limited', 'リクエストが多すぎます。しばらく待ってから再試行してください');
}

export interface ServerOptions { webDist?: string; secureCookies?: boolean; allowSample?: boolean; logger?: boolean; testMode?: boolean }

export async function buildServer(app: App, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const f = Fastify({ logger: opts.logger ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'] } : false, bodyLimit: 12 * 1024 * 1024, trustProxy: true });
  await f.register(cookie);
  await f.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, files: 1 } });
  f.addContentTypeParser(['application/zip', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 300 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  f.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; manifest-src 'self'; worker-src 'self'");
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  f.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'validation', message: '入力内容を確認してください', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message });
    req.log?.error({ err: { message: err.message, stack: err.stack } }, 'unhandled');
    return reply.status(500).send({ error: 'internal', message: 'サーバーエラーが発生しました' });
  });

  // ---- auth / csrf / rate limit ----
  f.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const ip = req.ip;
    const path = req.url.split('?')[0];
    if (req.method === 'POST' && (path === '/api/auth/login' || path === '/api/auth/register')) {
      rateLimit(`auth:${ip}`, Number(process.env.CONTENTLOOP_AUTH_RATE_IP ?? 20));
      const email = String((req.body as any)?.email ?? '').toLowerCase();
      if (email) rateLimit(`auth-email:${email}`, Number(process.env.CONTENTLOOP_AUTH_RATE_EMAIL ?? 10));
    } else if (req.method !== 'GET') rateLimit(`w:${ip}`, 600);
    const sid = req.cookies[COOKIE];
    const u = W.sessionUser(app.db, sid, app.clock.now());
    if (u) {
      req.user = u;
      req.sessionId = sid;
    }
    const open = ['/api/auth/login', '/api/auth/register', '/api/health'];
    if (req.method !== 'GET' && req.method !== 'HEAD' && !open.includes(req.url.split('?')[0])) {
      if (!u) throw new AppError(401, 'unauthenticated', 'ログインしてください');
      if (req.headers['x-csrf-token'] !== u.csrfToken) throw new AppError(403, 'csrf', 'CSRF tokenが不正です');
    }
  });

  const authed = (req: FastifyRequest) => {
    if (!req.user) throw new AppError(401, 'unauthenticated', 'ログインしてください');
    return req.user;
  };
  const ctxOf = (req: FastifyRequest): Ctx => W.ctxFor(app, authed(req).userId, (req.params as any).wid, 'web');
  const now = () => app.clock.now();

  f.get('/api/health', async () => ({ ok: true, time: now().toISOString() }));

  f.post('/api/auth/register', async (req, reply) => {
    const b = req.body as any;
    const u = W.createUser(app.db, String(b?.email ?? ''), String(b?.name ?? '').slice(0, 80) || 'User', String(b?.password ?? ''), now());
    W.createWorkspace(app.db, u.id, `${u.name}のWorkspace`, now(), { timezone: typeof b?.timezone === 'string' ? b.timezone : 'Asia/Tokyo' });
    return login(reply, String(b.email), String(b.password));
  });
  const login = (reply: FastifyReply, email: string, password: string) => {
    const r = W.login(app.db, email, password, now());
    reply.setCookie(COOKIE, r.sessionId, { httpOnly: true, sameSite: 'lax', secure: !!opts.secureCookies, path: '/', maxAge: 14 * 86400 });
    return { user: r.user, csrfToken: r.csrfToken, workspaces: W.listWorkspaces(app.db, r.user.id) };
  };
  f.post('/api/auth/login', async (req, reply) => {
    const b = req.body as any;
    return login(reply, String(b?.email ?? ''), String(b?.password ?? ''));
  });
  f.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionId) W.logout(app.db, req.sessionId);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  f.get('/api/auth/me', async (req) => {
    const u = authed(req);
    return { user: { id: u.userId, email: u.email, name: u.name }, csrfToken: u.csrfToken, workspaces: W.listWorkspaces(app.db, u.userId) };
  });
  /** Sample workspace (separate, flagged is_sample). Disabled in production unless explicitly allowed. */
  f.post('/api/auth/sample-workspace', async (req) => {
    const u = authed(req);
    if (!opts.allowSample) throw new AppError(403, 'sample_disabled', 'この環境ではサンプルWorkspaceは無効です');
    const user = app.db.get('SELECT email FROM users WHERE id = ?', u.userId)!;
    const s = await seedSample(app, { email: user.email });
    return { workspaceId: s.workspaceId };
  });

  // ---------- workspace ----------
  const r = (method: 'get' | 'post' | 'patch' | 'delete', path: string, h: (ctx: Ctx, req: FastifyRequest, reply: FastifyReply) => any) =>
    f[method](`/api/w/:wid${path}`, async (req, reply) => h(ctxOf(req), req, reply));
  const body = (req: FastifyRequest) => (req.body ?? {}) as any;
  const q = (req: FastifyRequest) => (req.query ?? {}) as any;
  const p = (req: FastifyRequest) => req.params as any;

  r('get', '', (ctx) => W.workspaceInfo(ctx));
  r('patch', '/settings', (ctx, req) => W.updateSettings(ctx, body(req)));
  r('get', '/members', (ctx) => W.listMembers(ctx));
  r('post', '/members', (ctx, req) => W.addMember(ctx, body(req).email, body(req).role, !!body(req).canPublishExternal));
  r('get', '/platforms', () => ({ platforms: PLATFORMS, packKinds: PACK_KINDS }));
  r('get', '/dashboard', (ctx) => dashboard(ctx));

  r('get', '/brands', (ctx) => B.listBrands(ctx));
  r('post', '/brands', (ctx, req) => B.createBrand(ctx, body(req)));
  r('get', '/brands/:id', (ctx, req) => B.getBrand(ctx, p(req).id));
  r('patch', '/brands/:id', (ctx, req) => B.updateBrand(ctx, p(req).id, body(req)));
  r('post', '/brands/:id/voice-draft', (ctx, req) => B.draftVoice(ctx, p(req).id, (body(req).samples ?? []).map(String).slice(0, 50)));
  r('post', '/brands/:id/voice-confirm', (ctx, req) => B.confirmVoice(ctx, p(req).id, body(req)));

  r('get', '/sources', (ctx, req) => S.listSources(ctx, q(req)));
  r('post', '/sources', (ctx, req) => S.importSource(ctx, body(req)));
  r('get', '/sources/:id', (ctx, req) => ({ ...S.getSource(ctx, p(req).id), ideas: I.listIdeas(ctx, { sourceId: p(req).id }), media: M.listMedia(ctx, { sourceId: p(req).id }) }));
  r('patch', '/sources/:id', (ctx, req) => S.updateSource(ctx, p(req).id, body(req)));
  r('delete', '/sources/:id', (ctx, req) => S.deleteSource(ctx, p(req).id));
  r('post', '/sources/:id/transcript', (ctx, req) => S.attachTranscript(ctx, p(req).id, String(body(req).transcript ?? '')));
  r('post', '/sources/:id/transcribe', (ctx, req) => S.transcribeMedia(ctx, p(req).id, String(body(req).provider ?? 'openai')));
  r('post', '/sources/:id/ideas', (ctx, req) => I.extractIdeas(ctx, p(req).id, { max: Number(body(req).max ?? 12) }));
  r('get', '/sources/:id/subtitles', (ctx, req, reply) => {
    getScoped(ctx, 'sources', p(req).id);
    const fmt = q(req).format === 'vtt' ? 'vtt' : 'srt';
    const out = buildSubtitles(getSegments(ctx, p(req).id), Number(q(req).start ?? 0), Number(q(req).end ?? 1e12), fmt);
    reply.header('content-type', fmt === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="clip.${fmt}"`);
    return out;
  });

  r('get', '/ideas', (ctx, req) => I.listIdeas(ctx, { ...q(req), evergreen: q(req).evergreen === '1' ? true : undefined }));
  r('post', '/ideas', (ctx, req) => I.createIdea(ctx, body(req)));
  r('get', '/ideas-memory', (ctx) => I.ideaMemory(ctx));
  r('post', '/ideas/similar', (ctx, req) => I.similarIdeas(ctx, String(body(req).text ?? ''), { excludeIds: body(req).excludeIds }));
  r('get', '/ideas/:id', (ctx, req) => ({ ...I.getIdea(ctx, p(req).id), content: C.listContent(ctx, { ideaId: p(req).id }) }));
  r('patch', '/ideas/:id', (ctx, req) => I.updateIdea(ctx, p(req).id, body(req)));
  r('post', '/ideas/:id/status', (ctx, req) => I.setIdeaStatus(ctx, p(req).id, body(req).status, body(req).note));

  r('get', '/packs', (ctx) => C.listPacks(ctx));
  r('post', '/packs', (ctx, req) => C.createPack(ctx, body(req)));
  r('get', '/packs/:id', (ctx, req) => C.getPack(ctx, p(req).id));
  r('get', '/packs/:id/zip', (ctx, req, reply) => sendFile(reply, IO.exportPackZip(ctx, p(req).id), 'application/zip', `pack-${p(req).id}.zip`));

  r('get', '/content', (ctx, req) => C.listContent(ctx, q(req)));
  r('post', '/content', (ctx, req) => C.createManualContent(ctx, body(req)));
  r('post', '/drafts', (ctx, req) => C.draftForPlatform(ctx, body(req)));
  r('get', '/content/:id', async (ctx, req) => {
    const id = p(req).id;
    const c = C.getContent(ctx, id);
    return { content: c, checks: await C.runChecks(ctx, id), versions: C.listVersions(ctx, id), approvals: C.approvalHistory(ctx, id), comments: C.listComments(ctx, id), snapshots: PF.listSnapshots(ctx, id), jobs: P.listJobs(ctx).filter((j) => j.contentId === id), media: M.listMedia(ctx, { contentId: id }) };
  });
  r('get', '/content/:id/checks', (ctx, req) => C.runChecks(ctx, p(req).id));
  r('patch', '/content/:id', (ctx, req) => C.updateContent(ctx, p(req).id, body(req)));
  r('post', '/content/:id/regenerate', (ctx, req) => C.regenerate(ctx, p(req).id, body(req)));
  r('post', '/content/:id/accept-suggestion', (ctx, req) => C.acceptSuggestion(ctx, p(req).id));
  r('post', '/content/:id/restore', (ctx, req) => C.restoreVersion(ctx, p(req).id, Number(body(req).version)));
  r('post', '/content/:id/review', (ctx, req) => C.requestReview(ctx, p(req).id, body(req).comment));
  r('post', '/content/:id/approve', (ctx, req) => C.approve(ctx, p(req).id, body(req).comment));
  r('post', '/content/:id/request-changes', (ctx, req) => C.requestChanges(ctx, p(req).id, String(body(req).comment ?? '修正をお願いします')));
  r('post', '/content/:id/comments', (ctx, req) => C.addComment(ctx, p(req).id, String(body(req).body ?? '')));
  r('post', '/content/:id/archive', (ctx, req) => C.archiveContent(ctx, p(req).id));
  r('post', '/content/:id/transform', (ctx, req) => C.transformContent(ctx, p(req).id, body(req).platform, body(req).format));
  r('post', '/content/:id/localize', (ctx, req) => C.localize(ctx, p(req).id, String(body(req).locale)));
  r('post', '/content/:id/schedule', (ctx, req) => P.schedule(ctx, { ...body(req), contentId: p(req).id }));
  r('get', '/content/:id/handoff', (ctx, req) => P.handoff(ctx, p(req).id));
  r('post', '/content/:id/mark-published', (ctx, req) => P.markPublished(ctx, p(req).id, body(req)));
  r('post', '/content/:id/recycle', (ctx, req) => PF.recycle(ctx, p(req).id, body(req)));
  r('post', '/content/:id/recycle-state', (ctx, req) => PF.setRecycleState(ctx, p(req).id, body(req).state, body(req).seasonalMonths));
  r('post', '/content/:id/snapshots', (ctx, req) => PF.recordSnapshot(ctx, { ...body(req), contentId: p(req).id }));
  r('post', '/content/:id/pull-metrics', (ctx, req) => PF.pullConnectorMetrics(ctx, p(req).id, body(req).window ?? '24h'));

  r('get', '/campaigns', (ctx) => CM.listCampaigns(ctx));
  r('post', '/campaigns', (ctx, req) => CM.createCampaign(ctx, body(req)));
  r('get', '/campaigns/:id', (ctx, req) => ({ ...CM.getCampaign(ctx, p(req).id), guard: CM.campaignGuard(ctx, p(req).id) }));
  r('patch', '/campaigns/:id', (ctx, req) => CM.updateCampaign(ctx, p(req).id, body(req)));
  r('post', '/campaigns/:id/sequence', (ctx, req) => CM.draftSequence(ctx, p(req).id));
  r('post', '/campaigns/:id/steps/:sid/draft', (ctx, req) => CM.draftStep(ctx, p(req).id, p(req).sid));
  r('get', '/campaigns/:id/export.csv', (ctx, req, reply) => { const e = IO.exportCampaignCalendar(ctx, p(req).id); return sendFile(reply, e.body, e.mime, e.filename); });
  r('get', '/calendar', (ctx, req) => CM.calendar(ctx, String(q(req).from ?? new Date(now().getTime() - 7 * 86400_000).toISOString()), String(q(req).to ?? new Date(now().getTime() + 35 * 86400_000).toISOString())));
  r('get', '/series', (ctx) => CM.listSeries(ctx));
  r('post', '/series', (ctx, req) => CM.createSeries(ctx, body(req)));
  r('get', '/series/:id', (ctx, req) => CM.getSeries(ctx, p(req).id));
  r('get', '/briefs', (ctx) => CM.listBriefs(ctx));
  r('post', '/briefs', (ctx, req) => CM.createBrief(ctx, body(req)));

  r('get', '/jobs', (ctx, req) => P.listJobs(ctx, q(req)));
  r('post', '/jobs/:id/cancel', (ctx, req) => P.cancelJob(ctx, p(req).id));
  r('post', '/jobs/:id/retry', (ctx, req) => P.retryJob(ctx, p(req).id));
  r('post', '/jobs/run-due', async (ctx) => {
    if (!['owner', 'admin'].includes(ctx.role)) throw new AppError(403, 'forbidden', 'admin only');
    return P.runDueJobs(app);
  });

  r('get', '/connectors', (ctx) => ({ matrix: P.capabilityMatrix(ctx), connectors: P.listConnectors(ctx) }));
  r('post', '/connectors/health', (ctx) => P.connectorHealth(ctx));
  r('post', '/connectors/oauth/start', (ctx, req) => P.startOAuth(ctx, String(body(req).adapter), `/api/connectors/callback`));
  r('post', '/connectors/wordpress', (ctx, req) => {
    const b = body(req);
    if (!/^https:\/\//.test(String(b.site ?? ''))) throw badRequest('WordPressサイトURLはhttpsで指定してください');
    if (!b.confirmRealAccount) throw badRequest('実アカウント接続の確認が必要です（confirmRealAccount）');
    return P.saveConnection(ctx, 'wordpress', { accessToken: `${b.site}|${b.user}:${b.appPassword}`, scopes: ['wp:author'] }, `${b.site}`);
  });
  r('post', '/connectors/:id/revoke', (ctx, req) => P.revokeConnector(ctx, p(req).id));

  // Sandbox OAuth consent screen (simulated platform) + callback
  f.get('/api/connectors/sandbox/authorize', async (req, reply) => {
    const { state } = req.query as any;
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><meta charset="utf-8"><title>Sandbox OAuth</title><body style="font-family:sans-serif;padding:24px"><h1>Sandbox（シミュレーション）</h1><p>これは実SNSではありません。ContentLoopのテスト用シミュレーターに接続します。</p><a id="allow" href="/api/connectors/callback?state=${encodeURIComponent(escapeForHtml(String(state)))}&code=sbx-code-ok">許可する</a> ・ <a href="/connectors">キャンセル</a></body>`;
  });
  f.get('/api/connectors/callback', async (req, reply) => {
    const u = authed(req);
    const { state, code } = req.query as any;
    await P.completeOAuth(app, String(state), String(code), u.userId);
    return reply.redirect('/connectors?connected=1');
  });

  r('get', '/performance/summary', (ctx, req) => PF.performanceSummary(ctx, { days: Number(q(req).days ?? 90) }));
  r('get', '/performance/feedback', (ctx, req) => PF.feedback(ctx, q(req).dimension ?? 'topic', { days: Number(q(req).days ?? 90) }));
  r('get', '/recycling', (ctx) => PF.recyclingCandidates(ctx, { notify: true }));

  r('get', '/claims', (ctx) => CL.listClaims(ctx));
  r('post', '/claims', (ctx, req) => CL.createClaim(ctx, body(req)));
  r('post', '/claims/check', (ctx, req) => CL.checkClaims(ctx, String(body(req).text ?? '')));
  r('post', '/claims/:id/verify', (ctx, req) => CL.verifyClaim(ctx, p(req).id));
  r('post', '/claims/:id/value', (ctx, req) => CL.updateClaimValue(ctx, p(req).id, body(req)));

  r('get', '/search', (ctx, req) => SR.search(ctx, String(q(req).q ?? ''), { types: q(req).types ? String(q(req).types).split(',') : undefined, platform: q(req).platform, status: q(req).status, campaignId: q(req).campaignId, reuseState: q(req).reuseState, from: q(req).from, to: q(req).to }));
  r('post', '/strategist', (ctx, req) => SR.askStrategist(ctx, String(body(req).question ?? '').slice(0, 1000), { platform: body(req).platform }));

  r('get', '/inbox', (ctx, req) => M.listInbox(ctx, q(req).status ?? 'unsorted'));
  r('post', '/inbox', (ctx, req) => M.capture(ctx, body(req)));
  r('post', '/inbox/:id/process', (ctx, req) => M.processInbox(ctx, p(req).id, body(req)));
  r('post', '/media', async (ctx, req) => {
    const file = await (req as any).file();
    if (!file) throw badRequest('file required');
    const buf = await file.toBuffer();
    const fields = file.fields ?? {};
    return M.uploadMedia(ctx, { data: buf, declaredMime: file.mimetype, filename: file.filename, sourceId: fields.sourceId?.value, contentId: fields.contentId?.value });
  });
  r('get', '/media', (ctx, req) => M.listMedia(ctx, q(req)));
  r('post', '/utm', (_ctx, req) => M.buildUtm(body(req)));

  r('post', '/import/preview', (ctx, req) => IO.importPreview(ctx, String(body(req).csv ?? ''), body(req).defaultPlatform));
  r('post', '/import/:batchId/confirm', (ctx, req) => IO.importConfirm(ctx, p(req).batchId, body(req)));
  r('get', '/export/content', (ctx, req, reply) => { const e = IO.exportContent(ctx, (q(req).format ?? 'csv') as any, q(req)); return sendFile(reply, e.body, e.mime, e.filename); });
  r('get', '/export/copy-package.zip', (ctx, _req, reply) => sendFile(reply, IO.exportCopyPackage(ctx), 'application/zip', 'copy-package.zip'));
  r('get', '/backup.zip', (ctx, _req, reply) => sendFile(reply, IO.backupWorkspace(ctx), 'application/zip', `contentloop-backup-${ctx.workspaceId}.zip`));
  r('post', '/restore', (ctx, req) => {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf)) throw badRequest('application/zip のバイナリを送信してください');
    return IO.restoreWorkspace(ctx, new Uint8Array(buf));
  });
  r('get', '/relations', (ctx) => IO.relationReport(ctx));
  r('get', '/audit', (ctx) => IO.listAudit(ctx));
  r('get', '/notifications', (ctx) => N.listNotifications(ctx));
  r('post', '/notifications/:id/read', (ctx, req) => { N.markRead(ctx, p(req).id); return { ok: true }; });
  r('get', '/ai-usage', (ctx) => ({ status: app.ai.status(ctx.workspaceId), recent: app.db.all('SELECT provider, task, tokens_in, tokens_out, cost_usd, created_at FROM ai_usage WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50', ctx.workspaceId) }));

  // ---- E2E-only hooks (never enabled in production) ----
  if (opts.testMode && process.env.NODE_ENV !== 'production') {
    f.post('/api/test/advance', async (req) => {
      const c = app.clock as any;
      if (typeof c.offsetMs !== 'number') throw badRequest('clock not adjustable');
      c.offsetMs += Number((req.body as any)?.days ?? 0) * 86400_000;
      return { now: app.clock.now().toISOString() };
    });
    f.post('/api/test/sandbox', async (req) => {
      const b = req.body as any;
      const a = app.connectors.get(`sandbox:${b.platform}`) as any;
      if (!a) throw badRequest('no sandbox');
      if (b.failNext !== undefined) a.failNext = b.failNext;
      return { remotePosts: a.remote.size, publishCalls: a.publishCalls };
    });
    f.post('/api/test/run-jobs', async () => P.runDueJobs(app));
  }

  // signed media URLs (no session needed, HMAC + expiry; key includes workspace id)
  f.get('/media/*', async (req, reply) => {
    const key = (req.params as any)['*'] as string;
    const { exp, sig } = req.query as any;
    if (!app.storage.verify(key, Number(exp), String(sig ?? ''), now())) return reply.status(403).send({ error: 'forbidden' });
    const m = app.db.get('SELECT mime FROM media_assets WHERE storage_key = ?', key);
    const data = await app.storage.get(key);
    if (!m || !data) return reply.status(404).send({ error: 'not_found' });
    reply.header('content-type', m.mime).header('content-disposition', 'inline').header('cache-control', 'private, max-age=600');
    return reply.send(data);
  });

  // static web (PWA)
  if (opts.webDist && existsSync(opts.webDist)) {
    await f.register(fastifyStatic, { root: opts.webDist, prefix: '/', wildcard: false });
    f.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/media/')) return reply.status(404).send({ error: 'not_found' });
      return reply.sendFile('index.html');
    });
  }

  function dashboard(ctx: Ctx) {
    const db = app.db;
    const ws = ctx.workspaceId;
    const n = (sql: string, ...a: any[]) => db.get<{ c: number }>(sql, ws, ...a)!.c;
    const tz = db.get('SELECT timezone FROM workspaces WHERE id = ?', ws)!.timezone;
    const mem = I.ideaMemory(ctx);
    const today0 = now().toISOString().slice(0, 10);
    return {
      counts: {
        sources: n('SELECT COUNT(*) c FROM sources WHERE workspace_id = ?'), ideas: n('SELECT COUNT(*) c FROM ideas WHERE workspace_id = ?'),
        drafts: n("SELECT COUNT(*) c FROM content_items WHERE workspace_id = ? AND status = 'draft'"), needsReview: n("SELECT COUNT(*) c FROM content_items WHERE workspace_id = ? AND status = 'needs_review'"),
        approved: n("SELECT COUNT(*) c FROM content_items WHERE workspace_id = ? AND status = 'approved'"), scheduled: n("SELECT COUNT(*) c FROM content_items WHERE workspace_id = ? AND status = 'scheduled'"),
        published: n("SELECT COUNT(*) c FROM content_items WHERE workspace_id = ? AND status = 'published'"), failed: n("SELECT COUNT(*) c FROM content_items WHERE workspace_id = ? AND status = 'failed'"),
        inbox: n("SELECT COUNT(*) c FROM inbox_items WHERE workspace_id = ? AND status = 'unsorted'"),
      },
      memory: Object.fromEntries(Object.entries(mem).map(([k, v]) => [k, v.length])),
      reviewQueue: C.listContent(ctx, { status: 'needs_review', limit: 10 }),
      upcoming: C.listContent(ctx, { status: 'scheduled', from: today0, limit: 10 }).reverse(),
      recycling: PF.recyclingCandidates(ctx).length,
      packs: C.listPacks(ctx).slice(0, 5),
      notifications: N.listNotifications(ctx).slice(0, 8),
      timezone: tz,
      ai: app.ai.status(ws),
    };
  }

  return f;
}

function sendFile(reply: FastifyReply, data: string | Uint8Array, mime: string, filename: string) {
  reply.header('content-type', mime);
  reply.header('content-disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  return reply.send(typeof data === 'string' ? data : Buffer.from(data));
}
