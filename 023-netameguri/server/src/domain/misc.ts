import { id, sha256, badRequest } from '../lib/util.js';
import { validateUpload } from '../lib/files.js';
import { topKeywords } from '../lib/text.js';
import { audit, getScoped, nowIso, requirePerm, type Ctx } from './context.js';
import { importSource } from './sources.js';
import { createIdea } from './ideas.js';
import { detectAngle } from '../ai/local.js';

// ---------------------------------------------------------------- Quick Capture / Inbox

/**
 * Capture from mobile/PWA. clientId makes offline replays idempotent (same clientId → same item).
 */
export function capture(ctx: Ctx, input: { kind?: string; text?: string; url?: string; mediaId?: string; clientId?: string }) {
  requirePerm(ctx, 'write');
  if (!input.text && !input.url && !input.mediaId) throw badRequest('テキスト・URL・メディアのいずれかが必要です');
  if (input.url && !/^https?:\/\//.test(input.url)) throw badRequest('URLが不正です');
  if (input.clientId) {
    const dup = ctx.app.db.get('SELECT * FROM inbox_items WHERE workspace_id = ? AND client_id = ?', ctx.workspaceId, input.clientId);
    if (dup) return { item: dup, duplicate: true };
  }
  const kind = input.kind ?? (input.url ? 'url' : input.mediaId ? 'media' : 'text');
  const iid = id('inb');
  ctx.app.db.insert('inbox_items', { id: iid, workspace_id: ctx.workspaceId, kind, text: input.text?.slice(0, 10000), url: input.url, media_id: input.mediaId, client_id: input.clientId, status: 'unsorted', suggestion: JSON.stringify(classify(input)), created_by: ctx.userId, created_at: nowIso(ctx) });
  return { item: getScoped(ctx, 'inbox_items', iid), duplicate: false };
}

/** Classification suggestion (human confirms). */
export function classify(input: { text?: string; url?: string; mediaId?: string }) {
  const t = input.text ?? '';
  if (input.url) return { action: 'source', sourceType: /youtube\.com|youtu\.be/.test(input.url) ? 'video' : /podcast|spotify|anchor/.test(input.url) ? 'podcast' : 'web_url', reason: 'URLはSourceとして取り込む候補です' };
  if (input.mediaId) return { action: 'source', sourceType: 'image_set', reason: 'メディアはSource候補です' };
  if ([...t].length < 200) return { action: 'idea', angle: detectAngle(t), topic: topKeywords(t, 1)[0] ?? null, reason: '短文はIdea候補です' };
  return { action: 'source', sourceType: 'manual_idea', reason: '長文はSource（メモ）候補です' };
}

export function listInbox(ctx: Ctx, status = 'unsorted') {
  requirePerm(ctx, 'read');
  return ctx.app.db.all('SELECT * FROM inbox_items WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200', ctx.workspaceId, status).map((r) => ({ ...r, suggestion: JSON.parse(r.suggestion ?? 'null') }));
}

/** Human-confirmed processing of an inbox item. */
export async function processInbox(ctx: Ctx, itemId: string, decision: { action: 'idea' | 'source' | 'discard'; sourceType?: string; title?: string; rightsStatus?: string; fetchUrl?: boolean }) {
  requirePerm(ctx, 'write');
  const it = getScoped(ctx, 'inbox_items', itemId);
  if (it.status !== 'unsorted') throw badRequest('処理済みです');
  let result: any = null;
  if (decision.action === 'idea') result = (await createIdea(ctx, { coreIdea: it.text ?? it.url, origin: 'inbox' })).idea;
  else if (decision.action === 'source') {
    result = await importSource(ctx, { type: decision.sourceType ?? (it.url ? 'web_url' : 'manual_idea'), title: decision.title ?? (it.text?.slice(0, 60) || it.url), url: it.url ?? undefined, text: it.text ?? undefined, mediaId: it.media_id ?? undefined, rightsStatus: decision.rightsStatus ?? 'unknown', fetchUrl: decision.fetchUrl ?? false });
  }
  ctx.app.db.update('inbox_items', itemId, ctx.workspaceId, { status: decision.action === 'discard' ? 'discarded' : 'processed' });
  audit(ctx, 'inbox.processed', 'inbox_item', itemId, { action: decision.action });
  return { status: decision.action, result };
}

// ---------------------------------------------------------------- Media

export async function uploadMedia(ctx: Ctx, input: { data: Uint8Array; declaredMime: string; filename?: string; sourceId?: string; contentId?: string }) {
  requirePerm(ctx, 'write');
  const { mime, kind } = validateUpload(input.data, input.declaredMime);
  if (input.sourceId) getScoped(ctx, 'sources', input.sourceId);
  if (input.contentId) getScoped(ctx, 'content_items', input.contentId);
  const mid = id('med');
  const key = `${ctx.workspaceId}/${mid}`; // server-generated key; user filename is metadata only
  await ctx.app.storage.put(key, input.data);
  ctx.app.db.insert('media_assets', { id: mid, workspace_id: ctx.workspaceId, source_id: input.sourceId, content_id: input.contentId, kind, mime, size: input.data.byteLength, storage_key: key, sha256: sha256(Buffer.from(input.data)), filename: (input.filename ?? '').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120), created_at: nowIso(ctx) });
  audit(ctx, 'media.uploaded', 'media', mid, { mime, size: input.data.byteLength });
  return mediaView(ctx, getScoped(ctx, 'media_assets', mid));
}
export function mediaView(ctx: Ctx, m: any) {
  return { id: m.id, kind: m.kind, mime: m.mime, size: m.size, filename: m.filename, sourceId: m.source_id, contentId: m.content_id, url: ctx.app.storage.signedUrl(m.storage_key, 900, ctx.app.clock.now()) };
}
export function listMedia(ctx: Ctx, q: { sourceId?: string; contentId?: string }) {
  requirePerm(ctx, 'read');
  return ctx.app.db.all('SELECT * FROM media_assets WHERE workspace_id = ? AND (? IS NULL OR source_id = ?) AND (? IS NULL OR content_id = ?)', ctx.workspaceId, q.sourceId ?? null, q.sourceId ?? null, q.contentId ?? null, q.contentId ?? null).map((m) => mediaView(ctx, m));
}

/** Detach a media file from a ContentItem (the stored object is kept; used by NetaMeguri 納品パック image list). */
export function detachMedia(ctx: Ctx, contentId: string, mediaId: string) {
  requirePerm(ctx, 'write');
  getScoped(ctx, 'content_items', contentId);
  const m = getScoped(ctx, 'media_assets', mediaId);
  if (m.content_id !== contentId) throw badRequest('このContentのメディアではありません');
  ctx.app.db.update('media_assets', mediaId, ctx.workspaceId, { content_id: null });
  audit(ctx, 'media.detached', 'media', mediaId, { contentId });
  return { ok: true };
}

// ---------------------------------------------------------------- UTM

export function buildUtm(input: { url: string; source: string; medium?: string; campaign?: string; content?: string; term?: string }) {
  let u: URL;
  try {
    u = new URL(input.url);
  } catch {
    throw badRequest('URLが不正です');
  }
  if (!/^https?:$/.test(u.protocol)) throw badRequest('http/httpsのみ');
  const slug = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '').slice(0, 60);
  u.searchParams.set('utm_source', slug(input.source));
  u.searchParams.set('utm_medium', slug(input.medium ?? 'social'));
  if (input.campaign) u.searchParams.set('utm_campaign', slug(input.campaign));
  if (input.content) u.searchParams.set('utm_content', slug(input.content));
  if (input.term) u.searchParams.set('utm_term', slug(input.term));
  return { url: u.toString(), note: 'クリック数はConnector/外部Analyticsで取得可能な場合のみ表示します。個人単位のトラッキングは行いません。' };
}
