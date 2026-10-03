import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';

export const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export class AppError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: unknown) {
    super(message ?? code);
  }
}
export const notFound = (what = 'resource') => new AppError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'forbidden') => new AppError(403, 'forbidden', msg);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details);
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'conflict', msg, details);

// ---- Clock (injectable for tests) ----
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
export class FixedClock implements Clock {
  constructor(private t: Date) {}
  now() {
    return new Date(this.t);
  }
  set(t: Date | string) {
    this.t = new Date(t);
  }
  advanceDays(d: number) {
    this.t = new Date(this.t.getTime() + d * 86400_000);
  }
  advanceMs(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}
/** Real time + adjustable offset (E2E only; enabled via CONTENTLOOP_TEST_MODE). */
export class OffsetClock implements Clock {
  offsetMs = 0;
  now() {
    return new Date(Date.now() + this.offsetMs);
  }
}
export const daysBetween = (a: Date | string, b: Date | string) =>
  Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400_000);

// ---- Password hashing (scrypt) ----
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const got = scryptSync(pw, Buffer.from(s, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const exp = Buffer.from(h, 'base64');
  return got.length === exp.length && timingSafeEqual(got, exp);
}

// ---- Secret encryption for OAuth tokens (AES-256-GCM, key from env) ----
function secretKey(): Buffer {
  const k = process.env.CONTENTLOOP_SECRET_KEY;
  if (!k) {
    if (process.env.NODE_ENV === 'production') throw new Error('CONTENTLOOP_SECRET_KEY is required in production');
    return createHash('sha256').update('contentloop-dev-only-key').digest();
  }
  return createHash('sha256').update(k).digest();
}
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}
export function decryptSecret(blob: string): string {
  const [v, iv, tag, enc] = blob.split('.');
  if (v !== 'v1') throw new Error('bad secret format');
  const d = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}
export function hmac(data: string): string {
  return createHmac('sha256', secretKey()).update(data).digest('base64url');
}

// ---- Timezone helpers (Intl-based, no deps) ----
/** Convert a wall-clock local time ("2026-10-05T09:00") in tz to a UTC ISO string. */
export function zonedToUtc(local: string, tz: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) throw badRequest('local datetime must be YYYY-MM-DDTHH:mm');
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  const guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  // iterate twice to settle DST offsets
  let ts = guess;
  for (let i = 0; i < 2; i++) ts = guess - tzOffsetMs(ts, tz);
  return new Date(ts).toISOString();
}
const tzFormatters = new Map<string, Intl.DateTimeFormat>();
export function tzOffsetMs(utcMs: number, tz: string): number {
  let f = tzFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    tzFormatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}
export function utcToZoned(iso: string, tz: string): string {
  const ms = new Date(iso).getTime();
  return new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 16);
}
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
