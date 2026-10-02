import type { Segment } from './local.js';
import { badRequest } from '../lib/util.js';

/** Transcription provider abstraction. Providers must mark inaudible spans instead of guessing content. */
export interface TranscriptionProvider {
  readonly id: string;
  readonly configured: boolean;
  transcribe(media: Buffer, mime: string, opts: { language?: string }): Promise<Segment[]>;
}

/** Calls OpenAI transcription API (not exercised in tests; requires OPENAI_API_KEY + explicit enablement). */
export class OpenAITranscription implements TranscriptionProvider {
  readonly id = 'openai';
  get configured() {
    return !!process.env.OPENAI_API_KEY && process.env.CONTENTLOOP_ENABLE_TRANSCRIPTION === '1';
  }
  async transcribe(media: Buffer, mime: string, opts: { language?: string }): Promise<Segment[]> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(media)], { type: mime }), 'media');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    if (opts.language) form.append('language', opts.language);
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
    if (!res.ok) throw new Error(`transcription error ${res.status}`);
    const j: any = await res.json();
    return (j.segments ?? []).map((s: any, i: number) => ({
      idx: i, startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000), text: String(s.text).trim(),
      inaudible: (s.no_speech_prob ?? 0) > 0.6,
    }));
  }
}

export class TranscriptionRegistry {
  providers = new Map<string, TranscriptionProvider>();
  constructor() {
    this.register(new OpenAITranscription());
  }
  register(p: TranscriptionProvider) {
    this.providers.set(p.id, p);
  }
  available() {
    return [...this.providers.values()].map((p) => ({ id: p.id, configured: p.configured }));
  }
}

// ---------- Parsing user-provided transcripts (SRT / VTT / plain) ----------
const TS = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})|(\d{1,2}):(\d{2})[.,](\d{1,3})/;
function tsToMs(s: string): number {
  const m = TS.exec(s);
  if (!m) throw badRequest(`invalid timestamp: ${s}`);
  if (m[1] != null) return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0');
  return (+m[5] * 60 + +m[6]) * 1000 + +m[7].padEnd(3, '0');
}
const INAUDIBLE_RE = /\[(inaudible|聞き取れない|不明瞭|聞き取り不能)\]|\(inaudible\)/i;

export function parseTranscript(text: string): Segment[] {
  const t = text.replace(/\r/g, '').replace(/^﻿/, '').trim();
  const blocks = t.split(/\n\s*\n/);
  const segs: Segment[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() && l.trim() !== 'WEBVTT');
    const tl = lines.findIndex((l) => l.includes('-->'));
    if (tl < 0) continue;
    const [a, z] = lines[tl].split('-->').map((x) => x.trim().split(' ')[0]);
    const body = lines.slice(tl + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!body) continue;
    segs.push({ idx: segs.length, startMs: tsToMs(a), endMs: tsToMs(z), text: body, inaudible: INAUDIBLE_RE.test(body) });
  }
  if (segs.length) return segs;
  // plain "[00:12] text" lines
  for (const line of t.split('\n')) {
    const m = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+(.+)$/.exec(line.trim());
    if (m) {
      const parts = m[1].split(':').map(Number);
      const ms = (parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]) * 1000;
      if (segs.length) segs[segs.length - 1].endMs = ms;
      segs.push({ idx: segs.length, startMs: ms, endMs: ms + 5000, text: m[2], inaudible: INAUDIBLE_RE.test(m[2]) });
    }
  }
  return segs;
}

function fmt(ms: number, sep: ',' | '.') {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
}

/** Build subtitle draft for a clip window; timestamps are re-based to clip start and validated monotonic. */
export function buildSubtitles(segments: Segment[], startMs: number, endMs: number, format: 'srt' | 'vtt'): string {
  const inWin = segments.filter((s) => s.endMs > startMs && s.startMs < endMs);
  let prevEnd = 0;
  const cues = inWin.map((s, i) => {
    const a = Math.max(prevEnd, Math.max(0, s.startMs - startMs));
    const z = Math.max(a + 1, Math.min(endMs, s.endMs) - startMs);
    prevEnd = z;
    const text = s.inaudible ? '[聞き取れない部分]' : s.text;
    return format === 'srt' ? `${i + 1}\n${fmt(a, ',')} --> ${fmt(z, ',')}\n${text}` : `${fmt(a, '.')} --> ${fmt(z, '.')}\n${text}`;
  });
  return format === 'srt' ? cues.join('\n\n') + '\n' : `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
