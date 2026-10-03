// Local (no external API) content engine. Extractive + template based:
// it only rearranges sentences from the user's own Source and adds neutral framing.
// It never invents experiences, numbers, customer voices or results.

import { splitSentences, topKeywords, keywords, cosine, trigrams, truncateAtSentence, countGraphemes } from '../lib/text.js';
import { PLATFORMS, platformLength, type PlatformId, type FormatId } from '../domain/platforms.js';

export type Angle = 'failure_story' | 'how_to' | 'checklist' | 'why' | 'comparison' | 'data' | 'story' | 'insight' | 'faq' | 'update';

export const ANGLE_LABELS: Record<Angle, string> = {
  failure_story: '失敗談', how_to: 'How-to', checklist: 'チェックリスト', why: 'なぜ', comparison: '比較',
  data: 'データ', story: 'ストーリー', insight: '気づき', faq: 'FAQ', update: '最新情報',
};

export interface Segment { idx: number; startMs: number; endMs: number; text: string; inaudible?: boolean }

export interface Analysis {
  language: string;
  topics: string[];
  keyPoints: { text: string; sentence: number }[];
  quotes: string[];
  claims: { text: string; kind: string }[];
  ideas: ExtractedIdea[];
  opportunities: string[];
  sentenceCount: number;
  engine: 'local-extractive-v1';
}
export interface ExtractedIdea {
  coreIdea: string;
  angle: Angle;
  topic: string;
  evidence: number[]; // sentence indices
  startMs?: number;
  endMs?: number;
}

const ANGLE_CUES: [Angle, RegExp][] = [
  ['failure_story', /失敗|ミス|やらかし|ハマ|後悔|反省|fail|mistake|lesson/i],
  ['checklist', /チェック|リスト|確認すべき|項目|checklist/i],
  ['how_to', /手順|方法|やり方|ステップ|コツ|設定|how to|step/i],
  ['why', /なぜ|理由|why|because|ため[にの]?重要/i],
  ['comparison', /比較|違い|より|vs\.?|versus|一方/i],
  ['data', /\d+(\.\d+)?\s*(%|％|円|件|人|倍|時間|分|日|ドル|USD)/i],
  ['faq', /よくある質問|FAQ|質問|疑問|\?|？/i],
  ['story', /実は|経験|昔|最初は|きっかけ|私は|僕は|we started|i started/i],
];

export const CLAIM_RE = /(\d[\d,.]*\s*(%|％|円|万円|件|人|倍|位|ドル|USD|\$))|(No\.?\s?1|ナンバーワン|業界初|日本初|世界初|最安|最速|唯一)|(価格|料金|プラン|発売日|リリース日|統計|ランキング)/i;

export function detectLanguage(text: string): string {
  const ja = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) ?? []).length;
  return ja > text.length * 0.1 ? 'ja' : 'en';
}

export function detectAngle(s: string): Angle {
  for (const [a, re] of ANGLE_CUES) if (re.test(s)) return a;
  return 'insight';
}

export function analyzeText(text: string, segments: Segment[] = []): Analysis {
  const sentences = splitSentences(text);
  const top = topKeywords(text, 15);
  const weight = new Map(top.map((k, i) => [k, 15 - i]));
  const scored = sentences.map((s, i) => {
    const ks = new Set(keywords(s));
    let score = 0;
    for (const k of ks) score += weight.get(k) ?? 0;
    const len = countGraphemes(s);
    if (len < 12) score *= 0.3;
    if (len > 160) score *= 0.6;
    if (detectAngle(s) !== 'insight') score *= 1.25;
    return { s, i, score };
  });
  const ranked = [...scored].sort((a, b) => b.score - a.score);

  const keyPoints: Analysis['keyPoints'] = [];
  for (const r of ranked) {
    if (keyPoints.length >= 12) break;
    if (r.score <= 0) break;
    const tg = trigrams(r.s);
    if (keyPoints.some((k) => cosine(trigrams(k.text), tg) > 0.5)) continue;
    keyPoints.push({ text: r.s, sentence: r.i });
  }

  const ideas: ExtractedIdea[] = keyPoints.map((kp) => {
    const kws = keywords(kp.text);
    const topic = kws.sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0))[0] ?? top[0] ?? 'general';
    const seg = locateInSegments(kp.text, segments);
    const neighbours = [kp.sentence - 1, kp.sentence, kp.sentence + 1].filter((x) => x >= 0 && x < sentences.length);
    return {
      coreIdea: truncateAtSentence(kp.text, 140),
      angle: detectAngle(sentences.slice(Math.max(0, kp.sentence - 1), kp.sentence + 2).join(' ')),
      topic,
      evidence: neighbours,
      ...(seg ? { startMs: seg.startMs, endMs: seg.endMs } : {}),
    };
  });

  const quotes = sentences
    .filter((s) => { const n = countGraphemes(s); return n >= 12 && n <= 70 && !CLAIM_RE.test(s); })
    .sort((a, b) => scoreOf(scored, b) - scoreOf(scored, a))
    .slice(0, 20);

  const claims = sentences.filter((s) => CLAIM_RE.test(s)).map((s) => ({ text: s, kind: /価格|料金|円|\$|ドル/.test(s) ? 'price' : /%|％|統計/.test(s) ? 'statistic' : /位|ランキング|No\.?\s?1/.test(s) ? 'ranking' : 'factual' }));

  const opportunities: string[] = [];
  if (ideas.some((i) => i.angle === 'how_to' || i.angle === 'checklist')) opportunities.push('Instagram Carousel (手順/チェックリスト)');
  if (ideas.some((i) => i.angle === 'failure_story' || i.angle === 'story')) opportunities.push('Threads/X ストーリー投稿');
  if (segments.length) opportunities.push('ショート動画クリップ候補');
  if (sentences.length > 20) opportunities.push('ブログ/ニュースレターへの再構成');
  if (claims.length) opportunities.push('Claim Registryへの登録確認');

  return { language: detectLanguage(text), topics: top.slice(0, 8), keyPoints, quotes, claims, ideas, opportunities, sentenceCount: sentences.length, engine: 'local-extractive-v1' };
}

function scoreOf(scored: { s: string; score: number }[], s: string) {
  return scored.find((x) => x.s === s)?.score ?? 0;
}

export function locateInSegments(sentence: string, segments: Segment[]): { startMs: number; endMs: number } | null {
  if (!segments.length) return null;
  const tg = trigrams(sentence);
  let best = -1;
  let bestScore = 0.15;
  segments.forEach((seg, i) => {
    if (seg.inaudible) return;
    const sc = cosine(tg, trigrams(seg.text));
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  });
  if (best < 0) return null;
  const startSeg = segments[best];
  // extend clip to ~20-45s using following segments
  let end = startSeg.endMs;
  for (let k = best + 1; k < segments.length && end - startSeg.startMs < 30_000; k++) end = segments[k].endMs;
  return { startMs: startSeg.startMs, endMs: end };
}

// ---------------------------------------------------------------- transforms

export interface BrandLite {
  name: string;
  language: string;
  ctaStyle?: string | null;
  emojiPolicy?: string;
  maxEmoji?: number;
  hashtagsPolicy?: string | null;
  preferredTerms?: string[];
  bannedTerms?: string[];
}
export interface SourceLite { id: string; title: string; type: string; url?: string | null; author?: string | null; rightsStatus: string }
export interface TransformInput {
  idea: { id?: string; coreIdea: string; angle: Angle | string; topic: string; startMs?: number; endMs?: number };
  supporting: string[]; // sentences from source(s), user-owned data
  platform: PlatformId;
  format: FormatId;
  brand: BrandLite;
  sources: SourceLite[];
  variant?: number;
  segments?: Segment[];
}
export interface TransformOutput {
  title: string | null;
  body: string;
  structured: Record<string, unknown> | null;
  notes: string[];
}

const HOOKS_JA: Record<string, string[]> = {
  failure_story: ['{t}でつまずいたポイントを共有します。', '{t}の失敗から見えたこと。'],
  how_to: ['{t}のやり方を短くまとめます。', '{t}、手順にするとこうなります。'],
  checklist: ['{t}のチェックポイント。', '{t}の前に確認したいこと。'],
  why: ['なぜ{t}が大事なのか。', '{t}を重視する理由。'],
  comparison: ['{t}、比べてみると違いがはっきりします。', '{t}の違いを整理します。'],
  data: ['{t}を数字で整理します。', '{t}について、元資料の数字を確認します。'],
  story: ['{t}の話。', '{t}について、少し背景から。'],
  insight: ['{t}で大事だと思うこと。', '{t}について、ひとつ共有します。'],
  faq: ['{t}でよくある疑問。', '{t}についての質問に答えます。'],
  update: ['{t}の最新情報です。', '{t}について更新があります。'],
};
const HOOKS_EN: Record<string, string[]> = {
  failure_story: ['What went wrong with {t}, and what it taught.'], how_to: ['How to approach {t}, in short.'],
  checklist: ['A quick {t} checklist.'], why: ['Why {t} matters.'], comparison: ['{t}: the differences that matter.'],
  data: ['{t}, by the numbers in the source.'], story: ['A story about {t}.'], insight: ['One thing about {t}.'],
  faq: ['Common questions about {t}.'], update: ['An update on {t}.'],
};
const CTA_JA: Partial<Record<PlatformId, string>> = {
  threads: 'あなたはどうしていますか？', x: '', linkedin: '皆さんの考えもぜひ聞かせてください。',
  instagram: 'あとで見返せるように保存しておいてください。', facebook: 'コメントで教えてください。',
  tiktok: '続きはプロフィールから。', youtube_shorts: '詳しくは本編で。', youtube_community: 'コメントで意見を聞かせてください。',
  blog: '', newsletter: 'このメールに返信で感想をいただけるとうれしいです。', generic: '',
};
const CTA_EN: Partial<Record<PlatformId, string>> = {
  threads: 'How do you handle this?', linkedin: 'Curious how others approach this.', instagram: 'Save this for later.',
  newsletter: 'Hit reply and tell me what you think.', facebook: 'Tell us in the comments.',
};

function hook(angle: string, topic: string, lang: string, variant = 0): string {
  const table = lang === 'en' ? HOOKS_EN : HOOKS_JA;
  const arr = table[angle] ?? table.insight;
  return arr[variant % arr.length].replace('{t}', topic);
}

function hashtags(topicWords: string[], platform: PlatformId, brand: BrandLite): string[] {
  const max = PLATFORMS[platform].hashtagPolicy.max;
  if (!max || brand.hashtagsPolicy === 'none') return [];
  const limit = brand.hashtagsPolicy === 'minimal' ? Math.min(1, max) : max;
  return [...new Set(topicWords.map((w) => '#' + w.replace(/[\s#]/g, '')))].slice(0, limit);
}

function cta(platform: PlatformId, brand: BrandLite): string {
  if (brand.ctaStyle && brand.ctaStyle.trim()) {
    // ctaStyle may be a literal CTA template ("{cta}" style) or a description; use literal only if marked.
    const m = /^「(.+)」$/.exec(brand.ctaStyle.trim());
    if (m) return m[1];
  }
  return (brand.language === 'en' ? CTA_EN[platform] : CTA_JA[platform]) ?? '';
}

function fit(platform: PlatformId, parts: string[], tail: string[]): string {
  const p = PLATFORMS[platform];
  const target = Math.max(p.preferredLength[1], 60);
  const max = p.maxLength;
  let body = '';
  for (const part of parts) {
    const next = body ? body + '\n\n' + part : part;
    const withTail = [next, ...tail.filter(Boolean)].join('\n\n');
    if (platformLength(platform, withTail) > Math.min(max, target * 1.4) && body) break;
    body = next;
  }
  let full = [body, ...tail.filter(Boolean)].join('\n\n');
  while (platformLength(platform, full) > max && body.length > 10) {
    body = truncateAtSentence(body, Math.floor(countGraphemes(body) * 0.8));
    full = [body, ...tail.filter(Boolean)].join('\n\n');
  }
  return full.trim();
}

function msToTs(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function attributionLine(sources: SourceLite[], lang: string): string {
  const s = sources[0];
  if (!s) return '';
  const who = s.author ? `${s.author}「${s.title}」` : `「${s.title}」`;
  return lang === 'en' ? `Source: ${s.title}${s.url ? ' ' + s.url : ''}` : `出典: ${who}${s.url ? ' ' + s.url : ''}`;
}

export function transform(input: TransformInput): TransformOutput {
  const { idea, platform, format, brand, sources } = input;
  const lang = brand.language === 'en' ? 'en' : 'ja';
  const v = input.variant ?? 0;
  const support = input.supporting.filter((s) => s !== idea.coreIdea);
  const rotated = v ? [...support.slice(v % Math.max(1, support.length)), ...support.slice(0, v % Math.max(1, support.length))] : support;
  const tags = hashtags([idea.topic, ...keywords(idea.coreIdea).slice(0, 3)], platform, brand);
  const thirdParty = sources.some((s) => s.rightsStatus === 'public_reference' || s.rightsStatus === 'unknown');
  const notes: string[] = [];
  if (thirdParty) notes.push('第三者/権利不明の素材を含みます。引用は短く、出典を明記し、要約内容を人間が確認してください。');
  const maxSupport = thirdParty ? 1 : 4;
  const h = hook(idea.angle, idea.topic, lang, v);
  const c = cta(platform, brand);

  switch (format) {
    case 'carousel': {
      const points = rotated.slice(0, thirdParty ? 2 : 4);
      const problem = rotated.find((s) => /課題|問題|悩み|困|難し|problem|issue/i.test(s)) ?? points[0] ?? idea.coreIdea;
      const slides = [
        { kind: 'cover', text: h },
        { kind: 'problem', text: truncateAtSentence(problem, 90) },
        ...points.filter((p) => p !== problem).slice(0, 3).map((p, i) => ({ kind: 'point', text: `${i + 1}. ${truncateAtSentence(p, 90)}` })),
        { kind: 'summary', text: truncateAtSentence(idea.coreIdea, 100) },
        { kind: 'cta', text: c || (lang === 'en' ? 'Save this post.' : '保存して見返してください。') },
      ];
      const caption = fit('instagram', [h, truncateAtSentence(idea.coreIdea, 200)], [c, tags.join(' ')]);
      return { title: h, body: caption, structured: { slides, spec: { aspect: '4:5', maxSlides: 10, note: '枚数上限は公式要確認' } }, notes };
    }
    case 'short_video': {
      const seg = idea.startMs != null && idea.endMs != null ? { start: idea.startMs, end: idea.endMs } : null;
      if (!seg) notes.push('Transcriptのtimestampが無いため、開始/終了位置は手動で指定してください。');
      const caption = fit(platform, [h], [tags.join(' ')]);
      return {
        title: truncateAtSentence(h, 60),
        body: caption,
        structured: {
          startMs: seg?.start ?? null, endMs: seg?.end ?? null,
          start: seg ? msToTs(seg.start) : null, end: seg ? msToTs(seg.end) : null,
          hook: h, topic: idea.topic, whyUseful: truncateAtSentence(idea.coreIdea, 120), captionDraft: caption,
        },
        notes,
      };
    }
    case 'article': {
      const title = lang === 'en' ? `${idea.topic}: ${truncateAtSentence(idea.coreIdea, 60)}` : `${idea.topic}について：${truncateAtSentence(idea.coreIdea, 50)}`;
      const groups = chunk(rotated.slice(0, thirdParty ? 3 : 12), 3);
      const sections = groups.map((g, i) => `## ${lang === 'en' ? 'Point' : 'ポイント'}${i + 1}\n\n${g.map((s) => (thirdParty ? `> ${truncateAtSentence(s, 100)}` : s)).join('\n\n')}`);
      const body = [
        `# ${title}`,
        lang === 'en' ? `This article reorganizes the key points from the source.` : `この記事では、元の素材の要点を整理し直してまとめます。`,
        `**${lang === 'en' ? 'Key idea' : '要点'}:** ${idea.coreIdea}`,
        ...sections,
        `## ${lang === 'en' ? 'Summary' : 'まとめ'}\n\n${idea.coreIdea}`,
        c,
        `---\n${attributionLine(sources, lang)}`,
      ].filter(Boolean).join('\n\n');
      notes.push('ブログは元素材の再構成です。事実関係・数字は公開前に確認してください。');
      return { title, body, structured: { sections: sections.length, citations: sources.map((s) => ({ sourceId: s.id, title: s.title, url: s.url })) }, notes };
    }
    case 'newsletter': {
      const subject = lang === 'en' ? `${idea.topic}: ${truncateAtSentence(idea.coreIdea, 40)}` : `【${idea.topic}】${truncateAtSentence(idea.coreIdea, 30)}`;
      const preview = truncateAtSentence(idea.coreIdea, 80);
      const body = [
        lang === 'en' ? 'Hi,' : 'こんにちは。',
        h,
        ...rotated.slice(0, maxSupport + 2),
        c,
        attributionLine(sources, lang),
      ].filter(Boolean).join('\n\n');
      return { title: subject, body, structured: { subject, preview }, notes };
    }
    case 'quote': {
      const q = truncateAtSentence(idea.coreIdea, 90);
      const who = sources[0]?.author ?? brand.name;
      return { title: null, body: `「${q}」\n— ${who}${sources[0] ? `（${sources[0].title}）` : ''}`, structured: { quote: q, attribution: who }, notes };
    }
    case 'thread': {
      const parts = [h, idea.coreIdea, ...rotated.slice(0, maxSupport)].map((s, i, arr) => `${i + 1}/${arr.length} ${s}`);
      return { title: h, body: parts.join('\n\n'), structured: { posts: parts }, notes };
    }
    default: {
      const parts = [h, idea.coreIdea, ...rotated.slice(0, maxSupport)];
      const body = fit(platform, parts, [c, tags.join(' ')]);
      return { title: null, body, structured: null, notes };
    }
  }
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Pick supporting sentences from source text that share keywords with the idea. */
export function supportingSentences(sourceText: string, idea: { coreIdea: string; topic: string }, max = 8): string[] {
  const sentences = splitSentences(sourceText);
  const ik = new Set([...keywords(idea.coreIdea), idea.topic]);
  const tg = trigrams(idea.coreIdea);
  return sentences
    .map((s) => ({ s, sc: keywords(s).filter((k) => ik.has(k)).length + cosine(tg, trigrams(s)) * 2 }))
    .filter((x) => x.sc > 0.3 && x.s !== idea.coreIdea)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, max)
    .map((x) => x.s);
}

/** Brand voice draft from examples (heuristic). Requires human confirmation before saving. */
export function draftBrandVoice(samples: string[]) {
  const all = samples.join('\n');
  const sentences = splitSentences(all);
  const avgLen = sentences.length ? Math.round(sentences.reduce((s, x) => s + countGraphemes(x), 0) / sentences.length) : 0;
  const desu = (all.match(/です|ます/g) ?? []).length;
  const da = (all.match(/だ。|である|だよ|だね/g) ?? []).length;
  const emoji = (all.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  const excl = (all.match(/[!！]/g) ?? []).length;
  const q = (all.match(/[?？]/g) ?? []).length;
  const ctas = sentences.filter((s) => /保存|フォロー|コメント|チェック|登録|リンク|詳しくは|follow|subscribe|link/i.test(s)).slice(0, 5);
  return {
    tone: excl > sentences.length * 0.3 ? 'energetic' : q > sentences.length * 0.2 ? 'conversational' : 'calm',
    formality: desu >= da ? 'polite (です/ます)' : 'casual (だ/である)',
    avgSentenceLength: avgLen,
    humor: /笑|w{2,}|草|lol/i.test(all) ? 'some' : 'low',
    emojiPerPost: samples.length ? Math.round((emoji / samples.length) * 10) / 10 : 0,
    ctaExamples: ctas,
    frequentPhrases: topKeywords(all, 10),
    avoidPhrases: [] as string[],
    note: '自動推定のDraftです。本人の文体の完全再現は保証しません。人間が確認してから保存してください。',
    sampleCount: samples.length,
  };
}
