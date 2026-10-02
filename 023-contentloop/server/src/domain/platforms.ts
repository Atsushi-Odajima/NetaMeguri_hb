// Platform Profiles = content format guidance. Deliberately separate from Connector capability
// (whether ContentLoop can post via API). Limits MUST be re-verified against official docs before release
// (see SOURCE_NOTES.md / PLATFORM_PROFILES.md).

export type PlatformId =
  | 'threads' | 'x' | 'linkedin' | 'instagram' | 'facebook' | 'tiktok' | 'youtube_shorts'
  | 'youtube_community' | 'blog' | 'newsletter' | 'generic';

export type FormatId = 'post' | 'thread' | 'carousel' | 'short_video' | 'article' | 'newsletter' | 'quote' | 'caption';

export interface PlatformProfile {
  id: PlatformId;
  label: string;
  maxLength: number;
  preferredLength: [number, number];
  formats: FormatId[];
  hashtagPolicy: { max: number; style: 'none' | 'inline' | 'end' };
  linkPolicy: 'inline_ok' | 'link_penalty_possible' | 'no_clickable_links' | 'bio_link';
  ctaStyle: string;
  mediaRequirements: string;
  notes: string;
  verifiedAt: string | null; // date limits were checked against official docs (null = not yet verified)
}

export const PLATFORMS: Record<PlatformId, PlatformProfile> = {
  threads: {
    id: 'threads', label: 'Threads', maxLength: 500, preferredLength: [80, 300], formats: ['post', 'thread', 'quote'],
    hashtagPolicy: { max: 1, style: 'end' }, linkPolicy: 'inline_ok', ctaStyle: '会話を促す問いかけ',
    mediaRequirements: '画像/動画任意', notes: '1投稿500文字(公式docsで要確認)。会話調・短め。', verifiedAt: null,
  },
  x: {
    id: 'x', label: 'X', maxLength: 280, preferredLength: [60, 200], formats: ['post', 'thread', 'quote'],
    hashtagPolicy: { max: 2, style: 'end' }, linkPolicy: 'link_penalty_possible', ctaStyle: '短い一言CTA',
    mediaRequirements: '画像最大4枚等(要確認)', notes: '日本語は全角1文字=2カウントの重み付け(要確認)。maxLengthは重み付け後280。', verifiedAt: null,
  },
  linkedin: {
    id: 'linkedin', label: 'LinkedIn', maxLength: 3000, preferredLength: [400, 1300], formats: ['post', 'article', 'carousel'],
    hashtagPolicy: { max: 3, style: 'end' }, linkPolicy: 'inline_ok', ctaStyle: '学び/意見を求める',
    mediaRequirements: '文書(PDF)カルーセル可(要確認)', notes: '冒頭2行で要点。ビジネス文体。', verifiedAt: null,
  },
  instagram: {
    id: 'instagram', label: 'Instagram', maxLength: 2200, preferredLength: [150, 600], formats: ['carousel', 'caption', 'short_video'],
    hashtagPolicy: { max: 5, style: 'end' }, linkPolicy: 'no_clickable_links', ctaStyle: '保存/プロフィールリンク誘導',
    mediaRequirements: '画像/動画必須。Carousel最大枚数は要確認', notes: 'キャプション内URLはクリック不可。', verifiedAt: null,
  },
  facebook: {
    id: 'facebook', label: 'Facebook', maxLength: 63206, preferredLength: [100, 500], formats: ['post'],
    hashtagPolicy: { max: 2, style: 'end' }, linkPolicy: 'inline_ok', ctaStyle: 'コメント/シェア促進',
    mediaRequirements: '任意', notes: 'Page投稿想定。', verifiedAt: null,
  },
  tiktok: {
    id: 'tiktok', label: 'TikTok', maxLength: 2200, preferredLength: [50, 150], formats: ['short_video', 'caption'],
    hashtagPolicy: { max: 4, style: 'end' }, linkPolicy: 'no_clickable_links', ctaStyle: 'フォロー/続き誘導',
    mediaRequirements: '縦動画必須', notes: '冒頭1〜2秒のhookが重要。', verifiedAt: null,
  },
  youtube_shorts: {
    id: 'youtube_shorts', label: 'YouTube Shorts', maxLength: 5000, preferredLength: [50, 200], formats: ['short_video'],
    hashtagPolicy: { max: 3, style: 'end' }, linkPolicy: 'inline_ok', ctaStyle: '本編/チャンネル誘導',
    mediaRequirements: '縦動画。長さ上限は要確認', notes: 'タイトル100文字(要確認)。', verifiedAt: null,
  },
  youtube_community: {
    id: 'youtube_community', label: 'YouTube Community', maxLength: 1500, preferredLength: [80, 400], formats: ['post'],
    hashtagPolicy: { max: 2, style: 'end' }, linkPolicy: 'inline_ok', ctaStyle: 'アンケート/コメント',
    mediaRequirements: '任意', notes: '公開APIによる投稿可否は要確認(SOURCE_NOTES.md)。', verifiedAt: null,
  },
  blog: {
    id: 'blog', label: 'Blog', maxLength: 20000, preferredLength: [1500, 5000], formats: ['article'],
    hashtagPolicy: { max: 0, style: 'none' }, linkPolicy: 'inline_ok', ctaStyle: '記事末CTA',
    mediaRequirements: 'アイキャッチ推奨', notes: 'Sourceを単純転載せず再構成し、出典を保持。', verifiedAt: null,
  },
  newsletter: {
    id: 'newsletter', label: 'Newsletter', maxLength: 15000, preferredLength: [600, 2500], formats: ['newsletter'],
    hashtagPolicy: { max: 0, style: 'none' }, linkPolicy: 'inline_ok', ctaStyle: '返信/リンク誘導',
    mediaRequirements: '任意', notes: '件名+プレビュー文+本文。', verifiedAt: null,
  },
  generic: {
    id: 'generic', label: 'Generic', maxLength: 5000, preferredLength: [100, 800], formats: ['post', 'quote', 'caption'],
    hashtagPolicy: { max: 3, style: 'end' }, linkPolicy: 'inline_ok', ctaStyle: '任意', mediaRequirements: '任意',
    notes: '汎用テキスト。', verifiedAt: null,
  },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS) as PlatformId[];
export const isPlatform = (p: string): p is PlatformId => p in PLATFORMS;

/** Length as the platform counts it (X weights CJK as 2). */
export function platformLength(platform: PlatformId, text: string): number {
  const seg = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  let n = 0;
  for (const { segment } of seg.segment(text)) {
    if (platform === 'x') {
      const cp = segment.codePointAt(0)!;
      // Approximation of X's weighted counting: Latin-1/general punctuation = 1, others = 2. URLs count 23.
      n += cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
    } else n += 1;
  }
  if (platform === 'x') {
    for (const m of text.matchAll(/https?:\/\/\S+/g)) n += 23 - [...m[0]].length;
  }
  return n;
}

// Pack item kinds → platform + format
export const PACK_KINDS: Record<string, { platform: PlatformId; format: FormatId; label: string }> = {
  short_video: { platform: 'youtube_shorts', format: 'short_video', label: 'ショート動画候補' },
  threads: { platform: 'threads', format: 'post', label: 'Threads' },
  x: { platform: 'x', format: 'post', label: 'X' },
  linkedin: { platform: 'linkedin', format: 'post', label: 'LinkedIn' },
  instagram_carousel: { platform: 'instagram', format: 'carousel', label: 'Instagram Carousel' },
  blog: { platform: 'blog', format: 'article', label: 'ブログ' },
  newsletter: { platform: 'newsletter', format: 'newsletter', label: 'ニュースレター' },
  quote: { platform: 'generic', format: 'quote', label: '引用・名言' },
  facebook: { platform: 'facebook', format: 'post', label: 'Facebook' },
  tiktok: { platform: 'tiktok', format: 'short_video', label: 'TikTok' },
  youtube_community: { platform: 'youtube_community', format: 'post', label: 'YouTube Community' },
};
