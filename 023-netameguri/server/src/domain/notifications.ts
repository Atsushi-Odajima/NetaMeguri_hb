import { id } from '../lib/util.js';
import { getSettings, getTimezone, requirePerm, type Ctx } from './context.js';
import { utcToZoned, zonedToUtc } from '../lib/util.js';

export type NotificationKind = 'review_requested' | 'schedule_failed' | 'connector_expiring' | 'connector_failed' | 'campaign_gap' | 'recycling_candidate' | 'claim_outdated' | 'manual_publish_due' | 'changes_requested' | 'approved';

/**
 * Create a notification with storm protection:
 *  - dedupeKey: same key within 24h is dropped
 *  - per-hour cap per workspace (excess is dropped, counted in a digest)
 *  - quiet hours (workspace timezone): delivery deferred to end of quiet period
 */
export function notify(ctx: Ctx, n: { kind: NotificationKind; message: string; targetType?: string; targetId?: string; dedupeKey?: string; userId?: string | null }) {
  const db = ctx.app.db;
  const now = ctx.app.clock.now();
  const since = new Date(now.getTime() - 86400_000).toISOString();
  if (n.dedupeKey && db.get('SELECT id FROM notifications WHERE workspace_id = ? AND dedupe_key = ? AND created_at >= ?', ctx.workspaceId, n.dedupeKey, since)) return null;
  const s = getSettings(db, ctx.workspaceId);
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const recent = db.get<{ c: number }>('SELECT COUNT(*) c FROM notifications WHERE workspace_id = ? AND created_at >= ?', ctx.workspaceId, hourAgo)!.c;
  if (recent >= s.notificationMaxPerHour) return null;
  const deliverAfter = s.quietHours ? quietHoursEnd(now, getTimezone(db, ctx.workspaceId), s.quietHours) : null;
  const nid = id('ntf');
  db.insert('notifications', { id: nid, workspace_id: ctx.workspaceId, user_id: n.userId ?? null, kind: n.kind, message: n.message, target_type: n.targetType, target_id: n.targetId, dedupe_key: n.dedupeKey, deliver_after: deliverAfter, read_at: null, created_at: now.toISOString() });
  return nid;
}

/** If now is within quiet hours in tz, return the UTC ISO time when quiet hours end; else null. */
export function quietHoursEnd(now: Date, tz: string, q: { start: string; end: string }): string | null {
  const local = utcToZoned(now.toISOString(), tz); // YYYY-MM-DDTHH:mm
  const hm = local.slice(11, 16);
  const inQuiet = q.start <= q.end ? hm >= q.start && hm < q.end : hm >= q.start || hm < q.end;
  if (!inQuiet) return null;
  const date = local.slice(0, 10);
  let endDate = date;
  if (q.start > q.end && hm >= q.start) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    endDate = d.toISOString().slice(0, 10);
  }
  return zonedToUtc(`${endDate}T${q.end}`, tz);
}

export function listNotifications(ctx: Ctx, opts: { includeDeferred?: boolean } = {}) {
  requirePerm(ctx, 'read');
  const now = ctx.app.clock.now().toISOString();
  return ctx.app.db.all(
    `SELECT * FROM notifications WHERE workspace_id = ? AND (user_id IS NULL OR user_id = ?) AND (? = 1 OR deliver_after IS NULL OR deliver_after <= ?) ORDER BY created_at DESC LIMIT 100`,
    ctx.workspaceId, ctx.userId, opts.includeDeferred ? 1 : 0, now,
  );
}
export function markRead(ctx: Ctx, nid: string) {
  ctx.app.db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND workspace_id = ?', ctx.app.clock.now().toISOString(), nid, ctx.workspaceId);
}
