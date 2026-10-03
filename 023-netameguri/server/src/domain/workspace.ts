import type { DB } from '../db/db.js';
import { j } from '../db/db.js';
import { id, token, hashPassword, verifyPassword, AppError, badRequest, forbidden, notFound, isValidTimezone } from '../lib/util.js';
import { audit, requirePerm, DEFAULT_SETTINGS, getSettings, type App, type Ctx, type Role, type WorkspaceSettings } from './context.js';

const SESSION_DAYS = 14;

export function createUser(db: DB, email: string, name: string, password: string, now: Date) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('メールアドレスが不正です');
  if (password.length < 10) throw badRequest('パスワードは10文字以上にしてください');
  if (db.get('SELECT id FROM users WHERE email = ?', email.toLowerCase())) throw new AppError(409, 'email_taken', 'このメールアドレスは登録済みです');
  const u = { id: id('usr'), email: email.toLowerCase(), name, password_hash: hashPassword(password), created_at: now.toISOString() };
  db.insert('users', u);
  return { id: u.id, email: u.email, name };
}

export function createWorkspace(db: DB, ownerId: string, name: string, now: Date, opts: { kind?: string; timezone?: string; isSample?: boolean; settings?: Partial<WorkspaceSettings> } = {}) {
  const orgId = id('org');
  db.insert('organizations', { id: orgId, name, created_at: now.toISOString() });
  const wsId = id('ws');
  db.insert('workspaces', {
    id: wsId, org_id: orgId, name, kind: opts.kind ?? 'personal', timezone: opts.timezone ?? 'Asia/Tokyo',
    settings: JSON.stringify({ ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) }), is_sample: opts.isSample ? 1 : 0, created_at: now.toISOString(),
  });
  db.insert('memberships', { workspace_id: wsId, user_id: ownerId, role: 'owner', can_publish_external: 1 });
  return wsId;
}

export function login(db: DB, email: string, password: string, now: Date) {
  const u = db.get('SELECT * FROM users WHERE email = ?', String(email).toLowerCase());
  if (!u || !verifyPassword(password, u.password_hash)) throw new AppError(401, 'invalid_credentials', 'メールアドレスまたはパスワードが違います');
  const s = { id: token(32), user_id: u.id, csrf_token: token(24), expires_at: new Date(now.getTime() + SESSION_DAYS * 86400_000).toISOString(), created_at: now.toISOString() };
  db.insert('sessions', s);
  db.insert('audit_logs', { id: id('aud'), workspace_id: null, actor_id: u.id, action: 'auth.login', target_type: 'user', target_id: u.id, meta: null, created_at: now.toISOString() });
  return { sessionId: s.id, csrfToken: s.csrf_token, user: { id: u.id, email: u.email, name: u.name } };
}

export function sessionUser(db: DB, sessionId: string | undefined, now: Date) {
  if (!sessionId) return null;
  const s = db.get('SELECT s.*, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?', sessionId);
  if (!s || new Date(s.expires_at) < now) return null;
  return { userId: s.user_id as string, email: s.email as string, name: s.name as string, csrfToken: s.csrf_token as string };
}

export function logout(db: DB, sessionId: string) {
  db.run('DELETE FROM sessions WHERE id = ?', sessionId);
}

/** Resolve membership → Ctx. Tenant isolation: a user can only act inside workspaces they are a member of. */
export function ctxFor(app: App, userId: string, workspaceId: string, via: Ctx['via'] = 'web'): Ctx {
  const m = app.db.get('SELECT role, can_publish_external FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
  if (!m) throw notFound('workspace'); // do not reveal existence
  return { app, workspaceId, userId, role: m.role as Role, canPublishExternal: !!m.can_publish_external, via };
}
export function systemCtx(app: App, workspaceId: string): Ctx {
  return { app, workspaceId, userId: null, role: 'admin', canPublishExternal: true, via: 'job' };
}

export function listWorkspaces(db: DB, userId: string) {
  return db.all('SELECT w.id, w.name, w.kind, w.timezone, w.is_sample, m.role, m.can_publish_external FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at', userId);
}

export function workspaceInfo(ctx: Ctx) {
  const w = ctx.app.db.get('SELECT id, name, kind, timezone, is_sample, created_at FROM workspaces WHERE id = ?', ctx.workspaceId)!;
  return { ...w, settings: getSettings(ctx.app.db, ctx.workspaceId), role: ctx.role, canPublishExternal: ctx.canPublishExternal, ai: ctx.app.ai.status(ctx.workspaceId) };
}

export function updateSettings(ctx: Ctx, patch: Partial<WorkspaceSettings> & { timezone?: string; name?: string }) {
  requirePerm(ctx, 'settings');
  const cur = getSettings(ctx.app.db, ctx.workspaceId);
  const { timezone, name, ...rest } = patch;
  const next = { ...cur, ...rest, reuseRules: { ...cur.reuseRules, ...(rest.reuseRules ?? {}) } };
  if (rest.aiProvider && !['local', 'anthropic', 'openai'].includes(rest.aiProvider)) throw badRequest('unknown provider');
  if (timezone !== undefined) {
    if (!isValidTimezone(timezone)) throw badRequest('不正なタイムゾーンです');
    ctx.app.db.run('UPDATE workspaces SET timezone = ? WHERE id = ?', timezone, ctx.workspaceId);
  }
  if (name) ctx.app.db.run('UPDATE workspaces SET name = ? WHERE id = ?', name, ctx.workspaceId);
  ctx.app.db.run('UPDATE workspaces SET settings = ? WHERE id = ?', JSON.stringify(next), ctx.workspaceId);
  const changed = Object.keys(patch);
  audit(ctx, 'workspace.settings_updated', 'workspace', ctx.workspaceId, { changed, aiEnabled: next.aiEnabled, aiProvider: next.aiProvider });
  return getSettings(ctx.app.db, ctx.workspaceId);
}

export function listMembers(ctx: Ctx) {
  requirePerm(ctx, 'read');
  return ctx.app.db.all('SELECT u.id, u.email, u.name, m.role, m.can_publish_external FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?', ctx.workspaceId);
}

export function addMember(ctx: Ctx, email: string, role: Role, canPublishExternal = false) {
  requirePerm(ctx, 'manage_members');
  if (role === 'owner' && ctx.role !== 'owner') throw forbidden('ownerのみownerを追加できます');
  const u = ctx.app.db.get('SELECT id FROM users WHERE email = ?', email.toLowerCase());
  if (!u) throw notFound('user');
  // External publish is never auto-granted to editors; it must be set explicitly.
  ctx.app.db.run('INSERT OR REPLACE INTO memberships(workspace_id,user_id,role,can_publish_external) VALUES (?,?,?,?)', ctx.workspaceId, u.id, role, canPublishExternal && role !== 'viewer' && role !== 'reviewer' ? 1 : 0);
  audit(ctx, 'member.upserted', 'user', u.id, { role, canPublishExternal });
  return listMembers(ctx);
}

export function getWorkspaceSettingsJson(db: DB, wsId: string) {
  return j(db.get<{ settings: string }>('SELECT settings FROM workspaces WHERE id = ?', wsId)?.settings, {});
}
