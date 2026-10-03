import { describe, it, expect } from 'vitest';
import { makeEnv } from './helpers.js';
import { notify, listNotifications, quietHoursEnd } from '../../server/src/domain/notifications.js';
import { updateSettings } from '../../server/src/domain/workspace.js';
import { validateUpload, parseCsv } from '../../server/src/lib/files.js';
import { MemoryStorage } from '../../server/src/lib/storage.js';
import { parseTranscript, buildSubtitles } from '../../server/src/ai/transcription.js';
import { buildUtm, capture } from '../../server/src/domain/misc.js';
import { platformLength } from '../../server/src/domain/platforms.js';
import { encryptSecret, decryptSecret } from '../../server/src/lib/util.js';

describe('notifications', () => {
  it('dedupes, caps per hour and defers during quiet hours', () => {
    const env = makeEnv({ now: '2026-10-01T03:00:00.000Z' }); // 12:00 JST
    updateSettings(env.ctx, { notificationMaxPerHour: 3, quietHours: { start: '22:00', end: '08:00' } });
    expect(notify(env.ctx, { kind: 'review_requested', message: 'a', dedupeKey: 'k1' })).toBeTruthy();
    expect(notify(env.ctx, { kind: 'review_requested', message: 'a', dedupeKey: 'k1' })).toBeNull();
    notify(env.ctx, { kind: 'review_requested', message: 'b' });
    notify(env.ctx, { kind: 'review_requested', message: 'c' });
    expect(notify(env.ctx, { kind: 'review_requested', message: 'd' })).toBeNull(); // storm cap
    // 23:30 JST → deferred to 08:00 JST next day
    expect(quietHoursEnd(new Date('2026-10-01T14:30:00Z'), 'Asia/Tokyo', { start: '22:00', end: '08:00' })).toBe('2026-10-01T23:00:00.000Z');
    expect(quietHoursEnd(new Date('2026-10-01T03:00:00Z'), 'Asia/Tokyo', { start: '22:00', end: '08:00' })).toBeNull();
    env.clock.set('2026-10-01T14:30:00Z');
    notify(env.ctx, { kind: 'schedule_failed', message: 'night' });
    expect(listNotifications(env.ctx).some((n: any) => n.message === 'night')).toBe(false);
    env.clock.set('2026-10-01T23:30:00Z');
    expect(listNotifications(env.ctx).some((n: any) => n.message === 'night')).toBe(true);
  });
});

describe('uploads / storage / transcript', () => {
  it('validates by magic bytes, not declared MIME', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0]);
    expect(validateUpload(png, 'application/pdf').mime).toBe('image/png');
    expect(() => validateUpload(new Uint8Array([0x4d, 0x5a, 0x90, 0]), 'image/png')).toThrow(); // exe disguised as png
    expect(() => validateUpload(new TextEncoder().encode('<script>'), 'text/html')).toThrow();
  });
  it('signed URLs expire and reject tampering', () => {
    const s = new MemoryStorage();
    const now = new Date('2026-10-01T00:00:00Z');
    const url = new URL('http://x' + s.signedUrl('ws/a', 60, now));
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig')!;
    expect(s.verify('ws/a', exp, sig, now)).toBe(true);
    expect(s.verify('ws/b', exp, sig, now)).toBe(false);
    expect(s.verify('ws/a', exp, sig, new Date(now.getTime() + 61_000))).toBe(false);
  });
  it('parses SRT/VTT and builds re-based clip subtitles with monotonic timestamps', () => {
    const segs = parseTranscript('WEBVTT\n\n00:00:10.000 --> 00:00:12.500\nこんにちは\n\n00:00:12.500 --> 00:00:15.000\n[inaudible]\n');
    expect(segs).toHaveLength(2);
    expect(segs[1].inaudible).toBe(true);
    const srt = buildSubtitles(segs, 10_000, 15_000, 'srt');
    expect(srt).toContain('00:00:00,000 --> 00:00:02,500');
    expect(srt).toContain('[聞き取れない部分]');
  });
  it('csv parser handles quotes/newlines; secrets round-trip encrypted', () => {
    expect(parseCsv('a,b\n"x, ""y""","line1\nline2"\n')).toEqual([{ a: 'x, "y"', b: 'line1\nline2' }]);
    const enc = encryptSecret('tok');
    expect(enc).not.toContain('tok');
    expect(decryptSecret(enc)).toBe('tok');
  });
});

describe('misc', () => {
  it('UTM builder and X weighted length', () => {
    expect(buildUtm({ url: 'https://example.com/p?a=1', source: 'Threads', campaign: 'New App Launch' }).url).toBe('https://example.com/p?a=1&utm_source=threads&utm_medium=social&utm_campaign=new_app_launch');
    expect(() => buildUtm({ url: 'javascript:alert(1)', source: 'x' })).toThrow();
    expect(platformLength('x', 'abc')).toBe(3);
    expect(platformLength('x', 'あいう')).toBe(6);
    expect(platformLength('threads', 'あいう')).toBe(3);
  });
  it('quick capture is idempotent per clientId (offline replay)', () => {
    const env = makeEnv();
    const a = capture(env.ctx, { text: 'メモ', clientId: 'c-1' });
    const b = capture(env.ctx, { text: 'メモ', clientId: 'c-1' });
    expect(b.duplicate).toBe(true);
    expect((b.item as any).id).toBe((a.item as any).id);
  });
});

describe('AI eligibility (privacy)', () => {
  it('a source marked not AI-eligible is never sent to an external provider (draft / strategist / translate)', async () => {
    const { FakeProvider, ARTICLE } = await import('./helpers.js');
    const { importSource } = await import('../../server/src/domain/sources.js');
    const { extractIdeas } = await import('../../server/src/domain/ideas.js');
    const { draftForPlatform, localize } = await import('../../server/src/domain/content.js');
    const { askStrategist } = await import('../../server/src/domain/search.js');
    const env = makeEnv();
    const fake = new FakeProvider('anthropic');
    env.app.ai.register(fake);
    updateSettings(env.ctx, { aiProvider: 'anthropic' });
    const s = await importSource(env.ctx, { type: 'article', title: '社内メモ', text: ARTICLE, rightsStatus: 'owned', aiEligible: false });
    const ideas = await extractIdeas(env.ctx, s.id);
    const d = await draftForPlatform(env.ctx, { ideaId: ideas[0].idea.id, platform: 'threads' });
    await askStrategist(env.ctx, 'まだ使ってないIdeaは？');
    await expect(localize(env.ctx, d.content.id, 'en')).rejects.toBeTruthy();
    expect(fake.calls).toHaveLength(0);
  });
});
