// Performance test with generated data. Usage: SCALE=0.1 npx tsx scripts/perf.ts  (SCALE=1 → 100k/500k/2M/20M)
// Results are written to perf-results.json. These are measurements on this machine, not sales guarantees.
import { rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { createApp } from '../server/src/app.js';
import { createUser, createWorkspace, ctxFor } from '../server/src/domain/workspace.js';
import { makeFingerprint } from '../server/src/domain/fingerprint.js';
import { hashVector } from '../server/src/lib/text.js';
import { similarIdeas } from '../server/src/domain/ideas.js';
import { search } from '../server/src/domain/search.js';
import { calendar } from '../server/src/domain/campaigns.js';
import { performanceSummary, feedback } from '../server/src/domain/performance.js';
import { transform, analyzeText } from '../server/src/ai/local.js';
import { runDueJobs, saveConnection } from '../server/src/domain/publish.js';
import { uploadMedia } from '../server/src/domain/misc.js';
import { SandboxAdapter } from '../server/src/connectors/registry.js';
import { id } from '../server/src/lib/util.js';

const SCALE = Number(process.env.SCALE ?? 0.1);
const N = { sources: Math.round(100_000 * SCALE), ideas: Math.round(500_000 * SCALE), content: Math.round(2_000_000 * SCALE), snapshots: Math.round(20_000_000 * SCALE) };
const dir = process.env.PERF_DIR ?? './perf-data';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const app = createApp({ dbPath: `${dir}/perf.db` });
const db = app.db;
const now = new Date();
const owner = createUser(db, 'perf@example.com', 'Perf', 'password-123456', now);
const ws = createWorkspace(db, owner.id, 'Perf WS', now);
const ctx = ctxFor(app, owner.id, ws);

const TOPICS = ['AI開発', 'リリース', 'チェックリスト', 'テスト', 'デザイン', '集客', 'SNS運用', '価格設定', '失敗談', 'ポッドキャスト', '動画編集', 'ブログ', 'ニュースレター', 'プロダクト', '採用'];
const PHRASES = ['を始める前に決めること', 'でつまずいた3つのポイント', 'を毎日続けるコツ', 'の手順をまとめました', 'で一番大事なのは小さく試すこと', 'を外注する前に確認したいこと', 'の失敗から学んだこと', 'のチェックリスト', 'を数字で振り返る', 'を半年続けた結果'];
const PLATFORMS = ['threads', 'x', 'linkedin', 'instagram', 'blog', 'newsletter'];
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const sentence = () => `${pick(TOPICS)}${pick(PHRASES)}。${pick(TOPICS)}${pick(PHRASES)}。`;

const results: Record<string, any> = { scale: SCALE, counts: N, machine: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 1e9), node: process.version }, generatedAt: now.toISOString(), timings: {} };
function time<T>(label: string, fn: () => T): T {
  const t = performance.now();
  const r = fn();
  results.timings[label] = Math.round(performance.now() - t);
  console.log(label, results.timings[label], 'ms');
  return r;
}
async function timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const r = await fn();
  results.timings[label] = Math.round(performance.now() - t);
  console.log(label, results.timings[label], 'ms');
  return r;
}
async function measure(label: string, runs: number, fn: (i: number) => unknown | Promise<unknown>) {
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn(i);
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  const r = { runs, p50: +xs[Math.floor(runs * 0.5)].toFixed(1), p95: +xs[Math.min(runs - 1, Math.floor(runs * 0.95))].toFixed(1), max: +xs[runs - 1].toFixed(1) };
  results.timings[label] = r;
  console.log(label, r);
}

// ---------------- data generation (bulk SQL; bypasses domain logic for speed) ----------------
const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86400_000).toISOString();
const BATCH = 20000;
function bulk(label: string, total: number, make: (i: number) => void) {
  time(label, () => {
    for (let i = 0; i < total; i += BATCH) db.tx(() => { for (let k = i; k < Math.min(total, i + BATCH); k++) make(k); });
  });
}
const srcIds: string[] = [];
bulk('gen.sources', N.sources, (i) => {
  const sid = `src_${String(i).padStart(20, '0')}`;
  srcIds.push(sid);
  const text = Array.from({ length: 6 }, sentence).join('\n');
  db.run('INSERT INTO sources (id,workspace_id,type,title,text,imported_at,rights_status,status,content_hash) VALUES (?,?,?,?,?,?,?,?,?)', sid, ws, pick(['video', 'blog', 'article', 'podcast']), `${pick(TOPICS)}の話 #${i}`, text, iso(rnd() * 700), 'owned', 'analyzed', `h${i}`);
  db.run('INSERT INTO search_fts(workspace_id, ref_type, ref_id, title, body) VALUES (?,?,?,?,?)', ws, 'source', sid, `${pick(TOPICS)}の話 #${i}`, text);
});
const ideaIds: string[] = [];
bulk('gen.ideas+fingerprint+vector', N.ideas, (i) => {
  const iid = `idea_${String(i).padStart(20, '0')}`;
  ideaIds.push(iid);
  const core = sentence();
  const used = rnd() < 0.4;
  db.run('INSERT INTO ideas (id,workspace_id,core_idea,angle,topic,source_ids,status,use_count,last_used_at,fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    iid, ws, core, pick(['insight', 'how_to', 'failure_story', 'checklist']), pick(TOPICS), JSON.stringify([srcIds[i % srcIds.length]]), used ? 'used' : 'new', used ? 1 : 0, used ? iso(rnd() * 365) : null, JSON.stringify(makeFingerprint(core)), iso(rnd() * 700), iso(0));
  db.run('INSERT INTO search_fts(workspace_id, ref_type, ref_id, title, body) VALUES (?,?,?,?,?)', ws, 'idea', iid, '', core);
  db.run('INSERT INTO embeddings (id,workspace_id,ref_type,ref_id,model,vector,created_at) VALUES (?,?,?,?,?,?,?)', `emb_${i}`, ws, 'idea', iid, 'local-hash-v1', JSON.stringify(hashVector(core)), iso(0));
});
const contentIds: string[] = [];
bulk('gen.content', N.content, (i) => {
  const cid = `cnt_${String(i).padStart(20, '0')}`;
  contentIds.push(cid);
  const published = rnd() < 0.6;
  const at = published ? iso(rnd() * 365) : iso(-rnd() * 60);
  db.run('INSERT INTO content_items (id,workspace_id,idea_id,source_ids,platform,format,body,status,scheduled_at,published_at,published_via,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    cid, ws, ideaIds[i % ideaIds.length], '[]', pick(PLATFORMS), 'post', sentence() + sentence(), published ? 'published' : pick(['draft', 'approved', 'scheduled']), published ? null : at, published ? at : null, published ? 'user_marked' : null, iso(400), iso(0));
  if (i % 4 === 0) db.run('INSERT INTO search_fts(workspace_id, ref_type, ref_id, title, body) VALUES (?,?,?,?,?)', ws, 'content', cid, '', sentence());
});
bulk('gen.snapshots', N.snapshots, (i) => {
  const cid = contentIds[i % contentIds.length];
  db.run('INSERT INTO performance_snapshots (id,workspace_id,content_id,platform,captured_at,window,metrics,source) VALUES (?,?,?,?,?,?,?,?)', `perf_${i}`, ws, cid, 'threads', iso(rnd() * 365), pick(['24h', '7d', '30d']), JSON.stringify({ views: Math.floor(rnd() * 10000), likes: Math.floor(rnd() * 500), comments: Math.floor(rnd() * 50) }), 'csv');
});
time('db.analyze', () => db.exec('ANALYZE'));
results.dbSizeMB = Math.round(statSync(`${dir}/perf.db`).size / 1e6);

// ---------------- measurements ----------------
await measure('library.search (fulltext+semantic+filters)', 20, (i) => search(ctx, [`${TOPICS[i % TOPICS.length]}のチェックリスト`, 'まだThreadsで使ってないAI開発ネタ'][i % 2], { limit: 30 }));
await measure('similarity.check (fingerprint vs candidate pool)', 20, (i) => similarIdeas(ctx, `${TOPICS[i % TOPICS.length]}${PHRASES[i % PHRASES.length]}。小さく試す。`, {}));
await measure('calendar.month', 20, (i) => calendar(ctx, iso(30 - i), iso(-(i % 3))));
await measure('content.list (status+platform)', 20, () => db.all("SELECT id FROM content_items WHERE workspace_id = ? AND status = 'scheduled' AND platform = 'threads' ORDER BY scheduled_at DESC LIMIT 200", ws));
await measure('performance.summary (30d)', 3, () => performanceSummary(ctx, { days: 30 }));
await measure('performance.feedback topic (30d)', 3, () => feedback(ctx, 'topic', { days: 30 }));

// AI generation (local extractive engine) + embedding
const text = Array.from({ length: 40 }, sentence).join('\n');
await measure('ai.local.analyze (40 sentences)', 50, () => analyzeText(text));
await measure('ai.local.transform (threads)', 200, (i) => transform({ idea: { coreIdea: sentence(), angle: 'how_to', topic: TOPICS[i % TOPICS.length] }, supporting: [sentence(), sentence()], platform: 'threads', format: 'post', brand: { name: 'B', language: 'ja' }, sources: [] }));
await measure('embedding.local-hash (1 text)', 500, () => hashVector(sentence()));

// Queue: 1000 due publish jobs on sandbox
const sb = app.connectors.get('sandbox:threads') as SandboxAdapter;
saveConnection(ctx, 'sandbox:threads', { accessToken: 'sbx-at-perf', scopes: ['publish'] }, 'perf');
const conn = db.get("SELECT id FROM connectors WHERE workspace_id = ? AND adapter = 'sandbox:threads'", ws)!;
db.tx(() => {
  for (let i = 0; i < 1000; i++) {
    const cid = contentIds[i];
    db.run("UPDATE content_items SET status = 'scheduled', platform = 'threads', version = 1 WHERE id = ?", cid);
    db.insert('publish_jobs', { id: id('job'), workspace_id: ws, content_id: cid, platform: 'threads', connector_id: conn.id, mode: 'api', scheduled_at: iso(1), timezone: 'UTC', status: 'queued', attempt: 0, idempotency_key: `perf-${i}`, content_version: 1, created_at: iso(1), updated_at: iso(1) });
  }
});
process.env.__perf = '1';
const bucketsBypass = await timeAsync('queue.runDueJobs (50/batch until drained, 1000 jobs, local rate limit applies)', async () => {
  let total = 0;
  for (let k = 0; k < 40; k++) {
    const r = await runDueJobs(app);
    total += r.filter((x: any) => x.status === 'published').length;
    if (!r.length) break;
  }
  return total;
});
results.queuePublished = bucketsBypass;
results.queueNote = 'connector token bucket (30/min/connector) intentionally throttles; jobs beyond the bucket are re-queued with next_attempt_at';
results.sandboxRemotePosts = sb.remote.size;

// Connector polling (sandbox metrics)
await measure('connector.poll metrics (sandbox, per post)', 200, (i) => sb.fetchMetrics({ accessToken: 'sbx-at-perf', scopes: [] }, `ext_${i}`));

// Media upload (memory storage, 5MB jpeg-like)
const buf = new Uint8Array(5 * 1024 * 1024);
buf.set([0xff, 0xd8, 0xff, 0xe0]);
await measure('media.upload 5MB (validate+hash+store)', 20, () => uploadMedia(ctx, { data: buf, declaredMime: 'image/jpeg', filename: 'x.jpg' }));

writeFileSync('perf-results.json', JSON.stringify(results, null, 2));
console.log('DB size MB', results.dbSizeMB);
app.db.close();
if (process.env.PERF_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
