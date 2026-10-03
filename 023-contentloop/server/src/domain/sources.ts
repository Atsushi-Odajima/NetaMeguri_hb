import { z } from 'zod';
import { j } from '../db/db.js';
import { id, sha256, conflict, badRequest } from '../lib/util.js';
import { normalize } from '../lib/text.js';
import { safeFetchPage, type Resolver } from '../lib/ssrf.js';
import { analyzeText, detectLanguage, type Analysis, type Segment } from '../ai/local.js';
import { parseTranscript } from '../ai/transcription.js';
import { audit, getScoped, getSettings, nowIso, requirePerm, type Ctx } from './context.js';
import { indexDoc, unindexDoc, upsertEmbedding, deleteEmbeddings } from './index.js';

export const SOURCE_TYPES = ['video', 'audio', 'podcast', 'article', 'blog', 'pdf', 'document', 'transcript', 'web_url', 'image_set', 'manual_idea', 'product_page', 'other'] as const;
export const RIGHTS = ['owned', 'licensed', 'public_reference', 'unknown'] as const;

export const SourceInput = z.object({
  type: z.enum(SOURCE_TYPES),
  title: z.string().min(1).max(300),
  url: z.string().url().max(2000).optional().nullable(),
  text: z.string().max(500_000).optional().nullable(),
  transcript: z.string().max(2_000_000).optional().nullable(), // SRT/VTT/plain timestamps
  durationSec: z.number().int().min(0).max(86400 * 2).optional().nullable(),
  author: z.string().max(200).optional().nullable(),
  publishedAt: z.string().max(40).optional().nullable(),
  language: z.string().max(10).optional().nullable(),
  rightsStatus: z.enum(RIGHTS).default('unknown'),
  rightsNote: z.string().max(2000).optional().nullable(),
  attribution: z.string().max(500).optional().nullable(),
  brandId: z.string().max(40).optional().nullable(),
  mediaId: z.string().max(40).optional().nullable(),
  fetchUrl: z.boolean().default(false),
  aiEligible: z.boolean().default(true),
  evergreen: z.boolean().default(false),
  evergreenCategory: z.string().max(60).optional().nullable(),
});

export function sourceRow(r: any, withText = false) {
  return {
    id: r.id, brandId: r.brand_id, type: r.type, title: r.title, url: r.url, fileRef: r.file_ref, durationSec: r.duration_sec, author: r.author,
    publishedAt: r.published_at, importedAt: r.imported_at, language: r.language, rightsStatus: r.rights_status, rightsNote: r.rights_note,
    attribution: r.attribution, status: r.status, aiEligible: !!r.ai_eligible, evergreen: !!r.evergreen, evergreenCategory: r.evergreen_category,
    analysis: j<Analysis | null>(r.analysis, null), ...(withText ? { text: r.text } : { textLength: r.text?.length ?? 0 }),
  };
}

export function contentHashFor(text: string | null | undefined, url: string | null | undefined) {
  const basis = text && text.trim() ? 't:' + normalize(text) : url ? 'u:' + url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase() : null;
  return basis ? sha256(basis) : null;
}

export async function importSource(ctx: Ctx, input: unknown, opts: { resolve?: Resolver; fetchImpl?: typeof fetch } = {}) {
  requirePerm(ctx, 'write');
  const s = SourceInput.parse(input);
  let text = s.text ?? '';
  let title = s.title;
  let segments: Segment[] = [];
  if (s.transcript) {
    segments = parseTranscript(s.transcript);
    if (!segments.length) throw badRequest('Transcriptを解析できませんでした（SRT/VTT/[mm:ss]形式）');
    if (!text) text = segments.filter((x) => !x.inaudible).map((x) => x.text).join('\n');
  }
  if (s.url && s.fetchUrl && !text) {
    // SSRF-guarded single page fetch. Page text is untrusted data.
    const page = await safeFetchPage(s.url, opts);
    text = page.text;
    if (!s.title || s.title === s.url) title = page.title;
  }
  const hash = contentHashFor(text, s.url);
  if (hash) {
    const dup = ctx.app.db.get('SELECT id, title FROM sources WHERE workspace_id = ? AND content_hash = ? AND deleted_at IS NULL', ctx.workspaceId, hash);
    if (dup) throw conflict('同じ内容のSourceが既に登録されています', { existingId: dup.id, title: dup.title });
  }
  const sid = id('src');
  const status = text ? 'analyzed' : s.type === 'video' || s.type === 'audio' || s.type === 'podcast' ? 'awaiting_transcript' : 'imported';
  const analysis = text ? analyzeText(text, segments) : null;
  ctx.app.db.tx(() => {
    ctx.app.db.insert('sources', {
      id: sid, workspace_id: ctx.workspaceId, brand_id: s.brandId, type: s.type, title, url: s.url, file_ref: s.mediaId, text,
      duration_sec: s.durationSec ?? (segments.length ? Math.ceil(segments[segments.length - 1].endMs / 1000) : null), author: s.author,
      published_at: s.publishedAt, imported_at: nowIso(ctx), language: s.language ?? (text ? detectLanguage(text) : null),
      rights_status: s.rightsStatus, rights_note: s.rightsNote, attribution: s.attribution, status, content_hash: hash,
      ai_eligible: s.aiEligible, evergreen: s.evergreen, evergreen_category: s.evergreenCategory, analysis: analysis ? JSON.stringify(analysis) : null,
    });
    segments.forEach((g) => ctx.app.db.insert('transcript_segments', { id: id('seg'), workspace_id: ctx.workspaceId, source_id: sid, idx: g.idx, start_ms: g.startMs, end_ms: g.endMs, text: g.text, confidence: null, inaudible: g.inaudible ? 1 : 0 }));
    if (s.mediaId) ctx.app.db.run('UPDATE media_assets SET source_id = ? WHERE id = ? AND workspace_id = ?', sid, s.mediaId, ctx.workspaceId);
    indexDoc(ctx.app.db, ctx.workspaceId, 'source', sid, title, text);
  });
  if (text) await upsertEmbedding(ctx, 'source', sid, `${title}\n${text.slice(0, 4000)}`, { externalAllowed: s.aiEligible && brandAllows(ctx, s.brandId) });
  // Optional: do not keep original media when configured (transcript/text remain).
  if (s.mediaId && segments.length && !getSettings(ctx.app.db, ctx.workspaceId).storeOriginalMedia) await deleteMedia(ctx, s.mediaId);
  audit(ctx, 'source.imported', 'source', sid, { type: s.type, rights: s.rightsStatus, chars: text.length });
  return getSource(ctx, sid);
}

export function getSource(ctx: Ctx, sid: string, withText = true) {
  requirePerm(ctx, 'read');
  const r = getScoped(ctx, 'sources', sid);
  return { ...sourceRow(r, withText), segments: getSegments(ctx, sid) };
}
export function getSegments(ctx: Ctx, sid: string): Segment[] {
  return ctx.app.db
    .all('SELECT idx, start_ms, end_ms, text, inaudible FROM transcript_segments WHERE workspace_id = ? AND source_id = ? ORDER BY idx', ctx.workspaceId, sid)
    .map((r) => ({ idx: r.idx, startMs: r.start_ms, endMs: r.end_ms, text: r.text, inaudible: !!r.inaudible }));
}

export function listSources(ctx: Ctx, q: { type?: string; rights?: string; limit?: number; offset?: number } = {}) {
  requirePerm(ctx, 'read');
  return ctx.app.db
    .all(
      `SELECT * FROM sources WHERE workspace_id = ? AND deleted_at IS NULL AND (? IS NULL OR type = ?) AND (? IS NULL OR rights_status = ?) ORDER BY imported_at DESC LIMIT ? OFFSET ?`,
      ctx.workspaceId, q.type ?? null, q.type ?? null, q.rights ?? null, q.rights ?? null, Math.min(q.limit ?? 50, 200), q.offset ?? 0,
    )
    .map((r) => sourceRow(r));
}

/** Attach a transcript to an existing (video/audio) source and re-analyse. */
export async function attachTranscript(ctx: Ctx, sid: string, transcript: string) {
  requirePerm(ctx, 'write');
  const src = getScoped(ctx, 'sources', sid);
  const segments = parseTranscript(transcript);
  if (!segments.length) throw badRequest('Transcriptを解析できませんでした');
  const text = segments.filter((x) => !x.inaudible).map((x) => x.text).join('\n');
  ctx.app.db.tx(() => {
    ctx.app.db.run('DELETE FROM transcript_segments WHERE workspace_id = ? AND source_id = ?', ctx.workspaceId, sid);
    segments.forEach((g) => ctx.app.db.insert('transcript_segments', { id: id('seg'), workspace_id: ctx.workspaceId, source_id: sid, idx: g.idx, start_ms: g.startMs, end_ms: g.endMs, text: g.text, confidence: null, inaudible: g.inaudible ? 1 : 0 }));
    ctx.app.db.update('sources', sid, ctx.workspaceId, { text, status: 'analyzed', analysis: JSON.stringify(analyzeText(text, segments)), language: src.language ?? detectLanguage(text), content_hash: contentHashFor(text, src.url) });
    indexDoc(ctx.app.db, ctx.workspaceId, 'source', sid, src.title, text);
  });
  await upsertEmbedding(ctx, 'source', sid, `${src.title}\n${text.slice(0, 4000)}`, { externalAllowed: !!src.ai_eligible && brandAllows(ctx, src.brand_id) });
  audit(ctx, 'source.transcript_attached', 'source', sid, { segments: segments.length });
  return getSource(ctx, sid);
}

/** Run transcription via provider abstraction (only if configured and AI on). */
export async function transcribeMedia(ctx: Ctx, sid: string, providerId: string) {
  requirePerm(ctx, 'write');
  const src = getScoped(ctx, 'sources', sid);
  const s = getSettings(ctx.app.db, ctx.workspaceId);
  if (!s.aiEnabled) throw badRequest('AIがOFFのため文字起こしは実行できません（Transcriptファイルを手動で添付できます）');
  if (!src.ai_eligible || !brandAllows(ctx, src.brand_id)) throw badRequest('このSourceはAI処理対象外に設定されています');
  const p = ctx.app.transcription.providers.get(providerId);
  if (!p?.configured) throw badRequest('文字起こしプロバイダが設定されていません');
  if (!src.file_ref) throw badRequest('メディアファイルがありません');
  const m = getScoped(ctx, 'media_assets', src.file_ref);
  const buf = await ctx.app.storage.get(m.storage_key);
  if (!buf) throw badRequest('メディアが見つかりません');
  ctx.app.ai.calls++;
  const segs = await p.transcribe(buf, m.mime, { language: src.language ?? undefined });
  const srt = segs.map((g, i) => `${i + 1}\n${msTs(g.startMs)} --> ${msTs(g.endMs)}\n${g.inaudible ? '[inaudible]' : g.text}`).join('\n\n');
  return attachTranscript(ctx, sid, srt);
}
const msTs = (ms: number) => new Date(ms).toISOString().slice(11, 23).replace('.', ',');

export async function updateSource(ctx: Ctx, sid: string, patch: { title?: string; rightsStatus?: string; rightsNote?: string; aiEligible?: boolean; evergreen?: boolean; evergreenCategory?: string | null }) {
  requirePerm(ctx, 'write');
  getScoped(ctx, 'sources', sid);
  if (patch.rightsStatus && !(RIGHTS as readonly string[]).includes(patch.rightsStatus)) throw badRequest('invalid rights');
  ctx.app.db.update('sources', sid, ctx.workspaceId, {
    ...(patch.title ? { title: patch.title } : {}), ...(patch.rightsStatus ? { rights_status: patch.rightsStatus } : {}),
    ...(patch.rightsNote !== undefined ? { rights_note: patch.rightsNote } : {}), ...(patch.aiEligible !== undefined ? { ai_eligible: patch.aiEligible } : {}),
    ...(patch.evergreen !== undefined ? { evergreen: patch.evergreen } : {}), ...(patch.evergreenCategory !== undefined ? { evergreen_category: patch.evergreenCategory } : {}),
  });
  audit(ctx, 'source.updated', 'source', sid, { fields: Object.keys(patch) });
  return getSource(ctx, sid);
}

async function deleteMedia(ctx: Ctx, mediaId: string) {
  const m = ctx.app.db.get('SELECT * FROM media_assets WHERE id = ? AND workspace_id = ?', mediaId, ctx.workspaceId);
  if (!m) return;
  await ctx.app.storage.delete(m.storage_key);
  ctx.app.db.run('DELETE FROM media_assets WHERE id = ?', mediaId);
  ctx.app.db.run('UPDATE sources SET file_ref = NULL WHERE file_ref = ? AND workspace_id = ?', mediaId, ctx.workspaceId);
}

/**
 * Delete a Source: row, transcript, search index, embeddings (vector), media objects.
 * Derived Ideas/Content are kept (user work) but lose the source link; documented in PRIVACY / DATA_MODEL.
 */
export async function deleteSource(ctx: Ctx, sid: string) {
  requirePerm(ctx, 'write');
  getScoped(ctx, 'sources', sid);
  const media = ctx.app.db.all('SELECT id FROM media_assets WHERE workspace_id = ? AND source_id = ?', ctx.workspaceId, sid);
  for (const m of media) await deleteMedia(ctx, m.id);
  ctx.app.db.tx(() => {
    deleteEmbeddings(ctx.app.db, ctx.workspaceId, 'source', [sid]);
    unindexDoc(ctx.app.db, ctx.workspaceId, 'source', sid);
    ctx.app.db.run('DELETE FROM transcript_segments WHERE workspace_id = ? AND source_id = ?', ctx.workspaceId, sid);
    ctx.app.db.run('DELETE FROM sources WHERE id = ? AND workspace_id = ?', sid, ctx.workspaceId);
  });
  audit(ctx, 'source.deleted', 'source', sid);
  return { deleted: true, mediaDeleted: media.length };
}

export function sourceLite(r: any) {
  return { id: r.id, title: r.title, type: r.type, url: r.url, author: r.author, rightsStatus: r.rights_status };
}

/** Brand-level AI eligibility (missing brand → allowed). */
export function brandAllows(ctx: Ctx, brandId: string | null | undefined) {
  if (!brandId) return true;
  const b = ctx.app.db.get('SELECT ai_eligible FROM brands WHERE id = ? AND workspace_id = ?', brandId, ctx.workspaceId);
  return !b || !!b.ai_eligible;
}

/** True only if every referenced source (and its brand) allows external AI. */
export function sourcesAllowAI(ctx: Ctx, sourceIds: string[]) {
  for (const sid of sourceIds) {
    const r = ctx.app.db.get('SELECT ai_eligible, brand_id FROM sources WHERE id = ? AND workspace_id = ?', sid, ctx.workspaceId);
    if (r && (!r.ai_eligible || !brandAllows(ctx, r.brand_id))) return false;
  }
  return true;
}
