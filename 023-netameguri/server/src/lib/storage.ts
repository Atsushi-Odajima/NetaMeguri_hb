import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hmac } from './util.js';
import { timingSafeEqual } from 'node:crypto';

/**
 * Object storage abstraction. LocalDiskStorage is for dev/self-host; an S3/R2 implementation can satisfy
 * the same interface (put/get/delete/signedUrl). Keys are generated server-side, never from user filenames.
 */
export interface Storage {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, ttlSec: number, now: Date): string;
  verify(key: string, exp: number, sig: string, now: Date): boolean;
}

export class LocalDiskStorage implements Storage {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }
  private path(key: string) {
    if (!/^[a-zA-Z0-9_/-]+$/.test(key) || key.includes('..')) throw new Error('bad storage key');
    const p = resolve(join(this.root, key));
    if (!p.startsWith(resolve(this.root))) throw new Error('bad storage key');
    return p;
  }
  async put(key: string, data: Uint8Array) {
    const p = this.path(key);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, data);
  }
  async get(key: string) {
    const p = this.path(key);
    return existsSync(p) ? readFileSync(p) : null;
  }
  async delete(key: string) {
    rmSync(this.path(key), { force: true });
  }
  signedUrl(key: string, ttlSec: number, now: Date) {
    const exp = Math.floor(now.getTime() / 1000) + ttlSec;
    return `/media/${key}?exp=${exp}&sig=${hmac(`${key}:${exp}`)}`;
  }
  verify(key: string, exp: number, sig: string, now: Date) {
    if (!Number.isFinite(exp) || exp < now.getTime() / 1000) return false;
    const a = Buffer.from(hmac(`${key}:${exp}`));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export class MemoryStorage implements Storage {
  files = new Map<string, Buffer>();
  async put(k: string, d: Uint8Array) {
    this.files.set(k, Buffer.from(d));
  }
  async get(k: string) {
    return this.files.get(k) ?? null;
  }
  async delete(k: string) {
    this.files.delete(k);
  }
  signedUrl(key: string, ttlSec: number, now: Date) {
    const exp = Math.floor(now.getTime() / 1000) + ttlSec;
    return `/media/${key}?exp=${exp}&sig=${hmac(`${key}:${exp}`)}`;
  }
  verify(key: string, exp: number, sig: string, now: Date) {
    return exp >= now.getTime() / 1000 && hmac(`${key}:${exp}`) === sig;
  }
}
