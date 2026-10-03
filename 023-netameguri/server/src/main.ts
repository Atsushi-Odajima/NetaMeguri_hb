import { resolve } from 'node:path';
import { createApp } from './app.js';
import { buildServer } from './api/server.js';
import { runDueJobs, connectorHealth } from './domain/publish.js';
import { systemCtx } from './domain/workspace.js';
import { seedSample } from './seed/sample.js';
import { OffsetClock } from './lib/util.js';

const prod = process.env.NODE_ENV === 'production';
if (prod && (process.env.NETAMEGURI_SECRET_KEY ?? '').length < 32) {
  console.error('NETAMEGURI_SECRET_KEY (32+ chars) is required in production');
  process.exit(1);
}
const dataDir = resolve(process.env.NETAMEGURI_DATA_DIR ?? './data');
const testMode = !prod && process.env.NETAMEGURI_TEST_MODE === '1';
const app = createApp({ dbPath: `${dataDir}/netameguri.db`, storageDir: `${dataDir}/objects`, sandboxConnectors: process.env.NETAMEGURI_SANDBOX !== '0', ...(testMode ? { clock: new OffsetClock() } : {}) });

const allowSample = !prod || process.env.NETAMEGURI_ALLOW_SAMPLE === '1';
const server = await buildServer(app, { webDist: resolve('dist/web'), secureCookies: prod, allowSample, logger: process.env.NETAMEGURI_LOG !== '0', testMode });

// Demo user (dev only): demo@sample-build-lab.invalid / demo-password-123
if (allowSample && process.env.NETAMEGURI_SEED_DEMO !== '0' && !app.db.get('SELECT 1 FROM users LIMIT 1')) {
  const s = await seedSample(app);
  server.log.info({ workspaceId: s.workspaceId }, 'sample workspace seeded (demo@sample-build-lab.invalid / demo-password-123)');
}

// Background jobs: scheduler + connector health. Single-process; see OPERATIONS.md for multi-instance notes.
setInterval(() => {
  runDueJobs(app).catch((e) => server.log.error({ err: e.message }, 'job runner failed'));
}, 30_000).unref();
setInterval(() => {
  for (const w of app.db.all('SELECT id FROM workspaces')) connectorHealth(systemCtx(app, w.id));
}, 3600_000).unref();

const port = Number(process.env.PORT ?? 8787);
await server.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
