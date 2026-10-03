import { trigrams, keywords, cosine, jaccard, fnv1a, hashVector, vecCosine } from '../lib/text.js';

/**
 * Idea Fingerprint v1: compact lexical signature (top trigrams + keywords).
 * Similarity is a *candidate signal*, never a duplicate verdict.
 */
export interface Fingerprint {
  v: 1;
  tri: Record<string, number>; // hashed trigram -> count (top 160)
  kw: string[];
}

export type SimilarityLevel = 'new' | 'related' | 'similar' | 'very_similar';
export const LEVEL_LABEL: Record<SimilarityLevel | 'recently_used', string> = {
  new: 'New', related: 'Related', similar: 'Similar', very_similar: 'Very Similar', recently_used: 'Recently Used',
};

export const THRESHOLDS = { related: 0.22, similar: 0.4, very_similar: 0.58 };

export function makeFingerprint(text: string): Fingerprint {
  const tg = trigrams(text);
  const top = [...tg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 160);
  const tri: Record<string, number> = {};
  for (const [g, c] of top) {
    const h = fnv1a(g).toString(36);
    tri[h] = (tri[h] ?? 0) + c;
  }
  return { v: 1, tri, kw: [...new Set(keywords(text).map((k) => k.toLowerCase()))].slice(0, 40) };
}

export function fingerprintSimilarity(a: Fingerprint, b: Fingerprint): number {
  const ta = new Map(Object.entries(a.tri));
  const tb = new Map(Object.entries(b.tri));
  const c = cosine(ta, tb);
  const k = jaccard(new Set(a.kw), new Set(b.kw));
  return Math.round((0.6 * c + 0.4 * Math.sqrt(k)) * 1000) / 1000;
}

export function levelOf(score: number): SimilarityLevel {
  if (score >= THRESHOLDS.very_similar) return 'very_similar';
  if (score >= THRESHOLDS.similar) return 'similar';
  if (score >= THRESHOLDS.related) return 'related';
  return 'new';
}

export interface IdeaRecord {
  id: string;
  coreIdea: string;
  angle?: string | null;
  topic?: string | null;
  fingerprint: Fingerprint;
  lastUsedAt?: string | null;
  lastPlatform?: string | null;
  status?: string;
  vector?: number[] | null;
}
export interface SimilarityCandidate {
  ideaId: string;
  coreIdea: string;
  score: number;
  lexicalScore: number;
  semanticScore: number | null;
  level: SimilarityLevel;
  recentlyUsed: boolean;
  daysSinceUse: number | null;
  lastPlatform: string | null;
  message: string;
}

const PLATFORM_JA: Record<string, string> = {
  threads: 'Threads', x: 'X', linkedin: 'LinkedIn', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok',
  youtube_shorts: 'YouTube Shorts', youtube_community: 'YouTube Community', blog: 'ブログ', newsletter: 'ニュースレター', generic: '汎用',
};
const LEVEL_JA: Record<SimilarityLevel, string> = { new: '異なります', related: '関連しています', similar: '似ています', very_similar: '非常に近いです' };

export function compare(
  text: string,
  pool: IdeaRecord[],
  opts: { now: Date; recentlyUsedDays: number; excludeIds?: string[]; vector?: number[] | null; limit?: number; platformOf?: (ideaId: string) => string | null },
): SimilarityCandidate[] {
  const fp = makeFingerprint(text);
  const vec = opts.vector ?? null;
  const scored: { idea: IdeaRecord; lex: number; sem: number | null; score: number; level: SimilarityLevel }[] = [];
  for (const idea of pool) {
    if (opts.excludeIds?.includes(idea.id)) continue;
    const lex = fingerprintSimilarity(fp, idea.fingerprint);
    const sem = vec && idea.vector ? Math.round(vecCosine(vec, idea.vector) * 1000) / 1000 : null;
    // semantic (optional) can raise but not dominate: max of lexical and 0.9*semantic
    const score = sem != null ? Math.max(lex, sem * 0.9) : lex;
    const level = levelOf(score);
    if (level === 'new') continue;
    scored.push({ idea, lex, sem, score, level });
  }
  scored.sort((a, b) => b.score - a.score);
  const out: SimilarityCandidate[] = [];
  for (const { idea, lex, sem, score, level } of scored.slice(0, opts.limit ?? 5)) {
    if (idea.lastUsedAt && idea.lastPlatform == null && opts.platformOf) idea.lastPlatform = opts.platformOf(idea.id);
    const days = idea.lastUsedAt ? Math.floor((opts.now.getTime() - new Date(idea.lastUsedAt).getTime()) / 86400_000) : null;
    const recentlyUsed = days != null && days <= opts.recentlyUsedDays && (level === 'similar' || level === 'very_similar');
    const where = idea.lastPlatform ? `${PLATFORM_JA[idea.lastPlatform] ?? idea.lastPlatform}で` : '';
    const message =
      days != null
        ? `この内容は${days}日前に${where}使用したIdeaと${LEVEL_JA[level]}。`
        : `この内容は未使用のIdea「${idea.coreIdea.slice(0, 30)}」と${LEVEL_JA[level]}。`;
    out.push({ ideaId: idea.id, coreIdea: idea.coreIdea, score, lexicalScore: lex, semanticScore: sem, level, recentlyUsed, daysSinceUse: days, lastPlatform: idea.lastPlatform ?? null, message });
  }
  return out;
}

/** Options the user can choose when a similarity warning appears. Nothing is deleted automatically. */
export const SIMILARITY_CHOICES = [
  { id: 'keep', label: 'そのまま使う' },
  { id: 'new_angle', label: '別角度にする' },
  { id: 'add_update', label: '最新情報を追加' },
  { id: 'other_platform', label: '別Platformで使う' },
  { id: 'skip', label: '使わない' },
] as const;

export const localVector = (text: string) => hashVector(text);
