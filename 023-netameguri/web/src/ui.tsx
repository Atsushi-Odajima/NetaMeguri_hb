import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';

export const PLATFORM_LABEL: Record<string, string> = {
  threads: 'Threads', x: 'X', linkedin: 'LinkedIn', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok',
  youtube_shorts: 'YouTube Shorts', youtube_community: 'YouTube Community', blog: 'ブログ', newsletter: 'ニュースレター', generic: '汎用',
};
export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', needs_review: 'Review待ち', approved: 'Approved', scheduled: '予約済み', published: '公開済み', failed: '失敗', archived: 'アーカイブ', recycling_candidate: '再利用候補',
  new: 'New', used: 'Used', reusable: 'Reusable', overused: 'Overused', retired: 'Retired', needs_update: 'Needs Update',
  queued: '待機', running: '実行中', handoff: '手動投稿', cancelled: '取消',
};
export const ANGLE_LABEL: Record<string, string> = {
  failure_story: '失敗談', how_to: 'How-to', checklist: 'チェックリスト', why: 'なぜ', comparison: '比較', data: 'データ', story: 'ストーリー', insight: '気づき', faq: 'FAQ', update: '最新情報',
};
export const FORMAT_LABEL: Record<string, string> = {
  post: '通常投稿', thread: 'スレッド', carousel: 'カルーセル', short_video: 'ショート動画', article: '記事', newsletter: 'ニュースレター', quote: '引用', caption: 'キャプション',
};
export const CAP_LABEL: Record<string, string> = { READ: '読み取り', ANALYTICS_READ: '分析取得', DRAFT_EXPORT: '下書き/手動投稿', SCHEDULE: '予約', PUBLISH: '投稿', DELETE: '削除', UNAVAILABLE: '利用不可' };
export const RIGHTS_LABEL: Record<string, string> = { owned: '自分の素材', licensed: 'ライセンス取得済み', public_reference: '公開情報の参照', unknown: '不明' };

export function Logo({ size = 28, dark = false }: { size?: number; dark?: boolean }) {
  return (
    <span className="logo" aria-label="NetaMeguri">
      <LoopMark size={size} />
      <span className="logo-word" style={{ fontSize: size * 0.72 }}>
        <span style={{ color: dark ? '#fff' : 'var(--ink)' }}>Neta</span>
        <span style={{ color: 'var(--orange)' }}>Meguri</span>
      </span>
    </span>
  );
}

/** NetaMeguri symbol: an open loop with a flow tip (not a recycle mark). */
export function LoopMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size * 1.5} height={size} viewBox="0 0 120 80" aria-hidden="true">
      <defs>
        <linearGradient id="clg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#FF9A2E" />
          <stop offset="1" stopColor="#FF6A00" />
        </linearGradient>
      </defs>
      <path d="M60 40 C 70 24, 82 16, 94 16 C 107 16, 114 27, 114 40 C 114 53, 107 64, 94 64 C 82 64, 70 56, 60 40 C 50 24, 38 16, 26 16 C 13 16, 6 27, 6 40 C 6 53, 13 64, 26 64 C 34 64, 41 60, 47 54" fill="none" stroke="url(#clg)" strokeWidth="13" strokeLinecap="round" />
      <path d="M44 44 L 56 52 L 42 60 Z" fill="#FF6A00" />
    </svg>
  );
}

export function PlatformBadge({ p }: { p: string }) {
  return <span className={`pbadge p-${p}`}>{PLATFORM_LABEL[p] ?? p}</span>;
}
export function Status({ s }: { s: string }) {
  return <span className={`status s-${s}`}>{STATUS_LABEL[s] ?? s}</span>;
}
export function Card({ title, children, actions, className = '' }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-h">
          <h2>{title}</h2>
          <div className="row">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
export function Err({ e }: { e: unknown }) {
  if (!e) return null;
  const msg = e instanceof ApiError ? e.message : String((e as Error)?.message ?? e);
  const det = e instanceof ApiError && Array.isArray(e.details) ? e.details.map((d: any) => d.message ?? JSON.stringify(d)).join(' / ') : '';
  return <div className="alert err" role="alert">{msg}{det ? `（${det}）` : ''}</div>;
}
export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'ok' | 'err'; children: ReactNode }) {
  return <div className={`alert ${kind}`}>{children}</div>;
}

/** Load data with loading/error state and reload. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    return fn()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Wrap an async action with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDay = (s?: string | null) => (s ? new Date(s).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : '—');
export const graphemes = (s: string) => {
  try {
    return [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(s)].length;
  } catch {
    return [...s].length;
  }
};

export function Loading() {
  return <div className="loading" aria-busy="true">読み込み中…</div>;
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button key={i.id} role="tab" aria-selected={value === i.id} className={value === i.id ? 'on' : ''} onClick={() => onChange(i.id)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------- 日本語の日付・時刻入力（端末の言語設定に依存しない） ----------------
const pad2 = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** value: "YYYY-MM-DD" または ""（optional のとき未設定）。年・月・日の選択式。 */
export function JaDate({ label, value, onChange, optional = false, yearsBack = 5, yearsAhead = 3 }: { label: string; value: string; onChange: (v: string) => void; optional?: boolean; yearsBack?: number; yearsAhead?: number }) {
  const now = new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const y = m ? Number(m[1]) : null;
  const mo = m ? Number(m[2]) : null;
  const d = m ? Number(m[3]) : null;
  const years: number[] = [];
  for (let k = now.getFullYear() - yearsBack; k <= now.getFullYear() + yearsAhead; k++) years.push(k);
  if (y && !years.includes(y)) years.push(y);
  const set = (ny: number, nm: number, nd: number) => onChange(`${ny}-${pad2(nm)}-${pad2(Math.min(nd, daysInMonth(ny, nm)))}`);
  const base = { y: y ?? now.getFullYear(), mo: mo ?? now.getMonth() + 1, d: d ?? now.getDate() };
  return (
    <fieldset className="ja-dt" aria-label={label}>
      <legend>{label}</legend>
      <div className="row tight-row">
        <select aria-label={`${label} 年`} value={y ?? ''} onChange={(e) => (e.target.value ? set(Number(e.target.value), base.mo, base.d) : onChange(''))}>
          {(optional || !y) && <option value="">{optional ? '未設定' : '—'}</option>}
          {years.sort((a, b) => a - b).map((v) => <option key={v} value={v}>{v}年</option>)}
        </select>
        <select aria-label={`${label} 月`} value={mo ?? ''} disabled={!y} onChange={(e) => set(base.y, Number(e.target.value), base.d)}>
          {!mo && <option value="">—</option>}
          {Array.from({ length: 12 }, (_, i) => i + 1).map((v) => <option key={v} value={v}>{v}月</option>)}
        </select>
        <select aria-label={`${label} 日`} value={d ?? ''} disabled={!y} onChange={(e) => set(base.y, base.mo, Number(e.target.value))}>
          {!d && <option value="">—</option>}
          {Array.from({ length: daysInMonth(base.y, base.mo) }, (_, i) => i + 1).map((v) => <option key={v} value={v}>{v}日</option>)}
        </select>
      </div>
    </fieldset>
  );
}

/** value: "HH:mm"（24時間制）。step は分の刻み。 */
export function JaTime({ label, value, onChange, step = 5 }: { label: string; value: string; onChange: (v: string) => void; step?: number }) {
  const [h, mi] = /^\d{2}:\d{2}$/.test(value) ? value.split(':') : ['00', '00'];
  const mins = Array.from({ length: 60 / step }, (_, i) => pad2(i * step));
  if (!mins.includes(mi)) mins.push(mi);
  return (
    <fieldset className="ja-dt" aria-label={label}>
      <legend>{label}</legend>
      <div className="row tight-row">
        <select aria-label={`${label} 時`} value={h} onChange={(e) => onChange(`${e.target.value}:${mi}`)}>
          {Array.from({ length: 24 }, (_, i) => pad2(i)).map((v) => <option key={v} value={v}>{Number(v)}時</option>)}
        </select>
        <select aria-label={`${label} 分`} value={mi} onChange={(e) => onChange(`${h}:${e.target.value}`)}>
          {mins.sort().map((v) => <option key={v} value={v}>{v}分</option>)}
        </select>
      </div>
    </fieldset>
  );
}

/** "2026-10-04T09:00" / "2026-10-04" → "2026年10月4日（日）9:00" */
export function jaDateTime(local: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(local ?? '');
  if (!m) return local;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const w = '日月火水木金土'[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${y}年${mo}月${d}日（${w}）${m[4] != null ? ` ${Number(m[4])}:${m[5]}` : ''}`.replace('） ', '）');
}

/** 日本語表示のファイル選択（ブラウザ標準の "Choose File" を出さない）。 */
export function FilePick({ label, accept, onFile, required = false, showLabel = true }: { label: string; accept?: string; onFile: (f: File | null) => void; required?: boolean; showLabel?: boolean }) {
  const [name, setName] = useState('');
  return (
    <div className="file-pick-wrap">
      {showLabel && <span className="file-pick-label">{label}</span>}
      <label className="file-pick">
        <input
          type="file"
          className="sr-only"
          accept={accept}
          required={required}
          aria-label={label}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setName(f?.name ?? '');
            onFile(f);
          }}
        />
        <span className="btn sm" aria-hidden="true">ファイルを選択</span>
        <span className={`small ${name ? '' : 'muted'}`}>{name || 'ファイルが選択されていません'}</span>
      </label>
    </div>
  );
}

export const TIMEZONES: [string, string][] = [
  ['Asia/Tokyo', '日本時間 (Asia/Tokyo)'], ['UTC', '協定世界時 (UTC)'], ['Asia/Seoul', 'ソウル (Asia/Seoul)'], ['Asia/Shanghai', '上海 (Asia/Shanghai)'],
  ['Asia/Singapore', 'シンガポール (Asia/Singapore)'], ['Australia/Sydney', 'シドニー (Australia/Sydney)'], ['Europe/London', 'ロンドン (Europe/London)'],
  ['Europe/Paris', 'パリ (Europe/Paris)'], ['America/New_York', 'ニューヨーク (America/New_York)'], ['America/Los_Angeles', 'ロサンゼルス (America/Los_Angeles)'],
];
export function TzSelect({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const opts = TIMEZONES.some(([z]) => z === value) ? TIMEZONES : [[value, value] as [string, string], ...TIMEZONES];
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {opts.map(([z, l]) => <option key={z} value={z}>{l}</option>)}
      </select>
    </label>
  );
}
