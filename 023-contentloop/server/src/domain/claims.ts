import { z } from 'zod';
import { j } from '../db/db.js';
import { id, forbidden } from '../lib/util.js';
import { audit, getScoped, nowIso, requirePerm, type Ctx } from './context.js';
import { notify } from './notifications.js';

export const ClaimInput = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  value: z.string().min(1).max(500),
  source: z.string().max(1000).optional().nullable(),
  validFrom: z.string().max(40).optional().nullable(),
  validTo: z.string().max(40).optional().nullable(),
  brandId: z.string().optional().nullable(),
});

export function claimRow(r: any) {
  return {
    id: r.id, key: r.claim_key, label: r.label, value: r.value, source: r.source, validFrom: r.valid_from, validTo: r.valid_to,
    verifiedAt: r.verified_at, verifiedBy: r.verified_by, brandId: r.brand_id, history: j<{ value: string; validFrom: string | null; validTo: string; source: string | null }[]>(r.history, []),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export type Claim = ReturnType<typeof claimRow>;

export function listClaims(ctx: Ctx) {
  requirePerm(ctx, 'read');
  return ctx.app.db.all('SELECT * FROM claims WHERE workspace_id = ? ORDER BY claim_key', ctx.workspaceId).map(claimRow);
}

export function createClaim(ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'write');
  const c = ClaimInput.parse(input);
  const cid = id('clm');
  // New claims are NEVER created as verified; verification is a separate human action.
  ctx.app.db.insert('claims', { id: cid, workspace_id: ctx.workspaceId, brand_id: c.brandId, claim_key: c.key, label: c.label, value: c.value, source: c.source, valid_from: c.validFrom, valid_to: c.validTo, verified_at: null, verified_by: null, history: '[]', created_at: nowIso(ctx), updated_at: nowIso(ctx) });
  audit(ctx, 'claim.created', 'claim', cid, { key: c.key });
  return claimRow(getScoped(ctx, 'claims', cid));
}

export function verifyClaim(ctx: Ctx, cid: string) {
  requirePerm(ctx, 'verify_claims');
  if (ctx.via === 'mcp' || ctx.userId == null) throw forbidden('Claimのverifiedは人間のみが設定できます');
  getScoped(ctx, 'claims', cid);
  ctx.app.db.update('claims', cid, ctx.workspaceId, { verified_at: nowIso(ctx), verified_by: ctx.userId, updated_at: nowIso(ctx) });
  audit(ctx, 'claim.verified', 'claim', cid);
  return claimRow(getScoped(ctx, 'claims', cid));
}

/**
 * Change a claim's value (e.g. product price). Old value goes to history, verification is reset,
 * and related Evergreen ideas / content using the old value are flagged Needs Update.
 */
export function updateClaimValue(ctx: Ctx, cid: string, input: { value: string; source?: string | null; validFrom?: string | null }) {
  requirePerm(ctx, 'write');
  const c = claimRow(getScoped(ctx, 'claims', cid));
  const now = nowIso(ctx);
  const history = [...c.history, { value: c.value, validFrom: c.validFrom, validTo: input.validFrom ?? now, source: c.source }];
  ctx.app.db.update('claims', cid, ctx.workspaceId, { value: input.value, source: input.source ?? c.source, valid_from: input.validFrom ?? now, valid_to: null, verified_at: null, verified_by: null, history, updated_at: now });
  audit(ctx, 'claim.value_changed', 'claim', cid, { key: c.key });
  const flagged = flagOutdated(ctx, c.value, c.label);
  if (flagged.ideas.length + flagged.contents.length) {
    notify(ctx, { kind: 'claim_outdated', message: `「${c.label}」が更新されました。古い値を含むIdea ${flagged.ideas.length}件 / Content ${flagged.contents.length}件をNeeds Updateにしました`, targetType: 'claim', targetId: cid, dedupeKey: `claim:${cid}:${now.slice(0, 10)}` });
  }
  return { claim: claimRow(getScoped(ctx, 'claims', cid)), flagged };
}

function flagOutdated(ctx: Ctx, oldValue: string, label: string) {
  const db = ctx.app.db;
  const like = `%${oldValue.replace(/[%_]/g, '')}%`;
  const ideas = db.all("SELECT id FROM ideas WHERE workspace_id = ? AND core_idea LIKE ? AND status != 'retired'", ctx.workspaceId, like).map((r) => r.id);
  // Evergreen ideas whose source text contains old value are also flagged
  const srcIds = db.all('SELECT id FROM sources WHERE workspace_id = ? AND text LIKE ?', ctx.workspaceId, like).map((r) => r.id);
  for (const sid of srcIds) {
    for (const r of db.all("SELECT id FROM ideas WHERE workspace_id = ? AND evergreen = 1 AND source_ids LIKE ? AND status != 'retired'", ctx.workspaceId, `%"${sid}"%`)) if (!ideas.includes(r.id)) ideas.push(r.id);
  }
  for (const iid of ideas) db.update('ideas', iid, ctx.workspaceId, { status: 'needs_update', updated_at: nowIso(ctx) });
  const contents = db.all("SELECT id, status FROM content_items WHERE workspace_id = ? AND body LIKE ? AND status != 'archived'", ctx.workspaceId, like);
  for (const ci of contents) {
    if (ci.status === 'published') db.update('content_items', ci.id, ctx.workspaceId, { recycle_state: 'update_needed', updated_at: nowIso(ctx) });
    else if (['approved', 'scheduled'].includes(ci.status)) {
      db.update('content_items', ci.id, ctx.workspaceId, { status: 'needs_review', updated_at: nowIso(ctx) });
      db.run("UPDATE publish_jobs SET status = 'cancelled', last_error = ? WHERE workspace_id = ? AND content_id = ? AND status = 'queued'", `claim changed: ${label}`, ctx.workspaceId, ci.id);
    }
  }
  return { ideas, contents: contents.map((c) => c.id) };
}

export interface ClaimIssue { claimId: string; key: string; label: string; message: string; severity: 'warn' | 'block' }

/** Warn when text uses an outdated value or an expired / unverified claim. */
export function checkClaims(ctx: Ctx, text: string): ClaimIssue[] {
  const out: ClaimIssue[] = [];
  const t = text.normalize('NFKC');
  const now = ctx.app.clock.now().toISOString();
  for (const c of listClaims(ctx)) {
    const old = c.history.find((h) => h.value && t.includes(h.value.normalize('NFKC')) && !t.includes(c.value.normalize('NFKC')));
    if (old) out.push({ claimId: c.id, key: c.key, label: c.label, severity: 'block', message: `「${c.label}」の古い値「${old.value}」が使われています（現在: ${c.value}）` });
    const uses = t.includes(c.value.normalize('NFKC'));
    if (uses && c.validTo && c.validTo < now) out.push({ claimId: c.id, key: c.key, label: c.label, severity: 'warn', message: `「${c.label}」は有効期限(${c.validTo.slice(0, 10)})を過ぎています` });
    if (uses && !c.verifiedAt) out.push({ claimId: c.id, key: c.key, label: c.label, severity: 'warn', message: `「${c.label}」は未確認(unverified)のClaimです` });
  }
  return out;
}
