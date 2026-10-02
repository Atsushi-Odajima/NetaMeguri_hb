import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from './util.js';
import { stripHtml } from './text.js';

/** Returns true for loopback, private, link-local, CGNAT, metadata, multicast and reserved ranges. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    if (x.startsWith('fc') || x.startsWith('fd')) return true; // ULA
    if (/^fe[89ab]/.test(x)) return true; // link-local
    if (x.startsWith('ff')) return true; // multicast
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isBlockedIp(mapped[1]);
    if (x.startsWith('fd00:ec2')) return true;
    return false;
  }
  return true;
}

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/** Validate a URL for server-side fetching. Throws AppError(400) on violation. */
export async function assertSafeUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError(400, 'invalid_url', 'URLの形式が正しくありません');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AppError(400, 'ssrf_blocked', 'http/https以外は取得できません');
  if (u.username || u.password) throw new AppError(400, 'ssrf_blocked', '認証情報付きURLは取得できません');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new AppError(400, 'ssrf_blocked', 'このポートは取得できません');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new AppError(400, 'ssrf_blocked', '内部ホストは取得できません');
  }
  const addrs = isIP(host) ? [host] : await resolve(host).catch(() => {
    throw new AppError(400, 'dns_failed', 'ホスト名を解決できません');
  });
  if (!addrs.length || addrs.some(isBlockedIp)) throw new AppError(400, 'ssrf_blocked', 'プライベート/内部アドレスへの接続は禁止されています');
  return u;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  contentType: string;
}

/**
 * Fetch one page (no crawling). Redirects are followed manually (max 3) and every hop is re-validated.
 * Size/time limited. Body is treated as untrusted data.
 */
export async function safeFetchPage(raw: string, opts: { resolve?: Resolver; fetchImpl?: typeof fetch; maxBytes?: number } = {}): Promise<FetchedPage> {
  const f = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertSafeUrl(current, opts.resolve);
    const res = await f(u.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'ContentLoop/0.1 (+single-page import; no crawling)', accept: 'text/html,text/plain' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new AppError(400, 'fetch_failed', 'redirect without location');
      current = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) throw new AppError(400, 'fetch_failed', `取得に失敗しました (HTTP ${res.status})`);
    const ct = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/xhtml/.test(ct)) throw new AppError(400, 'unsupported_type', 'HTML/テキスト以外は取得できません');
    const buf = await readLimited(res, maxBytes);
    const html = buf.toString('utf8');
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? u.hostname;
    const text = ct.includes('text/plain') ? html : stripHtml(html);
    return { url: u.toString(), title: stripHtml(title).slice(0, 200), text: text.slice(0, 200_000), contentType: ct };
  }
  throw new AppError(400, 'too_many_redirects', 'リダイレクトが多すぎます');
}

async function readLimited(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new AppError(400, 'too_large', 'ページが大きすぎます');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
