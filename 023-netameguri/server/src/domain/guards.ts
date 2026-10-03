import { countEmoji, splitSentences } from '../lib/text.js';
import { PLATFORMS, platformLength, type PlatformId } from './platforms.js';
import { CLAIM_RE } from '../ai/local.js';

export type Severity = 'info' | 'warn' | 'block';
export interface GuardIssue {
  check: string;
  severity: Severity;
  message: string;
  excerpt?: string;
}

export interface BrandForGuard {
  bannedTerms: string[];
  bannedCtas: string[];
  emojiPolicy: string; // none | few | free
  maxEmoji: number;
  tone?: string | null;
  language?: string;
}

/**
 * Brand Guard: individual checks with explanations. Deliberately no single "brand score" verdict.
 */
export function brandGuard(text: string, platform: PlatformId, brand: BrandForGuard, opts: { registeredClaimValues?: string[] } = {}): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const lower = text.normalize('NFKC').toLowerCase();
  for (const t of brand.bannedTerms) {
    if (t && lower.includes(t.normalize('NFKC').toLowerCase())) issues.push({ check: 'banned_term', severity: 'block', message: `禁止表現「${t}」が含まれています`, excerpt: t });
  }
  for (const c of brand.bannedCtas) {
    if (c && lower.includes(c.normalize('NFKC').toLowerCase())) issues.push({ check: 'banned_cta', severity: 'block', message: `禁止CTA「${c}」が含まれています`, excerpt: c });
  }
  const emoji = countEmoji(text);
  const maxEmoji = brand.emojiPolicy === 'none' ? 0 : brand.emojiPolicy === 'free' ? Infinity : brand.maxEmoji;
  if (emoji > maxEmoji) issues.push({ check: 'emoji', severity: 'warn', message: `絵文字が${emoji}個あります（方針: ${brand.emojiPolicy === 'none' ? '使わない' : `最大${maxEmoji}個`}）` });
  const p = PLATFORMS[platform];
  const len = platformLength(platform, text);
  if (len > p.maxLength) issues.push({ check: 'length', severity: 'block', message: `${p.label}の上限${p.maxLength}を超えています（${len}）` });
  else if (len > p.preferredLength[1] * 1.5) issues.push({ check: 'length', severity: 'info', message: `推奨より長めです（${len} / 推奨${p.preferredLength[0]}〜${p.preferredLength[1]}）` });
  const tags = (text.match(/[#＃][\p{L}\p{N}_]+/gu) ?? []).length;
  if (tags > p.hashtagPolicy.max) issues.push({ check: 'hashtags', severity: 'warn', message: `ハッシュタグ${tags}個（${p.label}方針: 最大${p.hashtagPolicy.max}）` });
  if (p.linkPolicy === 'no_clickable_links' && /https?:\/\//.test(text)) issues.push({ check: 'link', severity: 'info', message: `${p.label}では本文URLはクリックできません` });
  // tone deviation (heuristic)
  const exclam = (text.match(/[!！]/g) ?? []).length;
  if (brand.tone && /calm|落ち着|丁寧|professional/i.test(brand.tone) && exclam >= 3) issues.push({ check: 'tone', severity: 'info', message: `感嘆符が多く、Brandのtone「${brand.tone}」から外れている可能性があります` });
  if (brand.language === 'ja' && /だ。|である。/.test(text) && /です|ます/.test(text)) issues.push({ check: 'tone', severity: 'info', message: 'です/ます調とだ/である調が混在しています' });
  // unverified claims
  const registered = (opts.registeredClaimValues ?? []).map((v) => v.normalize('NFKC'));
  for (const s of splitSentences(text)) {
    if (CLAIM_RE.test(s) && !registered.some((v) => v && s.normalize('NFKC').includes(v))) {
      issues.push({ check: 'unverified_claim', severity: 'warn', message: '数値・価格・ランキング等の主張がClaim Registryで確認されていません', excerpt: s.slice(0, 80) });
    }
  }
  return issues;
}

// ---------------- Freshness ----------------
const FRESHNESS_RULES: { kind: string; re: RegExp; label: string }[] = [
  { kind: 'price', re: /\d[\d,]*\s*(円|万円|ドル|USD|\$)|価格|料金|月額|年額|プラン/i, label: '価格' },
  { kind: 'spec', re: /仕様|バージョン|v\d+(\.\d+)+|対応機種|上限|最大\d/i, label: '仕様' },
  { kind: 'ranking', re: /\d+\s*位|ランキング|No\.?\s?1|トップ\d/i, label: 'ランキング' },
  { kind: 'current', re: /現在|今年|今月|最新|今のところ|currently|this year|latest/i, label: '現在形の表現' },
  { kind: 'statistic', re: /\d+(\.\d+)?\s*(%|％)|統計|調査によると|割合/i, label: '統計' },
  { kind: 'date', re: /20\d{2}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日|20\d{2}[-/]\d{1,2}/, label: '日付' },
  { kind: 'event', re: /開催|イベント|キャンペーン期間|締切|セール/i, label: 'イベント' },
];

export interface FreshnessIssue { kind: string; label: string; excerpt: string; message: string }

/** Flags date-dependent claims. When reusing old content, these must be re-checked by a human. */
export function freshnessCheck(text: string, opts: { originalDate?: string | null; now: Date; staleAfterDays?: number }): FreshnessIssue[] {
  const ageDays = opts.originalDate ? Math.floor((opts.now.getTime() - new Date(opts.originalDate).getTime()) / 86400_000) : null;
  const stale = ageDays == null || ageDays >= (opts.staleAfterDays ?? 30);
  if (!stale) return [];
  const out: FreshnessIssue[] = [];
  for (const s of splitSentences(text)) {
    for (const r of FRESHNESS_RULES) {
      if (r.re.test(s)) {
        out.push({ kind: r.kind, label: r.label, excerpt: s.slice(0, 80), message: `${ageDays != null ? `${ageDays}日前の内容です。` : ''}${r.label}を含むため、現在も正しいか確認してください（AIは古い値を最新として断定しません）。` });
        break;
      }
    }
  }
  return out;
}

// ---------------- Fact guard for AI output ----------------
const TESTIMONIAL_RE = /(お客様の声|利用者の声|ユーザーの声|導入企業|レビュー|口コミ|testimonial|customer said|「[^」]*(最高|助かり|おすすめ|満足)[^」]*」と)/i;
const ACHIEVEMENT_RE = /(達成|突破|導入実績|満足度|売上|成長率|フォロワー\d|万人|累計|受賞)/;

/**
 * Remove sentences from AI output that assert numbers/testimonials/achievements not present in allowed data.
 * Returns cleaned text plus removed sentences (so a human can review).
 */
export function factGuard(output: string, allowedTexts: string[]): { text: string; removed: { sentence: string; reason: string }[] } {
  const allowed = allowedTexts.join('\n').normalize('NFKC');
  const removed: { sentence: string; reason: string }[] = [];
  const lines = output.split('\n');
  const keptLines = lines.map((line) => {
    const parts = line.split(/(?<=[。！？!?])/u);
    return parts
      .filter((s) => {
        const n = s.normalize('NFKC');
        const nums = n.match(/\d[\d,.]*/g) ?? [];
        const unsupportedNum = nums.find((x) => x.length >= 2 && !allowed.includes(x));
        if (TESTIMONIAL_RE.test(n) && !allowed.includes(n.trim())) {
          removed.push({ sentence: s.trim(), reason: '根拠データにない利用者の声/レビューの可能性' });
          return false;
        }
        if (unsupportedNum && (ACHIEVEMENT_RE.test(n) || CLAIM_RE.test(n))) {
          removed.push({ sentence: s.trim(), reason: `根拠データにない数値「${unsupportedNum}」` });
          return false;
        }
        return true;
      })
      .join('');
  });
  return { text: keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}
