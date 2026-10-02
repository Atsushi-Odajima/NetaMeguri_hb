// Search index + embedding store helpers (shared by sources/ideas/content).
import type { DB } from '../db/db.js';
import { id } from '../lib/util.js';
import { hashVector } from '../lib/text.js';
import { getSettings, type Ctx } from './context.js';

export function indexDoc(db: DB, ws: string, refType: string, refId: string, title: string, body: string) {
  db.run('DELETE FROM search_fts WHERE workspace_id = ? AND ref_type = ? AND ref_id = ?', ws, refType, refId);
  db.run('INSERT INTO search_fts(workspace_id, ref_type, ref_id, title, body) VALUES (?,?,?,?,?)', ws, refType, refId, title ?? '', (body ?? '').slice(0, 20000));
}
export function unindexDoc(db: DB, ws: string, refType: string, refId: string) {
  db.run('DELETE FROM search_fts WHERE workspace_id = ? AND ref_type = ? AND ref_id = ?', ws, refType, refId);
}

export const LOCAL_EMBED_MODEL = 'local-hash-v1';

/**
 * Store a vector for semantic-ish search/similarity. Default model is a local hashing vector
 * (lexical approximation). External embeddings are used only if enabled AND AI is on.
 */
export async function upsertEmbedding(ctx: Ctx, refType: string, refId: string, text: string) {
  const s = getSettings(ctx.app.db, ctx.workspaceId);
  if (s.embeddingProvider === 'off') return null;
  let vector: number[] = hashVector(text);
  let model = LOCAL_EMBED_MODEL;
  if (s.embeddingProvider === 'openai' && s.aiEnabled) {
    const p = ctx.app.ai.providers.get('openai');
    if (p?.configured && p.embed) {
      try {
        ctx.app.ai.calls++;
        vector = (await p.embed([text]))[0];
        model = 'text-embedding-3-small';
      } catch {
        /* fall back to local */
      }
    }
  }
  ctx.app.db.run('DELETE FROM embeddings WHERE workspace_id = ? AND ref_type = ? AND ref_id = ?', ctx.workspaceId, refType, refId);
  const eid = id('emb');
  ctx.app.db.insert('embeddings', { id: eid, workspace_id: ctx.workspaceId, ref_type: refType, ref_id: refId, model, vector: JSON.stringify(vector), created_at: ctx.app.clock.now().toISOString() });
  return eid;
}

export function deleteEmbeddings(db: DB, ws: string, refType: string, refIds: string[]) {
  for (const r of refIds) db.run('DELETE FROM embeddings WHERE workspace_id = ? AND ref_type = ? AND ref_id = ?', ws, refType, r);
}
