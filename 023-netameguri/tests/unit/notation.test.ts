// NetaMeguri 表記ゆれチェック: matching core (ported from the standalone notation checker's unit tests,
// TXT-relevant cases kept verbatim) + workspace dictionary / draft replacement / permissions.
import { describe, it, expect } from 'vitest';
import * as C from '../../server/src/lib/notation.js';
import { makeEnv, addMember } from './helpers.js';
import * as NT from '../../server/src/domain/notation.js';
import { createManualContent, getContent, listVersions, approve, requestReview } from '../../server/src/domain/content.js';
import { buildServer } from '../../server/src/api/server.js';
import { createUser, createWorkspace, ctxFor } from '../../server/src/domain/workspace.js';
import { backupWorkspace, restoreWorkspace } from '../../server/src/domain/io.js';

const rule = (correct: string, variants: string[], o: Partial<C.NotationRule> = {}) => C.createRule({ correct, variants, ...o });
const detectText = (text: string, rules: C.NotationRule[]) => {
  const doc = C.parseDocument(text);
  return { doc, ...C.detect(doc, rules) };
};

describe('notation core (port of the standalone checker)', () => {
  it('keeps each line EOL and round-trips byte-identically', () => {
    for (const t of ['a\r\nb\nc\rd', '', '\n\n', 'x\r\n']) expect(C.serializeDocument(C.parseDocument(t))).toBe(t);
  });

  it('line numbers / Japanese / emoji positions', () => {
    const rules = [rule('ChatGPT', ['Chat GPT']), rule('髙橋', ['高橋'])];
    let r = detectText('Chat GPT', rules);
    expect(r.findings.length).toBe(1);
    expect(r.findings[0].lineNo).toBe(1);
    r = detectText('一行目\n😀😀高橋さん\n三行目 Chat GPT', rules);
    expect(r.findings.map((f) => [f.lineNo, f.matched, f.correct])).toEqual([[2, '高橋', '髙橋'], [3, 'Chat GPT', 'ChatGPT']]);
    C.replaceFinding(r.doc, r.findings, r.findings[0]);
    expect(r.doc.lines[1].text).toBe('😀😀髙橋さん');
  });

  it('100 lines / empty text', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `${i + 1}行目 Youtube`);
    const r = detectText(lines.join('\n'), [rule('YouTube', ['Youtube'])]);
    expect(r.findings.length).toBe(100);
    expect(r.findings[99].lineNo).toBe(100);
    expect(detectText('', [rule('YouTube', ['Youtube'])]).findings.length).toBe(0);
  });

  it('never flags the correct form itself (even case-insensitive)', () => {
    const r = detectText('Excel excel EXCEL eXcel', [rule('Excel', ['excel'], { caseSensitive: false })]);
    expect(r.findings.map((f) => f.matched)).toEqual(['excel', 'EXCEL', 'eXcel']);
  });

  it('never flags a part of the correct form', () => {
    const r = detectText('株式会社サンプル と サンプル', [rule('株式会社サンプル', ['サンプル'])]);
    expect(r.findings.length).toBe(1);
    expect(r.findings[0].start).toBe(11);
  });

  it('case sensitivity ON/OFF', () => {
    expect(detectText('youtube YOUTUBE', [rule('YouTube', ['Youtube'])]).findings.length).toBe(0);
    expect(detectText('youtube YOUTUBE Youtube', [rule('YouTube', ['Youtube'], { caseSensitive: false })]).findings.length).toBe(3);
  });

  it('word mode uses ASCII-only boundaries; Japanese acts as a separator', () => {
    const w = [rule('Web', ['web'], { matchMode: 'word' })];
    const s = [rule('Web', ['web'], { matchMode: 'string' })];
    const text = 'web制作 website myweb web2 web_x web-site (web) 日本語webサイト';
    expect(detectText(text, w).findings.map((f) => f.start)).toEqual([0, 31, 41, 49]);
    expect(detectText(text, s).findings.length).toBe(8);
  });

  it('word mode: no boundary on symbol/Japanese edges', () => {
    expect(detectText('会社(株)サンプル', [rule('株式会社サンプル', ['(株)サンプル'], { matchMode: 'word' })]).findings.length).toBe(1);
  });

  it('regex special characters and hyphen are literal', () => {
    const rules = [rule('メールアドレス', ['e-mailアドレス']), rule('C++', ['c++']), rule('a.b', ['a*b']), rule('[x]', ['(x)'])];
    const r = detectText('e-mailアドレス c++ a*b axb (x) [x]', rules);
    expect(r.findings.map((f) => f.matched)).toEqual(['e-mailアドレス', 'c++', 'a*b', '(x)']);
  });

  it('overlaps prefer the longer variant', () => {
    const r = detectText('Chat GPT と GPT', [rule('ChatGPT', ['Chat GPT']), rule('GPT-4', ['GPT'])]);
    expect(r.findings.map((f) => f.matched)).toEqual(['Chat GPT', 'GPT']);
  });

  it('no Unicode normalization: full-width only matches when registered', () => {
    expect(detectText('ＹｏｕＴｕｂｅ Ｙｏｕｔｕｂｅ', [rule('YouTube', ['Youtube'])]).findings.length).toBe(0);
    expect(detectText('Ｙｏｕｔｕｂｅ', [rule('YouTube', ['Ｙｏｕｔｕｂｅ'])]).findings.length).toBe(1);
  });

  it('per-hit replace shifts later hits; double replace refused', () => {
    const r = detectText('(株)サンプル と (株)サンプル と (株)サンプル', [rule('株式会社サンプル', ['(株)サンプル'])]);
    expect(r.findings.length).toBe(3);
    expect(C.replaceFinding(r.doc, r.findings, r.findings[1]).ok).toBe(true);
    expect(C.replaceFinding(r.doc, r.findings, r.findings[2]).ok).toBe(true);
    expect(r.doc.lines[0].text).toBe('(株)サンプル と 株式会社サンプル と 株式会社サンプル');
    expect(C.replaceFinding(r.doc, r.findings, r.findings[1]).ok).toBe(false);
  });

  it('ignore keys survive re-check, also after a length-changing replace', () => {
    const rules = [rule('株式会社サンプル', ['(株)サンプル'])];
    const r = detectText('(株)サンプル / (株)サンプル', rules);
    r.findings[1].status = 'ignored';
    C.replaceFinding(r.doc, r.findings, r.findings[0]);
    expect(r.doc.lines[0].text.slice(r.findings[1].start, r.findings[1].end)).toBe('(株)サンプル');
    const again = C.detect(r.doc, rules, { ignoredKeys: { [C.findingKey(r.findings[1])]: true } });
    expect(again.findings.length).toBe(1);
    expect(again.findings[0].status).toBe('ignored');
  });

  it('refuses when the text changed', () => {
    const r = detectText('Youtube', [rule('YouTube', ['Youtube'])]);
    r.doc.lines[0].text = 'changed';
    expect(C.replaceFinding(r.doc, r.findings, r.findings[0]).ok).toBe(false);
  });

  it('conflicts are detected and never replaced', () => {
    let rules = [rule('YouTube', ['Youtube']), rule('YOUTUBE', ['Youtube'])];
    expect(C.analyzeDictionary(rules).conflicts.length).toBe(1);
    const r = detectText('Youtube', rules);
    expect(r.findings[0].conflict).toBe(true);
    expect(r.findings[0].correct).toBe('YouTube / YOUTUBE');
    expect(C.replaceFinding(r.doc, r.findings, r.findings[0]).ok).toBe(false);
    rules = [rule('YouTube', ['Youtube']), rule('Youtube', ['YOUTUBE'])];
    expect(C.analyzeDictionary(rules).conflicts[0].type).toBe('variant-is-correct');
    expect(C.analyzeDictionary([rule('A', ['x']), rule('A', ['x'])]).conflicts.length).toBe(0);
    expect(C.analyzeDictionary([rule('YouTube', ['Youtube']), rule('YOUTUBE', ['Youtube'], { enabled: false })]).conflicts.length).toBe(0);
  });

  it('rule validation: errors and 1-char warnings', () => {
    expect(C.validateRule(rule('', ['a'])).errors.length).toBeGreaterThan(0);
    expect(C.validateRule(rule('A', [])).errors.length).toBeGreaterThan(0);
    expect(C.validateRule(rule('ChatGPT', ['ChatGPT'])).errors.some((e) => e.includes('同じ'))).toBe(true);
    expect(C.validateRule(rule('ChatGPT', ['Chat GPT', 'Chat GPT'])).errors.some((e) => e.includes('重複'))).toBe(true);
    const w = C.validateRule(rule('髙', ['高']));
    expect(w.errors.length).toBe(0);
    expect(w.warnings.length).toBe(2);
    expect(C.parseVariantLines(' a \r\n\nb\n  \n c')).toEqual(['a', 'b', 'c']);
    expect(detectText('Youtube', [rule('YouTube', ['Youtube'], { enabled: false })]).findings.length).toBe(0);
  });

  it('dictionary JSON round-trips and rejects broken/unsupported files', () => {
    const dict = { name: 'テスト', rules: [rule('ChatGPT', ['Chat GPT', 'chatGPT'], { caseSensitive: false, matchMode: 'word', enabled: false })] };
    const res = C.parseDictionaryJson(C.dictionaryToJson(dict));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.dictionary).toEqual(dict);
    const bad = [
      '{', 'null', '[]', '"x"', '{}', '{"schemaVersion":2,"rules":[]}', '{"schemaVersion":"1","rules":[]}', '{"schemaVersion":1}',
      '{"schemaVersion":1,"rules":{}}', '{"schemaVersion":1,"rules":[{"correct":"","variants":["a"]}]}',
      '{"schemaVersion":1,"rules":[{"correct":"A","variants":[]}]}', '{"schemaVersion":1,"rules":[{"correct":"A","variants":[1]}]}',
      '{"schemaVersion":1,"rules":[{"correct":"A","variants":["A"]}]}', '{"schemaVersion":1,"rules":[{"correct":"A","variants":["b"],"caseSensitive":"yes"}]}',
      '{"schemaVersion":1,"rules":[{"correct":"A","variants":["b"],"matchMode":"regex"}]}',
      '{"schemaVersion":1,"rules":[{"ruleId":"x","correct":"A","variants":["b"]},{"ruleId":"x","correct":"B","variants":["c"]}]}',
      '{"schemaVersion":1,"name":5,"rules":[]}',
    ];
    for (const b of bad) expect(C.parseDictionaryJson(b).ok, b).toBe(false);
    const ok = C.parseDictionaryJson('{"schemaVersion":1,"rules":[{"correct":"A","variants":["b"]}]}');
    expect(ok.ok && ok.dictionary.rules[0].caseSensitive && ok.dictionary.rules[0].matchMode === 'string' && ok.dictionary.name === '無題の辞書').toBe(true);
  });

  it('performance: 100 rules / 500 variants / 100k chars', () => {
    const rules = Array.from({ length: 100 }, (_, i) => rule(`Term${i}X`, Array.from({ length: 5 }, (_, k) => `term${i}v${k}`), { matchMode: 'word' }));
    const text = Array.from({ length: 4000 }, (_, i) => `行${i} term${i % 100}v${i % 5} と日本語の文章です。`).join('\n');
    const t0 = Date.now();
    const r = detectText(text.slice(0, 100_000), rules);
    expect(r.findings.length).toBeGreaterThan(1000);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('NetaMeguri 表記ゆれチェック (workspace dictionary + drafts)', () => {
  const setup = () => {
    const env = makeEnv();
    NT.addRule(env.ctx, { correct: 'YouTube', variants: 'Youtube\nyoutube', matchMode: 'word' });
    NT.addRule(env.ctx, { correct: '株式会社サンプル', variants: ['(株)サンプル', '㈱サンプル'] });
    const c = createManualContent(env.ctx, { platform: 'threads', body: 'Youtubeで紹介。(株)サンプル と ㈱サンプル\n二行目 youtube と Youtube' });
    return { env, c };
  };

  it('stores rules per workspace and lists hits with context', () => {
    const { env, c } = setup();
    const d = NT.getDictionary(env.ctx);
    expect(d.rules.length).toBe(2);
    const r = NT.checkContent(env.ctx, c.id);
    expect(r.counts.total).toBe(5);
    expect(r.findings[0]).toMatchObject({ lineNo: 1, matched: 'Youtube', correct: 'YouTube', key: '0:0:Youtube' });
    expect(r.findings[0].context.after.startsWith('で紹介')).toBe(true);
    expect(r.groups.find((g) => g.matched === 'Youtube')?.total).toBe(2);
    // another workspace does not see this dictionary
    const u = createUser(env.app.db, 'other@example.com', 'O', 'password-123456', env.clock.now());
    const ws2 = createWorkspace(env.app.db, u.id, 'WS B', env.clock.now());
    expect(NT.getDictionary(ctxFor(env.app, u.id, ws2)).rules.length).toBe(0);
    expect(() => NT.checkContent(ctxFor(env.app, u.id, ws2), c.id)).toThrow(/not found/);
  });

  it('per-hit replace and bulk replace save a new version; ignored hits are kept', () => {
    const { env, c } = setup();
    const first = NT.checkContent(env.ctx, c.id);
    const ignoredKey = first.findings.find((f) => f.lineNo === 2 && f.matched === 'Youtube')!.key;
    const one = NT.replaceInContent(env.ctx, c.id, { mode: 'one', key: first.findings.find((f) => f.matched === '(株)サンプル')!.key, expectedVersion: first.version, ignoredKeys: [ignoredKey] });
    expect(one.replaced).toBe(1);
    expect(getContent(env.ctx, c.id).body).toBe('Youtubeで紹介。株式会社サンプル と ㈱サンプル\n二行目 youtube と Youtube');
    expect(one.version).toBe(2);
    const bulk = NT.replaceInContent(env.ctx, c.id, { mode: 'group', matched: 'Youtube', correct: 'YouTube', ignoredKeys: [ignoredKey] });
    expect(bulk.replaced).toBe(1); // line-2 "Youtube" is ignored
    expect(getContent(env.ctx, c.id).body).toBe('YouTubeで紹介。株式会社サンプル と ㈱サンプル\n二行目 youtube と Youtube');
    expect(listVersions(env.ctx, c.id).length).toBe(3);
    const again = NT.checkContent(env.ctx, c.id, [ignoredKey]);
    expect(again.findings.map((f) => [f.matched, f.status])).toEqual([['㈱サンプル', 'pending'], ['youtube', 'pending'], ['Youtube', 'ignored']]);
    expect(() => NT.replaceInContent(env.ctx, c.id, { mode: 'one', key: ignoredKey, ignoredKeys: [ignoredKey] })).toThrow();
    expect(() => NT.replaceInContent(env.ctx, c.id, { mode: 'one', key: again.findings[0].key, expectedVersion: 1 })).toThrow(/他の編集/);
  });

  it('replacing on an approved draft sends it back to review (existing re-review rule)', async () => {
    const { env, c } = setup();
    requestReview(env.ctx, c.id);
    await approve(env.ctx, c.id);
    const res = NT.replaceInContent(env.ctx, c.id, { mode: 'group', matched: 'youtube', correct: 'YouTube' });
    expect(res.reReviewRequired).toBe(true);
    expect(getContent(env.ctx, c.id).status).toBe('needs_review');
  });

  it('conflicting rules are listed but not replaced', () => {
    const env = makeEnv();
    NT.addRule(env.ctx, { correct: 'YouTube', variants: ['Youtube'] });
    NT.addRule(env.ctx, { correct: 'YOUTUBE', variants: ['Youtube'] });
    expect(NT.getDictionary(env.ctx).conflicts.length).toBe(1);
    const c = createManualContent(env.ctx, { platform: 'x', body: 'Youtube' });
    const r = NT.checkContent(env.ctx, c.id);
    expect(r.findings[0].conflict).toBe(true);
    expect(NT.replaceInContent(env.ctx, c.id, { mode: 'group', matched: 'Youtube', correct: 'YouTube / YOUTUBE' }).replaced).toBe(0);
    expect(() => NT.replaceInContent(env.ctx, c.id, { mode: 'one', key: r.findings[0].key })).toThrow(/競合/);
  });

  it('import is all-or-nothing; export is importable by the standalone tool format', () => {
    const { env } = setup();
    expect(() => NT.importDictionary(env.ctx, { json: '{"schemaVersion":1,"rules":[{"correct":"A","variants":["A"]}]}' })).toThrow();
    expect(NT.getDictionary(env.ctx).rules.length).toBe(2);
    const exported = NT.exportDictionary(env.ctx);
    const parsed = JSON.parse(exported.body);
    expect(parsed).toMatchObject({ schemaVersion: 1, app: 'notation-checker' });
    const imported = NT.importDictionary(env.ctx, { json: JSON.stringify({ schemaVersion: 1, name: '社内辞書', rules: [{ correct: 'Web', variants: ['web'], matchMode: 'word' }] }) });
    expect(imported.name).toBe('社内辞書');
    expect(imported.rules.length).toBe(1);
    expect(() => NT.addRule(env.ctx, { correct: 'X', variants: ['X'] })).toThrow();
  });

  it('permissions: viewer reads, reviewer checks, editor replaces, only admin/owner edits the dictionary', () => {
    const { env, c } = setup();
    const viewer = addMember(env, 'v@example.com', 'viewer');
    const reviewer = addMember(env, 'r@example.com', 'reviewer');
    const editor = addMember(env, 'e@example.com', 'editor');
    const admin = addMember(env, 'a@example.com', 'admin');
    expect(NT.getDictionary(viewer).rules.length).toBe(2);
    expect(NT.checkContent(reviewer, c.id).counts.total).toBe(5);
    expect(() => NT.replaceInContent(reviewer, c.id, { mode: 'group', matched: 'youtube', correct: 'YouTube' })).toThrow(/権限/);
    expect(() => NT.replaceInContent(viewer, c.id, { mode: 'group', matched: 'youtube', correct: 'YouTube' })).toThrow(/権限/);
    expect(NT.replaceInContent(editor, c.id, { mode: 'group', matched: 'youtube', correct: 'YouTube' }).replaced).toBe(1);
    expect(() => NT.addRule(editor, { correct: 'A', variants: ['a'] })).toThrow(/権限/);
    expect(() => NT.importDictionary(editor, { json: '{"schemaVersion":1,"rules":[]}' })).toThrow(/権限/);
    expect(NT.addRule(admin, { correct: 'A', variants: ['aa'] }).dictionary.rules.length).toBe(3);
    expect(() => NT.exportDictionary(viewer)).toThrow(/権限/);
  });

  it('dictionary is included in workspace backup / restore', () => {
    const { env } = setup();
    const zip = backupWorkspace(env.ctx);
    const ws2 = createWorkspace(env.app.db, env.owner.id, 'Restore target', env.clock.now());
    const ctx2 = ctxFor(env.app, env.owner.id, ws2);
    NT.addRule(ctx2, { correct: 'Z', variants: ['zz'] }); // pre-existing dictionary is replaced, not duplicated
    restoreWorkspace(ctx2, zip);
    expect(NT.getDictionary(ctx2).rules.map((r) => r.correct)).toEqual(['YouTube', '株式会社サンプル']);
  });

  it('HTTP: routes enforce auth, CSRF and roles', async () => {
    const { env, c } = setup();
    addMember(env, 'viewer@example.com', 'viewer');
    const f = await buildServer(env.app);
    const login = async (email: string) => {
      const res = await f.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password-123456' } });
      return { cookies: { cl_session: res.cookies.find((x: any) => x.name === 'cl_session')!.value }, csrf: res.json().csrfToken as string };
    };
    expect((await f.inject({ method: 'GET', url: `/api/w/${env.ws}/notation/dictionary` })).statusCode).toBe(401);
    const v = await login('viewer@example.com');
    expect((await f.inject({ method: 'GET', url: `/api/w/${env.ws}/notation/dictionary`, cookies: v.cookies })).json().rules.length).toBe(2);
    expect((await f.inject({ method: 'POST', url: `/api/w/${env.ws}/notation/rules`, cookies: v.cookies, headers: { 'x-csrf-token': v.csrf }, payload: { correct: 'A', variants: ['b'] } })).statusCode).toBe(403);
    const o = await login('owner@example.com');
    expect((await f.inject({ method: 'POST', url: `/api/w/${env.ws}/notation/rules`, cookies: o.cookies, payload: { correct: 'A', variants: ['b'] } })).statusCode).toBe(403); // no CSRF
    const ok = await f.inject({ method: 'POST', url: `/api/w/${env.ws}/notation/rules`, cookies: o.cookies, headers: { 'x-csrf-token': o.csrf }, payload: { correct: 'A', variants: ['bb'] } });
    expect(ok.statusCode).toBe(200);
    const chk = await f.inject({ method: 'POST', url: `/api/w/${env.ws}/content/${c.id}/notation/check`, cookies: v.cookies, headers: { 'x-csrf-token': v.csrf }, payload: {} });
    expect(chk.json().counts.total).toBe(5);
    const exp = await f.inject({ method: 'GET', url: `/api/w/${env.ws}/notation/export.json`, cookies: o.cookies });
    expect(exp.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(JSON.parse(exp.body).rules.length).toBe(3);
    const bad = await f.inject({ method: 'POST', url: `/api/w/${env.ws}/notation/import`, cookies: o.cookies, headers: { 'x-csrf-token': o.csrf }, payload: { json: '{' } });
    expect(bad.statusCode).toBe(400);
    const scan = await f.inject({ method: 'GET', url: `/api/w/${env.ws}/notation/scan`, cookies: v.cookies });
    expect(scan.json().items[0]).toMatchObject({ contentId: c.id, hits: 5 });
    await f.close();
  });
});
