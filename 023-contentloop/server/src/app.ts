import { DB } from './db/db.js';
import { AIGateway } from './ai/gateway.js';
import { TranscriptionRegistry } from './ai/transcription.js';
import { ConnectorRegistry } from './connectors/registry.js';
import { LocalDiskStorage, MemoryStorage, type Storage } from './lib/storage.js';
import { systemClock, type Clock } from './lib/util.js';
import type { App } from './domain/context.js';

export function createApp(opts: { dbPath?: string; clock?: Clock; storage?: Storage; storageDir?: string; sandboxConnectors?: boolean } = {}): App {
  const db = new DB(opts.dbPath ?? ':memory:');
  const clock = opts.clock ?? systemClock;
  return {
    db,
    clock,
    ai: new AIGateway(db, clock),
    connectors: new ConnectorRegistry({ sandbox: opts.sandboxConnectors !== false }),
    storage: opts.storage ?? (opts.storageDir ? new LocalDiskStorage(opts.storageDir) : new MemoryStorage()),
    transcription: new TranscriptionRegistry(),
  };
}
