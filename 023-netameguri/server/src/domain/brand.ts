import { z } from 'zod';
import { j } from '../db/db.js';
import { id, badRequest } from '../lib/util.js';
import { audit, getScoped, nowIso, requirePerm, type Ctx } from './context.js';
import { draftBrandVoice, type BrandLite } from '../ai/local.js';
import type { BrandForGuard } from './guards.js';

export const BrandInput = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  audience: z.string().max(1000).optional(),
  positioning: z.string().max(1000).optional(),
  voiceSummary: z.string().max(2000).optional(),
  tone: z.string().max(200).optional(),
  language: z.string().max(10).default('ja'),
  preferredTerms: z.array(z.string().max(60)).max(200).default([]),
  bannedTerms: z.array(z.string().max(60)).max(500).default([]),
  ctaStyle: z.string().max(300).optional(),
  bannedCtas: z.array(z.string().max(100)).max(100).default([]),
  emojiPolicy: z.enum(['none', 'few', 'free']).default('few'),
  maxEmoji: z.number().int().min(0).max(30).default(2),
  sentenceStyle: z.string().max(300).optional(),
  hashtagsPolicy: z.enum(['none', 'minimal', 'standard']).default('minimal'),
  examplesGood: z.array(z.string().max(3000)).max(50).default([]),
  examplesBad: z.array(z.string().max(3000)).max(50).default([]),
  aiEligible: z.boolean().default(true),
  localeProfiles: z.record(z.string(), z.object({ tone: z.string().optional(), notes: z.string().optional(), bannedTerms: z.array(z.string()).optional() })).default({}),
});
export type BrandInputT = z.infer<typeof BrandInput>;

export function brandRow(r: any) {
  return {
    id: r.id, name: r.name, description: r.description, audience: r.audience, positioning: r.positioning, voiceSummary: r.voice_summary,
    tone: r.tone, language: r.language, preferredTerms: j<string[]>(r.preferred_terms, []), bannedTerms: j<string[]>(r.banned_terms, []),
    ctaStyle: r.cta_style, bannedCtas: j<string[]>(r.banned_ctas, []), emojiPolicy: r.emoji_policy, maxEmoji: r.max_emoji,
    sentenceStyle: r.sentence_style, hashtagsPolicy: r.hashtags_policy, examplesGood: j<string[]>(r.examples_good, []),
    examplesBad: j<string[]>(r.examples_bad, []), voiceStatus: r.voice_status, voiceDraft: j(r.voice_draft, null),
    aiEligible: !!r.ai_eligible, localeProfiles: j(r.locale_profiles, {}), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export type Brand = ReturnType<typeof brandRow>;

export function listBrands(ctx: Ctx) {
  requirePerm(ctx, 'read');
  return ctx.app.db.all('SELECT * FROM brands WHERE workspace_id = ? ORDER BY created_at', ctx.workspaceId).map(brandRow);
}
export function getBrand(ctx: Ctx, brandId: string) {
  return brandRow(getScoped(ctx, 'brands', brandId));
}
export function defaultBrand(ctx: Ctx): Brand | null {
  const r = ctx.app.db.get('SELECT * FROM brands WHERE workspace_id = ? ORDER BY created_at LIMIT 1', ctx.workspaceId);
  return r ? brandRow(r) : null;
}

function toCols(b: Partial<BrandInputT>) {
  const m: Record<string, unknown> = {};
  const map: Record<string, string> = {
    name: 'name', description: 'description', audience: 'audience', positioning: 'positioning', voiceSummary: 'voice_summary', tone: 'tone',
    language: 'language', preferredTerms: 'preferred_terms', bannedTerms: 'banned_terms', ctaStyle: 'cta_style', bannedCtas: 'banned_ctas',
    emojiPolicy: 'emoji_policy', maxEmoji: 'max_emoji', sentenceStyle: 'sentence_style', hashtagsPolicy: 'hashtags_policy',
    examplesGood: 'examples_good', examplesBad: 'examples_bad', aiEligible: 'ai_eligible', localeProfiles: 'locale_profiles',
  };
  for (const [k, v] of Object.entries(b)) if (map[k] && v !== undefined) m[map[k]] = v;
  return m;
}

export function createBrand(ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'manage_brand');
  const b = BrandInput.parse(input);
  const bid = id('brd');
  ctx.app.db.insert('brands', { id: bid, workspace_id: ctx.workspaceId, ...toCols(b), created_at: nowIso(ctx), updated_at: nowIso(ctx) });
  audit(ctx, 'brand.created', 'brand', bid, { name: b.name });
  return getBrand(ctx, bid);
}

export function updateBrand(ctx: Ctx, brandId: string, input: unknown) {
  requirePerm(ctx, 'manage_brand');
  const before = getBrand(ctx, brandId);
  const patch = BrandInput.partial().parse(input);
  ctx.app.db.update('brands', brandId, ctx.workspaceId, { ...toCols(patch), updated_at: nowIso(ctx) });
  const meta: Record<string, unknown> = { fields: Object.keys(patch) };
  if (patch.bannedTerms) {
    meta.bannedTermsAdded = patch.bannedTerms.filter((t) => !before.bannedTerms.includes(t));
    meta.bannedTermsRemoved = before.bannedTerms.filter((t) => !patch.bannedTerms!.includes(t));
    audit(ctx, 'brand.banned_terms_changed', 'brand', brandId, meta);
  }
  audit(ctx, 'brand.updated', 'brand', brandId, { fields: Object.keys(patch) });
  return getBrand(ctx, brandId);
}

/** AI/heuristic Brand Voice DRAFT from samples. Saved as draft; becomes active only after human confirmation. */
export async function draftVoice(ctx: Ctx, brandId: string, samples: string[]) {
  requirePerm(ctx, 'manage_brand');
  const brand = getBrand(ctx, brandId);
  if (!samples.length) throw badRequest('サンプル（過去投稿・記事・商品説明など）を1件以上入力してください');
  const heuristic = draftBrandVoice(samples);
  const out = await ctx.app.ai.run(
    ctx.workspaceId,
    { task: 'brand_voice_draft', system: 'You analyse writing style. Output a short Japanese summary of tone, sentence length, formality, humor, emoji use, CTA patterns, frequent and avoid phrases.', instruction: 'Summarise the writing style of these samples.', data: samples.join('\n---\n') },
    { eligible: brand.aiEligible, allowed: samples, fallback: () => '' },
  );
  const draft = { ...heuristic, aiSummary: out.text || null, generatedBy: out.usedProvider, createdAt: nowIso(ctx) };
  ctx.app.db.update('brands', brandId, ctx.workspaceId, { voice_draft: draft, voice_status: 'draft', updated_at: nowIso(ctx) });
  audit(ctx, 'brand.voice_drafted', 'brand', brandId, { samples: samples.length, provider: out.usedProvider });
  return draft;
}

export function confirmVoice(ctx: Ctx, brandId: string, edits: { voiceSummary: string; tone?: string; sentenceStyle?: string }) {
  requirePerm(ctx, 'manage_brand');
  getBrand(ctx, brandId);
  ctx.app.db.update('brands', brandId, ctx.workspaceId, { voice_summary: edits.voiceSummary, tone: edits.tone ?? null, sentence_style: edits.sentenceStyle ?? null, voice_status: 'confirmed', updated_at: nowIso(ctx) });
  audit(ctx, 'brand.voice_confirmed', 'brand', brandId);
  return getBrand(ctx, brandId);
}

export const brandLite = (b: Brand | null, locale?: string): BrandLite => ({
  name: b?.name ?? 'Brand', language: locale ?? b?.language ?? 'ja', ctaStyle: b?.ctaStyle, emojiPolicy: b?.emojiPolicy, maxEmoji: b?.maxEmoji,
  hashtagsPolicy: b?.hashtagsPolicy, preferredTerms: b?.preferredTerms, bannedTerms: b?.bannedTerms,
});
export const brandForGuard = (b: Brand | null, locale?: string): BrandForGuard => {
  const lp = locale && b ? (b.localeProfiles as any)[locale] : null;
  return {
    bannedTerms: [...(b?.bannedTerms ?? []), ...(lp?.bannedTerms ?? [])], bannedCtas: b?.bannedCtas ?? [], emojiPolicy: b?.emojiPolicy ?? 'few',
    maxEmoji: b?.maxEmoji ?? 2, tone: lp?.tone ?? b?.tone, language: locale ?? b?.language,
  };
};
