import { createHash } from 'node:crypto';
import { j } from '../db/db.js';
import { id, token, sha256, badRequest, forbidden, encryptSecret, decryptSecret, zonedToUtc, isValidTimezone, utcToZoned } from '../lib/util.js';
import { audit, getScoped, getSettings, getTimezone, nowIso, requirePerm, can, type App, type Ctx } from './context.js';
import { API_FACTS, ConnectorError, effectiveCapabilities, takeRateToken, type Capability, type Tokens } from '../connectors/registry.js';
import { PLATFORMS, isPlatform, type PlatformId } from './platforms.js';
import { getContent, runChecks } from './content.js';
import { recordIdeaUse } from './ideas.js';
import { notify } from './notifications.js';
import { systemCtx } from './workspace.js';

// ---------------------------------------------------------------- connectors

/** Public view of a connector. Tokens are NEVER included. */
export function connectorView(ctx: Ctx, r: any) {
  const adapter = ctx.app.connectors.get(r.adapter);
  return {
    id: r.id, platform: r.platform, adapter: r.adapter, adapterLabel: adapter?.label ?? r.adapter, accountLabel: r.account_label, status: r.status,
    tokenExpiresAt: r.token_expires_at, scopes: j<string[]>(r.scopes, []), health: r.health, lastCheckedAt: r.last_checked_at,
    simulated: adapter?.simulated ?? false, verifiedAgainstRealApi: adapter?.verifiedAgainstRealApi ?? false,
    capabilities: effectiveCapabilities(adapter, r.status), hasToken: !!r.token_enc,
  };
}

export function listConnectors(ctx: Ctx) {
  requirePerm(ctx, 'read');
  return ctx.app.db.all('SELECT * FROM connectors WHERE workspace_id = ? ORDER BY platform', ctx.workspaceId).map((r) => connectorView(ctx, r));
}

/** Capability matrix per platform: docs facts vs what ContentLoop can do right now in this workspace. */
export function capabilityMatrix(ctx: Ctx) {
  requirePerm(ctx, 'read');
  const conns = listConnectors(ctx);
  return (Object.keys(PLATFORMS) as PlatformId[]).map((p) => {
    const cs = conns.filter((c) => c.platform === p);
    const effective = new Set<Capability>(['DRAFT_EXPORT']);
    for (const c of cs) for (const cap of c.capabilities) effective.add(cap);
    const adapters = ctx.app.connectors.forPlatform(p).filter((a) => !a.id.startsWith('manual:')).map((a) => ({ id: a.id, label: a.label, capabilities: a.capabilities, simulated: a.simulated, verifiedAgainstRealApi: a.verifiedAgainstRealApi }));
    const f = API_FACTS[p];
    return {
      platform: p, label: PLATFORMS[p].label, effective: [...effective], connectors: cs, adapters,
      officialDocs: f.documented, conditions: f.conditions, scopes: f.scopes, rateLimit: f.rateLimit, openUrl: f.openUrl,
      unavailable: f.documented.PUBLISH === 'no',
      autoPublish: effective.has('PUBLISH'),
    };
  });
}

const pendingOAuth = new Map<string, { workspaceId: string; adapter: string; verifier: string; redirect: string; createdAt: number; userId: string | null }>();

/** Start OAuth (state + PKCE). Returns authorize URL. Real-SNS connection requires explicit human action. */
export function startOAuth(ctx: Ctx, adapterId: string, redirectUri: string) {
  requirePerm(ctx, 'manage_connectors');
  const a = ctx.app.connectors.get(adapterId);
  if (!a?.authorizeUrl) throw badRequest('このConnectorはOAuthに対応していません');
  const state = token(16);
  const verifier = token(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  pendingOAuth.set(state, { workspaceId: ctx.workspaceId, adapter: adapterId, verifier, redirect: redirectUri, createdAt: Date.now(), userId: ctx.userId });
  return { url: a.authorizeUrl(state, challenge, redirectUri), state };
}

export async function completeOAuth(app: App, state: string, code: string, userId: string) {
  const p = pendingOAuth.get(state);
  pendingOAuth.delete(state);
  if (!p || Date.now() - p.createdAt > 10 * 60_000 || p.userId !== userId) throw forbidden('OAuth stateが不正または期限切れです');
  const a = app.connectors.get(p.adapter)!;
  const tokens = await a.exchangeCode!(code, p.verifier, p.redirect);
  const ctx = { ...systemCtx(app, p.workspaceId), userId };
  return saveConnection(ctx, p.adapter, tokens, `${a.platform} account`);
}

/** Store tokens encrypted at rest (AES-256-GCM). Upsert per adapter. */
export function saveConnection(ctx: Ctx, adapterId: string, tokens: Tokens, accountLabel: string) {
  requirePerm(ctx, 'manage_connectors');
  const a = ctx.app.connectors.get(adapterId);
  if (!a) throw badRequest('unknown adapter');
  const existing = ctx.app.db.get('SELECT id FROM connectors WHERE workspace_id = ? AND adapter = ?', ctx.workspaceId, adapterId);
  const row = {
    platform: a.platform, adapter: adapterId, account_label: accountLabel, status: 'connected', token_enc: encryptSecret(tokens.accessToken),
    refresh_enc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null, token_expires_at: tokens.expiresAt ?? null, scopes: tokens.scopes,
    health: 'ok', last_checked_at: nowIso(ctx),
  };
  let cid = existing?.id;
  if (cid) ctx.app.db.update('connectors', cid, ctx.workspaceId, row);
  else {
    cid = id('con');
    ctx.app.db.insert('connectors', { id: cid, workspace_id: ctx.workspaceId, created_at: nowIso(ctx), ...row });
  }
  audit(ctx, 'connector.connected', 'connector', cid, { adapter: adapterId, scopes: tokens.scopes });
  // Jobs that failed due to auth can be retried by the user now (not automatically).
  return connectorView(ctx, getScoped(ctx, 'connectors', cid));
}

function tokensOf(r: any): Tokens {
  return { accessToken: decryptSecret(r.token_enc), refreshToken: r.refresh_enc ? decryptSecret(r.refresh_enc) : undefined, expiresAt: r.token_expires_at ?? undefined, scopes: j(r.scopes, []) };
}

export async function revokeConnector(ctx: Ctx, cid: string) {
  requirePerm(ctx, 'manage_connectors');
  const r = getScoped(ctx, 'connectors', cid);
  const a = ctx.app.connectors.get(r.adapter);
  if (r.token_enc && a?.revoke) {
    try {
      await a.revoke(tokensOf(r));
    } catch {
      /* remote revoke best-effort; local tokens are deleted regardless */
    }
  }
  ctx.app.db.update('connectors', cid, ctx.workspaceId, { status: 'revoked', token_enc: null, refresh_enc: null, token_expires_at: null, health: 'revoked by user', last_checked_at: nowIso(ctx) });
  const cancelled = ctx.app.db.run("UPDATE publish_jobs SET status = 'failed', last_error = 'connector revoked' WHERE workspace_id = ? AND connector_id = ? AND status = 'queued'", ctx.workspaceId, cid);
  audit(ctx, 'connector.revoked', 'connector', cid, { adapter: r.adapter });
  return { connector: connectorView(ctx, getScoped(ctx, 'connectors', cid)), jobsFailed: Number(cancelled.changes) };
}

/** Health: token expiry warnings (notification) and expired → status expired. */
export function connectorHealth(ctx: Ctx) {
  const now = ctx.app.clock.now();
  for (const r of ctx.app.db.all("SELECT * FROM connectors WHERE workspace_id = ? AND status = 'connected'", ctx.workspaceId)) {
    if (!r.token_expires_at) continue;
    const ms = new Date(r.token_expires_at).getTime() - now.getTime();
    if (ms <= 0) {
      ctx.app.db.update('connectors', r.id, ctx.workspaceId, { status: 'expired', health: 'token expired', last_checked_at: now.toISOString() });
      notify(ctx, { kind: 'connector_failed', message: `${PLATFORMS[r.platform as PlatformId].label}の接続が期限切れです。再認証してください`, targetType: 'connector', targetId: r.id, dedupeKey: `conn-exp:${r.id}` });
    } else if (ms < 7 * 86400_000) {
      notify(ctx, { kind: 'connector_expiring', message: `${PLATFORMS[r.platform as PlatformId].label}の接続が${Math.ceil(ms / 86400_000)}日以内に期限切れになります`, targetType: 'connector', targetId: r.id, dedupeKey: `conn-soon:${r.id}` });
    }
  }
  return listConnectors(ctx);
}

// ---------------------------------------------------------------- scheduling

export function idempotencyKeyFor(workspaceId: string, contentId: string, version: number, platform: string, scheduledAt: string) {
  return sha256(`${workspaceId}|${contentId}|v${version}|${platform}|${scheduledAt}`);
}

export interface ScheduleInput {
  contentId: string;
  /** local wall-clock time in `timezone` (YYYY-MM-DDTHH:mm) */
  localTime?: string;
  /** or absolute UTC ISO */
  at?: string;
  timezone?: string;
  mode: 'api' | 'manual';
  connectorId?: string;
}

export async function schedule(ctx: Ctx, input: ScheduleInput) {
  requirePerm(ctx, 'write');
  const c = getContent(ctx, input.contentId);
  const s = getSettings(ctx.app.db, ctx.workspaceId);
  const tz = input.timezone ?? getTimezone(ctx.app.db, ctx.workspaceId);
  if (!isValidTimezone(tz)) throw badRequest('不正なタイムゾーンです');
  const at = input.localTime ? zonedToUtc(input.localTime, tz) : input.at ? new Date(input.at).toISOString() : null;
  if (!at) throw badRequest('日時を指定してください');
  if (['published', 'archived'].includes(c.status)) throw badRequest(`この状態(${c.status})は予約できません`);
  const checks = await runChecks(ctx, c.id);
  let connectorId: string | null = null;
  if (input.mode === 'api') {
    if (!can(ctx, 'publish')) throw forbidden('外部投稿権限がありません（管理者が個別に付与します）');
    if (s.requireApprovalBeforePublish && c.status !== 'approved' && c.status !== 'scheduled') throw badRequest('外部投稿にはApprovedが必要です');
    if (checks.reuse.some((r) => r.rule === 'needs_update')) throw badRequest('Needs UpdateのIdeaは自動投稿できません（手動投稿/更新後に再承認）');
    if (checks.blocking) throw badRequest('ブロック項目があるため自動投稿できません', checks);
    const conn = input.connectorId
      ? getScoped(ctx, 'connectors', input.connectorId)
      : ctx.app.db.get("SELECT * FROM connectors WHERE workspace_id = ? AND platform = ? AND status = 'connected' LIMIT 1", ctx.workspaceId, c.platform);
    const caps = effectiveCapabilities(conn ? ctx.app.connectors.get(conn.adapter) : undefined, conn?.status);
    if (!conn || conn.platform !== c.platform || !caps.includes('PUBLISH')) {
      throw badRequest(`${PLATFORMS[c.platform].label}は現在API投稿に対応していません（Connector未接続/非対応）。手動投稿(Export/Reminder)を使ってください`, { capabilities: caps });
    }
    connectorId = conn.id;
  }
  const key = idempotencyKeyFor(ctx.workspaceId, c.id, c.version, c.platform, at);
  const existing = ctx.app.db.get('SELECT * FROM publish_jobs WHERE idempotency_key = ?', key);
  if (existing && existing.status !== 'cancelled') return { job: jobView(existing), duplicate: true };
  // One active job per content: cancel previous queued jobs (re-schedule)
  ctx.app.db.run("UPDATE publish_jobs SET status = 'cancelled', last_error = 'rescheduled' WHERE workspace_id = ? AND content_id = ? AND status = 'queued'", ctx.workspaceId, c.id);
  const jid = existing?.id ?? id('job');
  if (existing) ctx.app.db.run("UPDATE publish_jobs SET status = 'queued', attempt = 0, last_error = NULL, updated_at = ? WHERE id = ?", nowIso(ctx), jid);
  else ctx.app.db.insert('publish_jobs', { id: jid, workspace_id: ctx.workspaceId, content_id: c.id, platform: c.platform, connector_id: connectorId, mode: input.mode, scheduled_at: at, timezone: tz, status: 'queued', attempt: 0, idempotency_key: key, content_version: c.version, created_by: ctx.userId, created_at: nowIso(ctx), updated_at: nowIso(ctx) });
  ctx.app.db.update('content_items', c.id, ctx.workspaceId, { scheduled_at: at, status: input.mode === 'api' ? 'scheduled' : c.status === 'approved' ? 'scheduled' : c.status, updated_at: nowIso(ctx) });
  audit(ctx, 'publish.scheduled', 'content', c.id, { mode: input.mode, at, tz, connectorId });
  return { job: jobView(getScoped(ctx, 'publish_jobs', jid)), duplicate: false, localTime: utcToZoned(at, tz), warnings: checks };
}

export function jobView(r: any) {
  return { id: r.id, contentId: r.content_id, platform: r.platform, connectorId: r.connector_id, mode: r.mode, scheduledAt: r.scheduled_at, timezone: r.timezone, status: r.status, attempt: r.attempt, externalId: r.external_id, lastError: r.last_error, nextAttemptAt: r.next_attempt_at, idempotencyKey: r.idempotency_key, contentVersion: r.content_version };
}

export function listJobs(ctx: Ctx, q: { status?: string } = {}) {
  requirePerm(ctx, 'read');
  return ctx.app.db.all('SELECT * FROM publish_jobs WHERE workspace_id = ? AND (? IS NULL OR status = ?) ORDER BY scheduled_at DESC LIMIT 500', ctx.workspaceId, q.status ?? null, q.status ?? null).map(jobView);
}

export function cancelJob(ctx: Ctx, jobId: string) {
  requirePerm(ctx, 'write');
  const r = getScoped(ctx, 'publish_jobs', jobId);
  if (r.status !== 'queued' && r.status !== 'failed') throw badRequest('キャンセルできない状態です');
  ctx.app.db.update('publish_jobs', jobId, ctx.workspaceId, { status: 'cancelled', updated_at: nowIso(ctx) });
  ctx.app.db.run("UPDATE content_items SET status = CASE WHEN status = 'scheduled' THEN 'approved' ELSE status END, scheduled_at = NULL WHERE id = ? AND workspace_id = ?", r.content_id, ctx.workspaceId);
  audit(ctx, 'publish.cancelled', 'publish_job', jobId);
  return jobView(getScoped(ctx, 'publish_jobs', jobId));
}

const MAX_ATTEMPTS = 5;

/**
 * Worker: process due jobs. Safety rules:
 *  - CAS claim (queued→running) so a job is processed once even with multiple workers
 *  - content version must equal approved/scheduled version; Needs Update blocks
 *  - before any retry, ask the platform whether the idempotency key was already posted (no duplicate posts)
 *  - 429 → backoff with cap; auth errors → failed + connector expired (no retry until re-auth)
 *  - ambiguous errors are never blindly retried
 */
export async function runDueJobs(app: App) {
  const now = app.clock.now().toISOString();
  const due = app.db.all("SELECT * FROM publish_jobs WHERE status = 'queued' AND scheduled_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY scheduled_at LIMIT 50", now, now);
  const results: any[] = [];
  for (const job of due) {
    const claimed = app.db.run("UPDATE publish_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'", now, job.id);
    if (Number(claimed.changes) !== 1) continue;
    const ctx = systemCtx(app, job.workspace_id);
    results.push(await processJob(ctx, job));
  }
  return results;
}

function finish(ctx: Ctx, jobId: string, patch: Record<string, any>) {
  ctx.app.db.update('publish_jobs', jobId, ctx.workspaceId, { ...patch, updated_at: nowIso(ctx) });
  return jobView(getScoped(ctx, 'publish_jobs', jobId));
}

async function processJob(ctx: Ctx, job: any) {
  const c = getContent(ctx, job.content_id);
  if (job.mode === 'manual') {
    notify(ctx, { kind: 'manual_publish_due', message: `手動投稿の時間です: ${PLATFORMS[c.platform].label}「${(c.title ?? c.body).slice(0, 30)}」`, targetType: 'content', targetId: c.id, dedupeKey: `manual:${job.id}` });
    return finish(ctx, job.id, { status: 'handoff' });
  }
  if (c.version !== job.content_version || !['scheduled', 'approved'].includes(c.status)) {
    notify(ctx, { kind: 'schedule_failed', message: '予約後に内容が変更されたため投稿を停止しました（再レビューが必要）', targetType: 'content', targetId: c.id, dedupeKey: `changed:${job.id}` });
    return finish(ctx, job.id, { status: 'failed', last_error: 'content changed after scheduling' });
  }
  const checks = await runChecks(ctx, c.id);
  if (checks.reuse.some((r) => r.rule === 'needs_update') || checks.blocking) {
    return finish(ctx, job.id, { status: 'failed', last_error: 'blocked by checks (needs update / banned / outdated claim)' });
  }
  const conn = job.connector_id ? ctx.app.db.get('SELECT * FROM connectors WHERE id = ? AND workspace_id = ?', job.connector_id, ctx.workspaceId) : null;
  const adapter = conn ? ctx.app.connectors.get(conn.adapter) : undefined;
  if (!conn || conn.status !== 'connected' || !adapter?.publish) {
    ctx.app.db.update('content_items', c.id, ctx.workspaceId, { status: 'failed', updated_at: nowIso(ctx) });
    notify(ctx, { kind: 'schedule_failed', message: `${PLATFORMS[c.platform].label}の投稿に失敗: Connectorが無効です（再認証が必要）`, targetType: 'publish_job', targetId: job.id, dedupeKey: `fail:${job.id}` });
    return finish(ctx, job.id, { status: 'failed', last_error: 'connector not connected' });
  }
  if (!takeRateToken(`conn:${conn.id}`, 30)) {
    return finish(ctx, job.id, { status: 'queued', next_attempt_at: new Date(ctx.app.clock.now().getTime() + 60_000).toISOString(), last_error: 'local rate limit' });
  }
  const tokens = tokensOf(conn);
  const attempt = job.attempt + 1;
  try {
    // Duplicate-post prevention: on retries, first check whether the platform already has this post.
    if (job.attempt > 0 || job.last_error) {
      if (!adapter.findByIdempotency) return finish(ctx, job.id, { status: 'failed', attempt, last_error: 'cannot verify previous attempt; check the platform manually before retrying' });
      const found = await adapter.findByIdempotency(tokens, job.idempotency_key);
      if (found) return markApiPublished(ctx, job, c, found.externalId, found.url, attempt);
    }
    const res = await adapter.publish(tokens, { title: c.title, body: c.body, idempotencyKey: job.idempotency_key });
    return markApiPublished(ctx, job, c, res.externalId, res.url, attempt);
  } catch (e) {
    const err = e instanceof ConnectorError ? e : new ConnectorError('ambiguous', String((e as Error).message));
    if (err.kind === 'rate_limited' && attempt < MAX_ATTEMPTS) {
      const backoff = Math.min(3600, (err.retryAfterSec ?? 60) * 2 ** (attempt - 1));
      return finish(ctx, job.id, { status: 'queued', attempt, next_attempt_at: new Date(ctx.app.clock.now().getTime() + backoff * 1000).toISOString(), last_error: `rate limited (429); retry in ${backoff}s` });
    }
    if (err.kind === 'auth') {
      ctx.app.db.update('connectors', conn.id, ctx.workspaceId, { status: 'expired', health: 'auth error: re-authentication required', last_checked_at: nowIso(ctx) });
    }
    if (err.kind === 'ambiguous') {
      // Request may have been sent. Check once; if not found, fail and let the user decide (no blind retry).
      const found = adapter.findByIdempotency ? await adapter.findByIdempotency(tokens, job.idempotency_key).catch(() => null) : null;
      if (found) return markApiPublished(ctx, job, c, found.externalId, found.url, attempt);
    }
    ctx.app.db.update('content_items', c.id, ctx.workspaceId, { status: 'failed', updated_at: nowIso(ctx) });
    notify(ctx, { kind: 'schedule_failed', message: `${PLATFORMS[c.platform].label}の投稿に失敗しました（${err.kind}）`, targetType: 'publish_job', targetId: job.id, dedupeKey: `fail:${job.id}:${attempt}` });
    audit(ctx, 'publish.failed', 'publish_job', job.id, { kind: err.kind, attempt });
    return finish(ctx, job.id, { status: 'failed', attempt, last_error: `${err.kind}: ${err.message}` });
  }
}

function markApiPublished(ctx: Ctx, job: any, c: ReturnType<typeof getContent>, externalId: string, url: string | undefined, attempt: number) {
  const at = nowIso(ctx);
  ctx.app.db.update('content_items', c.id, ctx.workspaceId, { status: 'published', published_at: at, published_via: 'api_confirmed', external_post_id: externalId, external_url: url ?? null, updated_at: at });
  if (c.ideaId) recordIdeaUse(ctx, c.ideaId, c.id, c.platform, at);
  audit(ctx, 'publish.api_confirmed', 'content', c.id, { externalId, jobId: job.id });
  return finish(ctx, job.id, { status: 'published', attempt, external_id: externalId, last_error: null, next_attempt_at: null });
}

/** User-initiated retry of a failed job (e.g. after re-auth). Still idempotent. */
export async function retryJob(ctx: Ctx, jobId: string) {
  requirePerm(ctx, 'publish');
  const r = getScoped(ctx, 'publish_jobs', jobId);
  if (r.status !== 'failed') throw badRequest('失敗したジョブのみ再実行できます');
  const c = getContent(ctx, r.content_id);
  if (c.version !== r.content_version) throw badRequest('内容が変更されています。再承認して新しく予約してください');
  const conn = r.connector_id ? ctx.app.db.get('SELECT * FROM connectors WHERE id = ? AND workspace_id = ?', r.connector_id, ctx.workspaceId) : null;
  if (!conn || conn.status !== 'connected') throw badRequest('Connectorを再認証してください');
  ctx.app.db.update('content_items', c.id, ctx.workspaceId, { status: 'scheduled' });
  ctx.app.db.update('publish_jobs', jobId, ctx.workspaceId, { status: 'running', updated_at: nowIso(ctx) });
  audit(ctx, 'publish.retry', 'publish_job', jobId);
  return processJob(ctx, { ...r, status: 'running' });
}

/** Manual publish handoff payload (copy text, media links, platform URL). */
export function handoff(ctx: Ctx, contentId: string) {
  requirePerm(ctx, 'read');
  const c = getContent(ctx, contentId);
  const media = ctx.app.db.all('SELECT id, mime, filename, storage_key FROM media_assets WHERE workspace_id = ? AND content_id = ?', ctx.workspaceId, contentId).map((m) => ({ id: m.id, mime: m.mime, filename: m.filename, url: ctx.app.storage.signedUrl(m.storage_key, 900, ctx.app.clock.now()) }));
  return { text: [c.title && c.format !== 'post' ? c.title : null, c.body].filter(Boolean).join('\n\n'), media, openUrl: API_FACTS[c.platform].openUrl, platform: c.platform, structured: c.structured };
}

/** Mark as published by the user (distinct from API-confirmed). */
export function markPublished(ctx: Ctx, contentId: string, input: { url?: string | null; publishedAt?: string | null }) {
  requirePerm(ctx, 'write');
  const c = getContent(ctx, contentId);
  if (c.status === 'published') throw badRequest('既に公開済みです');
  const s = getSettings(ctx.app.db, ctx.workspaceId);
  if (s.requireApprovalBeforePublish && !['approved', 'scheduled'].includes(c.status)) throw badRequest('公開済みにするにはApprovedが必要です（設定で変更可）');
  if (input.url && !/^https?:\/\//.test(input.url)) throw badRequest('URLが不正です');
  const at = input.publishedAt ? new Date(input.publishedAt).toISOString() : nowIso(ctx);
  ctx.app.db.update('content_items', contentId, ctx.workspaceId, { status: 'published', published_at: at, published_via: 'user_marked', external_url: input.url ?? null, updated_at: nowIso(ctx) });
  ctx.app.db.run("UPDATE publish_jobs SET status = 'handoff' WHERE workspace_id = ? AND content_id = ? AND status = 'queued' AND mode = 'manual'", ctx.workspaceId, contentId);
  if (c.ideaId) recordIdeaUse(ctx, c.ideaId, c.id, c.platform, at);
  audit(ctx, 'publish.user_marked', 'content', contentId, { url: input.url ? 'set' : null });
  return getContent(ctx, contentId);
}

export function isPlatformId(p: string) {
  return isPlatform(p);
}
