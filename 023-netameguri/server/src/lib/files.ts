import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { badRequest } from './util.js';

// ---------- CSV ----------
/** Neutralise spreadsheet formula injection (OWASP): prefix dangerous leading chars with a single quote. */
export function csvSafeCell(v: unknown): string {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return '﻿' + [cols.map(csvSafeCell).join(','), ...rows.map((r) => cols.map((c) => csvSafeCell(r[c])).join(','))].join('\r\n');
}
/** RFC4180-ish CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((x) => x.trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// ---------- ZIP ----------
/** Reject absolute paths, drive letters, backslashes and any ".." segment (Zip Slip). */
export function safeZipPath(p: string): string {
  const n = p.replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.includes('\0')) throw badRequest(`unsafe zip path: ${p}`);
  const parts = n.split('/');
  if (parts.some((x) => x === '..')) throw badRequest(`unsafe zip path: ${p}`);
  return parts.filter((x) => x && x !== '.').join('/');
}
export function makeZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(files)) entries[safeZipPath(path)] = typeof data === 'string' ? strToU8(data) : data;
  return zipSync(entries, { level: 6 });
}
export function readZip(buf: Uint8Array, opts: { maxEntries?: number; maxTotalBytes?: number } = {}): Record<string, string> {
  const maxEntries = opts.maxEntries ?? 2000;
  const maxTotal = opts.maxTotalBytes ?? 200_000_000;
  let total = 0;
  let count = 0;
  const out: Record<string, string> = {};
  const raw = unzipSync(buf, {
    filter: (f) => {
      safeZipPath(f.name); // throws on traversal before extraction
      count++;
      total += f.originalSize;
      if (count > maxEntries || total > maxTotal) throw badRequest('zip too large (possible zip bomb)');
      return true;
    },
  });
  for (const [name, data] of Object.entries(raw)) {
    if (name.endsWith('/')) continue;
    out[safeZipPath(name)] = strFromU8(data);
  }
  return out;
}

// ---------- Upload validation ----------
const MAGIC: { mime: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { mime: 'image/webp', test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 },
  { mime: 'application/pdf', test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { mime: 'video/mp4', test: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
  { mime: 'audio/mpeg', test: (b) => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { mime: 'audio/wav', test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x41 },
  { mime: 'video/webm', test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
];
export const UPLOAD_LIMITS: Record<string, number> = {
  image: 15 * 1024 * 1024,
  document: 30 * 1024 * 1024,
  audio: 300 * 1024 * 1024,
  video: 2 * 1024 * 1024 * 1024,
  text: 5 * 1024 * 1024,
};
const ALLOWED_TEXT = new Set(['text/plain', 'text/markdown', 'text/vtt', 'application/x-subrip', 'text/csv']);

export function sniffMime(buf: Uint8Array, declared: string): { mime: string; kind: keyof typeof UPLOAD_LIMITS } {
  const hit = MAGIC.find((m) => m.test(buf));
  if (hit) {
    const kind = hit.mime.startsWith('image/') ? 'image' : hit.mime.startsWith('video/') ? 'video' : hit.mime.startsWith('audio/') ? 'audio' : 'document';
    return { mime: hit.mime, kind };
  }
  // Text-like: must decode as UTF-8 without NUL bytes and be declared as an allowed text type.
  if (ALLOWED_TEXT.has(declared) && !buf.subarray(0, 4096).includes(0)) return { mime: declared, kind: 'text' };
  throw badRequest('サポートされていないファイル形式です');
}
export function validateUpload(buf: Uint8Array, declared: string) {
  const r = sniffMime(buf, declared);
  if (buf.byteLength > UPLOAD_LIMITS[r.kind]) throw badRequest(`ファイルサイズ上限を超えています (${r.kind})`);
  return r;
}
