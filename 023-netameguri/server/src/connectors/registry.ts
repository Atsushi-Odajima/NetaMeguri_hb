import type { PlatformId } from '../domain/platforms.js';
import { PLATFORM_IDS } from '../domain/platforms.js';
import { sha256, token } from '../lib/util.js';

export type Capability = 'READ' | 'ANALYTICS_READ' | 'DRAFT_EXPORT' | 'SCHEDULE' | 'PUBLISH' | 'DELETE' | 'UNAVAILABLE';
export type DocStatus = 'docs' | 'conditional' | 'unverified' | 'no';

/**
 * What the platform's OFFICIAL docs say (from SOURCE_NOTES.md, checked 2026-10-02).
 * This is informational. It is NOT what NetaMeguri can do; see adapter.capabilities for that.
 */
export interface PlatformApiFacts {
  platform: PlatformId;
  documented: Partial<Record<Exclude<Capability, 'UNAVAILABLE'>, DocStatus>>;
  conditions: string;
  scopes: { publish: string[]; analytics: string[] };
  rateLimit: string;
  openUrl: string;
}

export const API_FACTS: Record<PlatformId, PlatformApiFacts> = {
  threads: { platform: 'threads', documented: { READ: 'docs', ANALYTICS_READ: 'docs', PUBLISH: 'conditional', DELETE: 'docs', SCHEDULE: 'unverified' }, conditions: 'Meta App Review必須。250投稿/24h。', scopes: { publish: ['threads_basic', 'threads_content_publish'], analytics: ['threads_basic', 'threads_manage_insights'] }, rateLimit: '250 posts / 24h (docs)', openUrl: 'https://www.threads.net/' },
  x: { platform: 'x', documented: { READ: 'docs', ANALYTICS_READ: 'docs', PUBLISH: 'conditional', SCHEDULE: 'no', DELETE: 'unverified' }, conditions: '従量課金（投稿ごと課金, URL付きは高額）。v2にnative予約なし。', scopes: { publish: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'], analytics: ['tweet.read', 'users.read'] }, rateLimit: 'tier/pay-per-use dependent', openUrl: 'https://x.com/compose/post' },
  linkedin: { platform: 'linkedin', documented: { READ: 'conditional', ANALYTICS_READ: 'conditional', PUBLISH: 'conditional', DELETE: 'docs', SCHEDULE: 'unverified' }, conditions: '会員投稿はw_member_social。組織はCommunity Management API承認が必要。', scopes: { publish: ['w_member_social'], analytics: ['r_member_postAnalytics'] }, rateLimit: 'Development tier 500 calls/app/day (docs)', openUrl: 'https://www.linkedin.com/feed/' },
  instagram: { platform: 'instagram', documented: { READ: 'docs', ANALYTICS_READ: 'docs', PUBLISH: 'conditional', SCHEDULE: 'unverified', DELETE: 'unverified' }, conditions: 'Business/Creatorアカウント + App Review。投稿上限/24hはdocs間で記載差あり(要確認)。', scopes: { publish: ['instagram_business_basic', 'instagram_business_content_publish'], analytics: ['instagram_business_manage_insights'] }, rateLimit: '100 (or 50) posts / 24h — 要確認', openUrl: 'https://www.instagram.com/' },
  facebook: { platform: 'facebook', documented: { READ: 'docs', ANALYTICS_READ: 'docs', PUBLISH: 'conditional', SCHEDULE: 'docs', DELETE: 'unverified' }, conditions: 'Page token・権限審査。Insights metricは置換中。', scopes: { publish: ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'], analytics: ['read_insights', 'pages_read_engagement'] }, rateLimit: 'Graph API rate limiting (docs)', openUrl: 'https://www.facebook.com/' },
  tiktok: { platform: 'tiktok', documented: { READ: 'conditional', ANALYTICS_READ: 'conditional', DRAFT_EXPORT: 'docs', PUBLISH: 'conditional', SCHEDULE: 'unverified', DELETE: 'unverified' }, conditions: 'audit前はSELF_ONLY・5ユーザー/24h。初期はvideo.uploadで下書き送付が現実的。', scopes: { publish: ['video.upload'], analytics: ['video.list', 'user.info.stats'] }, rateLimit: 'per-endpoint (docs)', openUrl: 'https://www.tiktok.com/upload' },
  youtube_shorts: { platform: 'youtube_shorts', documented: { READ: 'docs', ANALYTICS_READ: 'docs', PUBLISH: 'conditional', SCHEDULE: 'docs', DELETE: 'unverified' }, conditions: '未監査プロジェクトはprivate限定。quota制。', scopes: { publish: ['https://www.googleapis.com/auth/youtube.upload'], analytics: ['https://www.googleapis.com/auth/yt-analytics.readonly'] }, rateLimit: 'quota units/day (docs)', openUrl: 'https://studio.youtube.com/' },
  youtube_community: { platform: 'youtube_community', documented: { PUBLISH: 'no', SCHEDULE: 'no', READ: 'no' }, conditions: 'コミュニティ投稿の公開APIなし（bulletin廃止）。手動投稿のみ。', scopes: { publish: [], analytics: [] }, rateLimit: '-', openUrl: 'https://studio.youtube.com/' },
  blog: { platform: 'blog', documented: { READ: 'docs', DRAFT_EXPORT: 'docs', SCHEDULE: 'docs', PUBLISH: 'docs', DELETE: 'docs', ANALYTICS_READ: 'unverified' }, conditions: 'WordPress REST API + Application Passwords。コアにanalyticsなし。', scopes: { publish: ['(WordPress user role: author+)'], analytics: [] }, rateLimit: 'host dependent', openUrl: 'about:blank' },
  newsletter: { platform: 'newsletter', documented: { READ: 'docs', DRAFT_EXPORT: 'docs', SCHEDULE: 'docs', PUBLISH: 'docs', ANALYTICS_READ: 'conditional' }, conditions: '例: Buttondown API key。', scopes: { publish: ['(API key)'], analytics: [] }, rateLimit: 'provider dependent', openUrl: 'about:blank' },
  generic: { platform: 'generic', documented: {}, conditions: '汎用テキスト。手動投稿。', scopes: { publish: [], analytics: [] }, rateLimit: '-', openUrl: 'about:blank' },
};

export interface PublishPayload { title: string | null; body: string; idempotencyKey: string; scheduledAt?: string }
export interface PublishResult { externalId: string; url?: string }
export interface Tokens { accessToken: string; refreshToken?: string; expiresAt?: string; scopes: string[] }

export class ConnectorError extends Error {
  constructor(public kind: 'rate_limited' | 'auth' | 'ambiguous' | 'rejected' | 'not_supported', message: string, public retryAfterSec?: number) {
    super(message);
  }
}

export interface ConnectorAdapter {
  readonly id: string;
  readonly platform: PlatformId;
  readonly label: string;
  /** Capabilities NetaMeguri actually implements for this adapter. */
  readonly capabilities: Capability[];
  /** true only if verified against the real platform API. */
  readonly verifiedAgainstRealApi: boolean;
  readonly simulated: boolean;
  publish?(tokens: Tokens, p: PublishPayload): Promise<PublishResult>;
  /** Look up whether a post with this idempotency key already exists remotely (duplicate-post prevention). */
  findByIdempotency?(tokens: Tokens, key: string): Promise<PublishResult | null>;
  fetchMetrics?(tokens: Tokens, externalId: string): Promise<Record<string, number>>;
  delete?(tokens: Tokens, externalId: string): Promise<void>;
  revoke?(tokens: Tokens): Promise<void>;
  /** OAuth: build authorize URL (state + PKCE). Sandbox returns an internal URL. */
  authorizeUrl?(state: string, codeChallenge: string, redirectUri: string): string;
  exchangeCode?(code: string, codeVerifier: string, redirectUri: string): Promise<Tokens>;
}

/** Manual handoff: copy text / download media / open platform / mark published. */
export class ManualAdapter implements ConnectorAdapter {
  readonly capabilities: Capability[] = ['DRAFT_EXPORT'];
  readonly verifiedAgainstRealApi = false;
  readonly simulated = false;
  readonly id: string;
  readonly label: string;
  constructor(readonly platform: PlatformId) {
    this.id = `manual:${platform}`;
    this.label = '手動投稿 (Copy / Open / Mark Published)';
  }
}

/**
 * Sandbox adapter: an in-process simulated platform used for demo & tests.
 * Never contacts a real SNS. Supports failure injection (auth expiry, 429, ambiguous network error).
 */
export class SandboxAdapter implements ConnectorAdapter {
  readonly verifiedAgainstRealApi = false;
  readonly simulated = true;
  readonly id: string;
  readonly label: string;
  remote = new Map<string, { externalId: string; body: string; key: string; createdAt: string }>();
  revokedTokens = new Set<string>();
  failNext: null | 'rate_limited' | 'auth' | 'ambiguous_after_post' | 'rejected' = null;
  publishCalls = 0;
  constructor(readonly platform: PlatformId, readonly capabilities: Capability[] = ['READ', 'ANALYTICS_READ', 'SCHEDULE', 'PUBLISH', 'DELETE']) {
    this.id = `sandbox:${platform}`;
    this.label = `Sandbox ${platform}（シミュレーション・実SNS未接続）`;
  }
  private check(t: Tokens) {
    if (this.revokedTokens.has(t.accessToken)) throw new ConnectorError('auth', 'token revoked');
    if (t.expiresAt && new Date(t.expiresAt) < new Date()) throw new ConnectorError('auth', 'token expired');
  }
  async publish(t: Tokens, p: PublishPayload): Promise<PublishResult> {
    this.check(t);
    this.publishCalls++;
    const f = this.failNext;
    this.failNext = null;
    if (f === 'auth') throw new ConnectorError('auth', 'token expired');
    if (f === 'rate_limited') throw new ConnectorError('rate_limited', '429', 60);
    if (f === 'rejected') throw new ConnectorError('rejected', 'content rejected by platform');
    const externalId = `sbx_${sha256(p.idempotencyKey).slice(0, 12)}_${this.remote.size + 1}`;
    this.remote.set(externalId, { externalId, body: p.body, key: p.idempotencyKey, createdAt: new Date().toISOString() });
    if (f === 'ambiguous_after_post') throw new ConnectorError('ambiguous', 'network timeout after request sent');
    return { externalId, url: `https://sandbox.invalid/${this.platform}/${externalId}` };
  }
  async findByIdempotency(t: Tokens, key: string) {
    this.check(t);
    for (const r of this.remote.values()) if (r.key === key) return { externalId: r.externalId, url: `https://sandbox.invalid/${this.platform}/${r.externalId}` };
    return null;
  }
  async fetchMetrics(t: Tokens, externalId: string) {
    this.check(t);
    const n = parseInt(sha256(externalId).slice(0, 6), 16);
    return { impressions: 500 + (n % 5000), likes: 10 + (n % 300), comments: n % 40, shares: n % 25, clicks: n % 60 };
  }
  async delete(t: Tokens, externalId: string) {
    this.check(t);
    this.remote.delete(externalId);
  }
  async revoke(t: Tokens) {
    this.revokedTokens.add(t.accessToken);
  }
  authorizeUrl(state: string, challenge: string, redirect: string) {
    return `/api/connectors/sandbox/authorize?state=${encodeURIComponent(state)}&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirect)}`;
  }
  async exchangeCode(code: string): Promise<Tokens> {
    if (!code.startsWith('sbx-code-')) throw new ConnectorError('auth', 'invalid code');
    return { accessToken: 'sbx-at-' + token(12), refreshToken: 'sbx-rt-' + token(12), expiresAt: new Date(Date.now() + 3600_000 * 24 * 60).toISOString(), scopes: ['publish', 'analytics'] };
  }
}

/**
 * WordPress REST adapter (Application Password). Implemented per official docs but NOT verified against a real site
 * in this repository (no real accounts are connected without human approval).
 */
export class WordPressAdapter implements ConnectorAdapter {
  readonly id = 'wordpress';
  readonly platform: PlatformId = 'blog';
  readonly label = 'WordPress REST API (Application Password)';
  readonly capabilities: Capability[] = ['READ', 'DRAFT_EXPORT', 'SCHEDULE', 'PUBLISH', 'DELETE'];
  readonly verifiedAgainstRealApi = false;
  readonly simulated = false;
  constructor(private fetchImpl: typeof fetch = fetch) {}
  // accessToken format: "<siteUrl>|<user>:<appPassword>" stored encrypted server-side.
  private parse(t: Tokens) {
    const [site, cred] = t.accessToken.split('|');
    return { site: site.replace(/\/$/, ''), auth: 'Basic ' + Buffer.from(cred).toString('base64') };
  }
  async publish(t: Tokens, p: PublishPayload): Promise<PublishResult> {
    const { site, auth } = this.parse(t);
    const res = await this.fetchImpl(`${site}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: p.title ?? '', content: p.body, status: p.scheduledAt ? 'future' : 'publish', date_gmt: p.scheduledAt, meta: { netameguri_idempotency: p.idempotencyKey } }),
    });
    if (res.status === 401 || res.status === 403) throw new ConnectorError('auth', `wordpress ${res.status}`);
    if (res.status === 429) throw new ConnectorError('rate_limited', '429', Number(res.headers.get('retry-after') ?? 60));
    if (!res.ok) throw new ConnectorError('rejected', `wordpress ${res.status}`);
    const j: any = await res.json();
    return { externalId: String(j.id), url: j.link };
  }
}

export class ConnectorRegistry {
  adapters = new Map<string, ConnectorAdapter>();
  constructor(opts: { sandbox?: boolean } = {}) {
    for (const p of PLATFORM_IDS) this.register(new ManualAdapter(p));
    this.register(new WordPressAdapter());
    if (opts.sandbox !== false) for (const p of ['threads', 'x', 'linkedin', 'instagram'] as PlatformId[]) this.register(new SandboxAdapter(p));
  }
  register(a: ConnectorAdapter) {
    this.adapters.set(a.id, a);
  }
  get(id: string) {
    return this.adapters.get(id);
  }
  forPlatform(p: PlatformId) {
    return [...this.adapters.values()].filter((a) => a.platform === p);
  }
}

/** Effective capabilities = adapter implements it AND the connection is healthy. Manual handoff always available. */
export function effectiveCapabilities(adapter: ConnectorAdapter | undefined, status: string | undefined): Capability[] {
  if (!adapter) return ['DRAFT_EXPORT'];
  if (adapter.id.startsWith('manual:')) return ['DRAFT_EXPORT'];
  if (status !== 'connected') return ['DRAFT_EXPORT'];
  return [...new Set<Capability>(['DRAFT_EXPORT', ...adapter.capabilities])];
}

// ---- simple per-connector token bucket ----
const buckets = new Map<string, { tokens: number; updated: number }>();
export function takeRateToken(key: string, perMinute: number, now = Date.now()): boolean {
  const b = buckets.get(key) ?? { tokens: perMinute, updated: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.updated) / 60000) * perMinute);
  b.updated = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}
