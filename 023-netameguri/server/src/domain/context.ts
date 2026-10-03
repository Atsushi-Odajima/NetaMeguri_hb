import type { DB } from '../db/db.js';
import { j } from '../db/db.js';
import { id, forbidden, notFound, type Clock } from '../lib/util.js';
import type { AIGateway } from '../ai/gateway.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { Storage } from '../lib/storage.js';
import type { TranscriptionRegistry } from '../ai/transcription.js';

export type Role = 'owner' | 'admin' | 'editor' | 'reviewer' | 'viewer';

export interface App {
  db: DB;
  clock: Clock;
  ai: AIGateway;
  connectors: ConnectorRegistry;
  storage: Storage;
  transcription: TranscriptionRegistry;
}

export interface Ctx {
  app: App;
  workspaceId: string;
  userId: string | null; // null = system job
  role: Role;
  canPublishExternal: boolean;
  via?: 'web' | 'mcp' | 'job';
}

export type Permission =
  | 'read' | 'comment' | 'write' | 'review' | 'publish' | 'manage_brand' | 'manage_connectors'
  | 'manage_members' | 'verify_claims' | 'settings' | 'backup' | 'export';

const MATRIX: Record<Role, Permission[]> = {
  viewer: ['read'],
  reviewer: ['read', 'comment', 'review'],
  editor: ['read', 'comment', 'write', 'export'],
  admin: ['read', 'comment', 'write', 'review', 'publish', 'manage_brand', 'manage_connectors', 'manage_members', 'verify_claims', 'settings', 'backup', 'export'],
  owner: ['read', 'comment', 'write', 'review', 'publish', 'manage_brand', 'manage_connectors', 'manage_members', 'verify_claims', 'settings', 'backup', 'export'],
};

export function can(ctx: Pick<Ctx, 'role' | 'canPublishExternal'>, p: Permission): boolean {
  // External posting is never granted to all editors automatically: it requires an explicit per-member flag.
  if (p === 'publish') return ctx.role === 'owner' || ctx.role === 'admin' || (ctx.role === 'editor' && ctx.canPublishExternal);
  return MATRIX[ctx.role].includes(p);
}
export function requirePerm(ctx: Ctx, p: Permission) {
  if (!can(ctx, p)) throw forbidden(`この操作には権限が必要です (${p})`);
}

export interface ReuseRules {
  samePlatformWarnDays: number;
  highPerformerReuseDays: number;
  recyclingCandidateAfterDays: number;
  overusedThreshold: number;
  recentlyUsedDays: number;
  seasonalMonths: Record<string, number[]>;
}
export interface WorkspaceSettings {
  aiEnabled: boolean;
  aiProvider: 'local' | 'anthropic' | 'openai';
  aiModel: string | null;
  aiMonthlyCostCapUsd: number;
  embeddingProvider: 'local-hash' | 'openai' | 'off';
  requireApprovalBeforePublish: boolean;
  reReviewOnEditAfterApproval: boolean;
  storeOriginalMedia: boolean;
  quietHours: { start: string; end: string } | null;
  notificationMaxPerHour: number;
  mcpPublishAllowed: boolean;
  reuseRules: ReuseRules;
  packDefaults: Record<string, number>;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  aiEnabled: true,
  aiProvider: 'local',
  aiModel: null,
  aiMonthlyCostCapUsd: 20,
  embeddingProvider: 'local-hash',
  requireApprovalBeforePublish: true,
  reReviewOnEditAfterApproval: true,
  storeOriginalMedia: true,
  quietHours: { start: '22:00', end: '08:00' },
  notificationMaxPerHour: 10,
  mcpPublishAllowed: false,
  reuseRules: {
    samePlatformWarnDays: 30,
    highPerformerReuseDays: 60,
    recyclingCandidateAfterDays: 45,
    overusedThreshold: 4,
    recentlyUsedDays: 30,
    seasonalMonths: {},
  },
  packDefaults: { short_video: 8, threads: 12, x: 15, linkedin: 5, instagram_carousel: 3, blog: 2, newsletter: 1, quote: 14 },
};

export function getSettings(db: DB, workspaceId: string): WorkspaceSettings {
  const row = db.get<{ settings: string }>('SELECT settings FROM workspaces WHERE id = ?', workspaceId);
  if (!row) throw notFound('workspace');
  const s = j<Partial<WorkspaceSettings>>(row.settings, {});
  return { ...DEFAULT_SETTINGS, ...s, reuseRules: { ...DEFAULT_SETTINGS.reuseRules, ...(s.reuseRules ?? {}) }, packDefaults: { ...DEFAULT_SETTINGS.packDefaults, ...(s.packDefaults ?? {}) } };
}
export function getTimezone(db: DB, workspaceId: string): string {
  return db.get<{ timezone: string }>('SELECT timezone FROM workspaces WHERE id = ?', workspaceId)?.timezone ?? 'UTC';
}

/** Audit: record actor/time/action/target. Never pass secrets or full bodies in meta. */
export function audit(ctx: Ctx, action: string, targetType: string | null, targetId: string | null, meta?: Record<string, unknown>) {
  ctx.app.db.insert('audit_logs', {
    id: id('aud'),
    workspace_id: ctx.workspaceId,
    actor_id: ctx.userId,
    action,
    target_type: targetType,
    target_id: targetId,
    meta: meta ? JSON.stringify({ ...meta, via: ctx.via ?? 'web' }) : JSON.stringify({ via: ctx.via ?? 'web' }),
    created_at: ctx.app.clock.now().toISOString(),
  });
}

export const nowIso = (ctx: Ctx) => ctx.app.clock.now().toISOString();

/** Fetch a tenant-scoped row or 404 (never reveals existence in other tenants). */
export function getScoped<T = any>(ctx: Ctx, table: string, rowId: string): T {
  if (!/^[a-z_]+$/.test(table)) throw new Error('bad table');
  const r = ctx.app.db.get<T>(`SELECT * FROM ${table} WHERE id = ? AND workspace_id = ?`, rowId, ctx.workspaceId);
  if (!r) throw notFound(table);
  return r;
}
