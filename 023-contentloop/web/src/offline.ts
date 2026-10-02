// Offline queue for the PWA. Only safe operations are queued (Quick Capture, Draft edits).
// Publishing/scheduling is never queued offline. Items keep a clientId so replays are idempotent,
// and draft edits carry expectedVersion so the server can reject stale writes (conflict → user review).

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}
export class MemoryKV implements KV {
  private m = new Map<string, string>();
  get(k: string) {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string) {
    this.m.set(k, v);
  }
}
export class LocalStorageKV implements KV {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable (private mode) — queue is lost on reload; UI warns */
    }
  }
}

export type QueueKind = 'capture' | 'draft';
export interface QueueItem {
  clientId: string;
  kind: QueueKind;
  workspaceId?: string;
  contentId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  conflict?: boolean;
  error?: string;
}

const KEY = 'contentloop.offlineQueue.v1';
const ALLOWED: QueueKind[] = ['capture', 'draft'];

function rid() {
  const c = (globalThis as any).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class OfflineQueue {
  constructor(private kv: KV) {}
  private read(): QueueItem[] {
    try {
      return JSON.parse(this.kv.get(KEY) ?? '[]');
    } catch {
      return [];
    }
  }
  private write(items: QueueItem[]) {
    this.kv.set(KEY, JSON.stringify(items));
  }
  enqueue(item: { kind: QueueKind; workspaceId?: string; contentId?: string; payload: Record<string, unknown> }): QueueItem {
    if (!ALLOWED.includes(item.kind)) throw new Error(`"${item.kind}" cannot be queued offline`);
    const items = this.read();
    // a newer offline edit of the same draft replaces the older queued one (keeps original expectedVersion)
    if (item.kind === 'draft' && item.contentId) {
      const prev = items.find((x) => x.kind === 'draft' && x.contentId === item.contentId && !x.conflict);
      if (prev) {
        prev.payload = { ...item.payload, expectedVersion: prev.payload.expectedVersion ?? item.payload.expectedVersion };
        this.write(items);
        return prev;
      }
    }
    const q: QueueItem = { clientId: rid(), createdAt: new Date().toISOString(), attempts: 0, ...item };
    items.push(q);
    this.write(items);
    return q;
  }
  pending(): QueueItem[] {
    return this.read();
  }
  remove(clientId: string) {
    this.write(this.read().filter((x) => x.clientId !== clientId));
  }
  /** Send queued items. Successful ones are removed; conflicts are kept and flagged for the user. */
  async flush(send: (item: QueueItem) => Promise<{ ok: boolean; conflict?: boolean; error?: string }>) {
    let synced = 0;
    let conflicts = 0;
    let failed = 0;
    for (const item of this.read()) {
      if (item.conflict) continue;
      let r: { ok: boolean; conflict?: boolean; error?: string };
      try {
        r = await send(item);
      } catch (e) {
        r = { ok: false, error: (e as Error).message };
      }
      const items = this.read();
      const cur = items.find((x) => x.clientId === item.clientId);
      if (!cur) continue;
      if (r.ok) {
        this.write(items.filter((x) => x.clientId !== item.clientId));
        synced++;
      } else {
        cur.attempts++;
        if (r.conflict) {
          cur.conflict = true;
          conflicts++;
        } else failed++;
        cur.error = r.error;
        this.write(items);
      }
    }
    return { synced, conflicts, failed };
  }
}
