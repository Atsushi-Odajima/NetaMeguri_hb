import { j } from '../db/db.js';
import { id, sha256, badRequest } from '../lib/util.js';
import { parseCsv, toCsv, makeZip, readZip } from '../lib/files.js';
import { normalize } from '../lib/text.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { audit, getScoped, getTimezone, nowIso, requirePerm, type Ctx } from './context.js';
import { insertContent, contentRow, getPack, listContent } from './content.js';
import { createIdea, recordIdeaUse, similarIdeas } from './ideas.js';
import { isPlatform, PLATFORMS } from './platforms.js';
import { recordSnapshot } from './performance.js';
import { getCampaign, calendar } from './campaigns.js';
import { indexDoc, LOCAL_EMBED_MODEL } from './index.js';
import { hashVector } from '../lib/text.js';
import { utcToZoned } from '../lib/util.js';

export const APP_VERSION = '0.1.0';

// ---------------------------------------------------------------- Import past posts

const FIELD_GUESS: Record<string, RegExp> = {
  platform: /platform|媒体|sns/i, publishedAt: /date|published|投稿日|日時/i, text: /text|body|本文|content|post/i, url: /url|link|リンク/i,
  impressions: /impression|インプレッション/i, views: /view|再生|閲覧/i, likes: /like|いいね/i, comments: /comment|コメント|repl/i,
  shares: /share|repost|retweet|シェア/i, saves: /save|bookmark|保存/i, clicks: /click|クリック/i,
};

/** Step 1-2: upload CSV → preview with guessed mapping and duplicate flags. Nothing is written yet. */
export async function importPreview(ctx: Ctx, csvText: string, defaultPlatform?: string) {
  requirePerm(ctx, 'write');
  const rows = parseCsv(csvText);
  if (!rows.length) throw badRequest('CSVに行がありません');
  if (rows.length > 20000) throw badRequest('一度に取り込める行数は20,000行までです');
  const headers = Object.keys(rows[0]);
  const mapping: Record<string, string | null> = {};
  for (const [field, re] of Object.entries(FIELD_GUESS)) mapping[field] = headers.find((h) => re.test(h)) ?? null;
  const bid = id('imp');
  ctx.app.db.insert('import_batches', { id: bid, workspace_id: ctx.workspaceId, kind: 'posts_csv', status: 'preview', rows: JSON.stringify(rows), mapping: { ...mapping, defaultPlatform: defaultPlatform ?? null }, result: null, created_by: ctx.userId, created_at: nowIso(ctx) });
  return { batchId: bid, headers, mapping, rowCount: rows.length, preview: await previewRows(ctx, rows.slice(0, 20), mapping, defaultPlatform) };
}

async function previewRows(ctx: Ctx, rows: Record<string, string>[], mapping: Record<string, string | null>, defaultPlatform?: string | null) {
  const out = [];
  for (const r of rows) {
    const text = mapping.text ? r[mapping.text] : '';
    const platform = (mapping.platform ? r[mapping.platform] : defaultPlatform ?? '')?.toLowerCase().trim();
    const hash = sha256(normalize(text));
    const exactDup = !!ctx.app.db.get("SELECT 1 FROM content_items WHERE workspace_id = ? AND published_via = 'imported' AND structured LIKE ?", ctx.workspaceId, `%"importHash":"${hash}"%`);
    const similar = text ? (await similarIdeas(ctx, text, { limit: 1 }))[0] : undefined;
    out.push({ platform, platformValid: isPlatform(platform), publishedAt: mapping.publishedAt ? r[mapping.publishedAt] : null, text: text?.slice(0, 200), exactDuplicate: exactDup, similarIdea: similar ? { ideaId: similar.ideaId, level: similar.level, message: similar.message } : null });
  }
  return out;
}

/** Step 3-4: confirm with (possibly edited) mapping. Creates published ContentItems + Ideas (fingerprints) + snapshots. */
export async function importConfirm(ctx: Ctx, batchId: string, input: { mapping?: Record<string, string | null>; skipDuplicates?: boolean; defaultPlatform?: string }) {
  requirePerm(ctx, 'write');
  const b = getScoped(ctx, 'import_batches', batchId);
  if (b.status !== 'preview') throw badRequest('このImportは確定済みです');
  const rows = j<Record<string, string>[]>(b.rows, []);
  const mapping = { ...j<Record<string, string | null>>(b.mapping, {}), ...(input.mapping ?? {}) };
  const defaultPlatform = input.defaultPlatform ?? (mapping as any).defaultPlatform;
  if (!mapping.text) throw badRequest('本文(text)列のmappingが必要です');
  let created = 0;
  let skipped = 0;
  const errors: { row: number; error: string }[] = [];
  for (const [i, r] of rows.entries()) {
    const text = (r[mapping.text] ?? '').trim();
    const platform = (mapping.platform ? r[mapping.platform] : defaultPlatform ?? '').toLowerCase().trim();
    if (!text) { skipped++; continue; }
    if (!isPlatform(platform)) { errors.push({ row: i + 2, error: `unknown platform "${platform}"` }); continue; }
    const hash = sha256(normalize(text));
    if (input.skipDuplicates !== false && ctx.app.db.get("SELECT 1 FROM content_items WHERE workspace_id = ? AND structured LIKE ?", ctx.workspaceId, `%"importHash":"${hash}"%`)) { skipped++; continue; }
    const dateRaw = mapping.publishedAt ? r[mapping.publishedAt] : '';
    const d = dateRaw ? new Date(dateRaw) : null;
    if (dateRaw && (!d || isNaN(d.getTime()))) { errors.push({ row: i + 2, error: `invalid date "${dateRaw}"` }); continue; }
    const at = (d ?? ctx.app.clock.now()).toISOString();
    const sim = await similarIdeas(ctx, text, { limit: 1 });
    let ideaId: string;
    if (sim[0] && sim[0].level === 'very_similar') ideaId = sim[0].ideaId; // link to existing idea (no new duplicate idea)
    else ideaId = (await createIdea(ctx, { coreIdea: text.slice(0, 300), origin: 'import' })).idea.id;
    const cid = insertContent(ctx, { idea_id: ideaId, source_ids: [], platform, format: PLATFORMS[platform].formats[0], title: null, body: text, status: 'published', published_at: at, published_via: 'imported', external_url: mapping.url ? r[mapping.url] || null : null, structured: { importHash: hash, importBatch: batchId }, human_edited: 1 }, 'import', 'import');
    recordIdeaUse(ctx, ideaId, cid, platform, at);
    const metrics: Record<string, number> = {};
    for (const k of ['impressions', 'views', 'likes', 'comments', 'shares', 'saves', 'clicks']) {
      const col = mapping[k];
      if (col && r[col] !== undefined && r[col] !== '') {
        const n = Number(String(r[col]).replace(/,/g, ''));
        if (Number.isFinite(n) && n >= 0) metrics[k] = n;
      }
    }
    if (Object.keys(metrics).length) recordSnapshot(ctx, { contentId: cid, metrics, window: 'custom', source: 'csv', capturedAt: at });
    created++;
  }
  ctx.app.db.update('import_batches', batchId, ctx.workspaceId, { status: 'done', mapping, result: { created, skipped, errors } });
  audit(ctx, 'import.posts_confirmed', 'import_batch', batchId, { created, skipped, errors: errors.length });
  return { created, skipped, errors };
}

// ---------------------------------------------------------------- Export

export function exportContent(ctx: Ctx, format: 'csv' | 'json' | 'md' | 'txt', q: { campaignId?: string; status?: string } = {}) {
  requirePerm(ctx, 'export');
  const items = listContent(ctx, { ...q, limit: 2000 });
  if (format === 'json') return { mime: 'application/json', filename: 'netameguri-content.json', body: JSON.stringify(items, null, 2) };
  if (format === 'csv') {
    return { mime: 'text/csv; charset=utf-8', filename: 'netameguri-content.csv', body: toCsv(items.map((c) => ({ id: c.id, platform: c.platform, format: c.format, status: c.status, title: c.title, body: c.body, scheduledAt: c.scheduledAt, publishedAt: c.publishedAt, publishedVia: c.publishedVia, ideaId: c.ideaId, campaignId: c.campaignId, url: c.externalUrl }))) };
  }
  const md = items.map((c) => `## ${PLATFORMS[c.platform].label} — ${c.title ?? c.id}\n\nStatus: ${c.status}\n\n${c.body}\n`).join('\n---\n\n');
  return format === 'md' ? { mime: 'text/markdown; charset=utf-8', filename: 'netameguri-content.md', body: md } : { mime: 'text/plain; charset=utf-8', filename: 'netameguri-content.txt', body: items.map((c) => `[${PLATFORMS[c.platform].label}] ${c.status}\n${c.body}`).join('\n\n==========\n\n') };
}

export function exportCampaignCalendar(ctx: Ctx, cid: string) {
  requirePerm(ctx, 'export');
  const c = getCampaign(ctx, cid);
  const tz = getTimezone(ctx.app.db, ctx.workspaceId);
  const rows = [
    ...c.steps.map((s) => ({ date: s.plannedDate, stage: s.stage, platform: s.platform, keyMessage: s.keyMessage, contentId: s.contentId, status: c.items.find((i) => i.id === s.contentId)?.status ?? 'planned', text: c.items.find((i) => i.id === s.contentId)?.body ?? '' })),
    ...c.items.filter((i) => !c.steps.some((s) => s.contentId === i.id)).map((i) => ({ date: i.scheduledAt ? utcToZoned(i.scheduledAt, tz) : '', stage: '', platform: i.platform, keyMessage: '', contentId: i.id, status: i.status, text: i.body })),
  ];
  return { mime: 'text/csv; charset=utf-8', filename: `campaign-${cid}.csv`, body: toCsv(rows, ['date', 'stage', 'platform', 'keyMessage', 'status', 'contentId', 'text']) };
}

/** Content Pack ZIP: one text file per item + manifest. Paths are generated (never from user input) and validated. */
export function exportPackZip(ctx: Ctx, packId: string) {
  requirePerm(ctx, 'export');
  const p = getPack(ctx, packId);
  const files: Record<string, string> = { 'manifest.json': JSON.stringify({ packId: p.id, sourceIds: p.sourceIds, createdAt: p.createdAt, items: p.items.map((i) => ({ id: i.id, platform: i.platform, format: i.format, ideaId: i.ideaId, status: i.status })) }, null, 2) };
  p.items.forEach((i, n) => {
    const base = `${i.platform}/${String(n + 1).padStart(3, '0')}-${i.format}`;
    files[`${base}.txt`] = [i.title, i.body].filter(Boolean).join('\n\n');
    if (i.structured && (i.structured as any).slides) files[`${base}-slides.json`] = JSON.stringify((i.structured as any).slides, null, 2);
  });
  return makeZip(files);
}

/** Platform copy package: ready-to-paste text per platform for approved/scheduled items. */
export function exportCopyPackage(ctx: Ctx) {
  requirePerm(ctx, 'export');
  const items = listContent(ctx, { limit: 2000 }).filter((c) => c.status === 'approved' || c.status === 'scheduled');
  const files: Record<string, string> = {};
  for (const c of items) files[`${c.platform}/${c.id}.txt`] = c.body;
  files['README.txt'] = '各ファイルの本文をコピーして各SNSに投稿し、NetaMeguriで「公開済みにする」を押してください。';
  return makeZip(files);
}

// ---------------------------------------------------------------- Backup / Restore

const BACKUP_TABLES = ['brands', 'sources', 'transcript_segments', 'series', 'ideas', 'idea_uses', 'campaigns', 'campaign_steps', 'briefs', 'content_packs', 'content_items', 'content_versions', 'approvals', 'comments', 'publish_jobs', 'performance_snapshots', 'claims', 'inbox_items', 'notifications', 'audit_logs', 'media_assets', 'notation_dictionaries'] as const;

/**
 * Workspace backup (JSON in ZIP). Includes connector config METADATA only (no tokens).
 * Media binaries are a separate strategy (object storage replication); media rows are listed for reference.
 */
export function backupWorkspace(ctx: Ctx) {
  requirePerm(ctx, 'backup');
  const db = ctx.app.db;
  const ws = db.get('SELECT id, name, kind, timezone, settings, is_sample, created_at FROM workspaces WHERE id = ?', ctx.workspaceId)!;
  const data: Record<string, any[]> = {};
  for (const t of BACKUP_TABLES) data[t] = db.all(`SELECT * FROM ${t} WHERE workspace_id = ?`, ctx.workspaceId);
  data.connectors = db.all('SELECT id, workspace_id, platform, adapter, account_label, status, scopes, token_expires_at, created_at FROM connectors WHERE workspace_id = ?', ctx.workspaceId).map((c) => ({ ...c, status: 'disconnected' }));
  const payload = JSON.stringify({ workspace: ws, data });
  const manifest = { format: 'netameguri-backup', schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, createdAt: nowIso(ctx), workspaceId: ctx.workspaceId, counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])), checksum: sha256(payload), mediaStrategy: 'media binaries are not included; restore them from object storage' };
  audit(ctx, 'backup.created', 'workspace', ctx.workspaceId, { counts: manifest.counts });
  return makeZip({ 'manifest.json': JSON.stringify(manifest, null, 2), 'data.json': payload });
}

/**
 * Restore into an EMPTY target workspace (new IDs not needed: target workspace id replaces source workspace id).
 * Verifies checksum and schema version. Refuses if the target already has data.
 */
export function restoreWorkspace(ctx: Ctx, zip: Uint8Array) {
  requirePerm(ctx, 'backup');
  const files = readZip(zip);
  const manifest = j<any>(files['manifest.json'], null);
  if (!manifest || manifest.format !== 'netameguri-backup') throw badRequest('NetaMeguriのバックアップではありません');
  if (manifest.schemaVersion > SCHEMA_VERSION) throw badRequest('新しいバージョンのバックアップです。アプリを更新してください');
  const payload = files['data.json'];
  if (!payload || sha256(payload) !== manifest.checksum) throw badRequest('チェックサムが一致しません（破損の可能性）');
  const db = ctx.app.db;
  const nonEmpty = ['sources', 'ideas', 'content_items', 'campaigns'].some((t) => db.get<{ c: number }>(`SELECT COUNT(*) c FROM ${t} WHERE workspace_id = ?`, ctx.workspaceId)!.c > 0);
  if (nonEmpty) throw badRequest('復元先のWorkspaceは空である必要があります');
  const { data, workspace } = JSON.parse(payload);
  const order = [...BACKUP_TABLES, 'connectors'];
  // Re-key every record so a backup can be restored next to its original (same DB) or into a fresh instance.
  const idMap = new Map<string, string>();
  for (const t of order) for (const row of data[t] ?? []) if (typeof row.id === 'string') idMap.set(row.id, id(row.id.split('_')[0] || 'r'));
  idMap.set(manifest.workspaceId, ctx.workspaceId);
  const remapStr = (v: string) => idMap.get(v) ?? (/^[\[{]/.test(v) ? v.replace(/[a-z]+_[0-9a-f]{20}/g, (m) => idMap.get(m) ?? m) : v);
  db.tx(() => {
    if (workspace?.settings) db.run('UPDATE workspaces SET settings = ?, timezone = ? WHERE id = ?', workspace.settings, workspace.timezone, ctx.workspaceId);
    for (const t of order) {
      for (const row of data[t] ?? []) {
        const r: Record<string, any> = {};
        for (const [k, v] of Object.entries(row)) r[k] = typeof v === 'string' ? remapStr(v) : v;
        r.workspace_id = ctx.workspaceId;
        if (t === 'connectors') Object.assign(r, { token_enc: null, refresh_enc: null, status: 'disconnected' });
        if (t === 'publish_jobs') r.idempotency_key = sha256(`${row.idempotency_key}|${ctx.workspaceId}`);
        if (t === 'media_assets') r.storage_key = `${ctx.workspaceId}/${r.id}`; // binaries restored separately
        if (t === 'notation_dictionaries') db.run('DELETE FROM notation_dictionaries WHERE workspace_id = ?', ctx.workspaceId); // one per workspace
        db.insert(t, r);
      }
    }
    for (const s of db.all('SELECT id, title, text FROM sources WHERE workspace_id = ?', ctx.workspaceId)) indexDoc(db, ctx.workspaceId, 'source', s.id, s.title, s.text ?? '');
    for (const i of db.all('SELECT id, topic, core_idea FROM ideas WHERE workspace_id = ?', ctx.workspaceId)) indexDoc(db, ctx.workspaceId, 'idea', i.id, i.topic ?? '', i.core_idea);
    for (const c of db.all('SELECT id, title, body FROM content_items WHERE workspace_id = ?', ctx.workspaceId)) indexDoc(db, ctx.workspaceId, 'content', c.id, c.title ?? '', c.body);
  });
  audit(ctx, 'backup.restored', 'workspace', ctx.workspaceId, { from: manifest.workspaceId, counts: manifest.counts });
  rebuildEmbeddings(ctx);
  return { restored: manifest.counts, schemaVersion: manifest.schemaVersion, appVersion: manifest.appVersion, note: 'Connectorは再認証が必要です。メディアファイルは別途復元してください。' };
}

/** Relation integrity report (used after restore and in tests). */
export function relationReport(ctx: Ctx) {
  const db = ctx.app.db;
  const ws = ctx.workspaceId;
  const n = (sql: string) => db.get<{ c: number }>(sql, ws)!.c;
  return {
    sources: n('SELECT COUNT(*) c FROM sources WHERE workspace_id = ?'),
    ideas: n('SELECT COUNT(*) c FROM ideas WHERE workspace_id = ?'),
    content: n('SELECT COUNT(*) c FROM content_items WHERE workspace_id = ?'),
    campaigns: n('SELECT COUNT(*) c FROM campaigns WHERE workspace_id = ?'),
    contentIdeaLinks: n('SELECT COUNT(*) c FROM content_items c JOIN ideas i ON i.id = c.idea_id WHERE c.workspace_id = ?'),
    contentCampaignLinks: n('SELECT COUNT(*) c FROM content_items c JOIN campaigns m ON m.id = c.campaign_id WHERE c.workspace_id = ?'),
    ideaSourceLinks: n("SELECT COUNT(*) c FROM ideas i, json_each(i.source_ids) e JOIN sources s ON s.id = e.value WHERE i.workspace_id = ?"),
    versions: n('SELECT COUNT(*) c FROM content_versions WHERE workspace_id = ?'),
    snapshots: n('SELECT COUNT(*) c FROM performance_snapshots WHERE workspace_id = ?'),
    ideaUses: n('SELECT COUNT(*) c FROM idea_uses WHERE workspace_id = ?'),
    orphanContentIdea: n('SELECT COUNT(*) c FROM content_items c LEFT JOIN ideas i ON i.id = c.idea_id WHERE c.workspace_id = ? AND c.idea_id IS NOT NULL AND i.id IS NULL'),
  };
}

export function listAudit(ctx: Ctx, limit = 200) {
  requirePerm(ctx, 'settings');
  return ctx.app.db.all('SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE a.workspace_id = ? ORDER BY a.created_at DESC LIMIT ?', ctx.workspaceId, Math.min(limit, 1000));
}

export { contentRow, calendar };

/** Vectors are derived data: rebuilt locally after restore (not stored in backups). */
function rebuildEmbeddings(ctx: Ctx) {
  const db = ctx.app.db;
  const put = (refType: string, refId: string, text: string) => db.insert('embeddings', { id: id('emb'), workspace_id: ctx.workspaceId, ref_type: refType, ref_id: refId, model: LOCAL_EMBED_MODEL, vector: JSON.stringify(hashVector(text)), created_at: nowIso(ctx) });
  db.tx(() => {
    for (const s of db.all('SELECT id, title, text FROM sources WHERE workspace_id = ? AND text IS NOT NULL', ctx.workspaceId)) put('source', s.id, `${s.title}\n${String(s.text).slice(0, 4000)}`);
    for (const i of db.all('SELECT id, core_idea FROM ideas WHERE workspace_id = ?', ctx.workspaceId)) put('idea', i.id, i.core_idea);
  });
}
