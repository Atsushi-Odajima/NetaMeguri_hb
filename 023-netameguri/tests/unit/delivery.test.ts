// NetaMeguri 納品パック: ZIP layout / naming (ported from the standalone delivery pack maker), whitelist, permissions.
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { makeEnv, addMember } from './helpers.js';
import * as DP from '../../server/src/domain/delivery.js';
import { createManualContent, addComment } from '../../server/src/domain/content.js';
import { uploadMedia } from '../../server/src/domain/misc.js';
import { createCampaign } from '../../server/src/domain/campaigns.js';
import { buildServer } from '../../server/src/api/server.js';
import { createUser, createWorkspace, ctxFor } from '../../server/src/domain/workspace.js';

const PNG = (seed: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, 1, 2, 3]);
const JPG = (seed: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, seed, 9, 9, 9]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const td = new TextDecoder('utf-8', { ignoreBOM: true });

/** Central-directory scan: name, general-purpose flag and compression method of each entry. */
function centralEntries(zip: Uint8Array) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let off = dv.getUint32(eocd + 16, true);
  const n = dv.getUint16(eocd + 10, true);
  const out: { name: string; flag: number; method: number; extra: number[] }[] = [];
  for (let i = 0; i < n; i++) {
    const flag = dv.getUint16(off + 8, true);
    const method = dv.getUint16(off + 10, true);
    const fl = dv.getUint16(off + 28, true);
    const el = dv.getUint16(off + 30, true);
    const cl = dv.getUint16(off + 32, true);
    const name = new TextDecoder().decode(zip.subarray(off + 46, off + 46 + fl));
    const ids: number[] = [];
    for (let p = off + 46 + fl; p < off + 46 + fl + el; ) {
      ids.push(dv.getUint16(p, true));
      p += 4 + dv.getUint16(p + 2, true);
    }
    out.push({ name, flag, method, extra: ids });
    off += 46 + fl + el + cl;
  }
  return out;
}

async function setup() {
  const env = makeEnv(); // 2026-10-01T03:00Z = 12:00 JST, workspace tz Asia/Tokyo
  const a = createManualContent(env.ctx, { platform: 'instagram', title: '新商品紹介', body: '=SUM(A1)\n本文 <b>太字</b>\r\n😀' });
  const b = createManualContent(env.ctx, { platform: 'threads', body: '二つ目の投稿' });
  env.app.db.run('UPDATE content_items SET scheduled_at = ? WHERE id = ?', '2026-10-05T00:30:00.000Z', a.id); // 09:30 JST
  env.app.db.run('UPDATE content_items SET scheduled_at = ? WHERE id = ?', '2026-10-03T10:00:00.000Z', b.id); // 19:00 JST
  await uploadMedia(env.ctx, { data: JPG(1), declaredMime: 'image/jpeg', filename: 'Photo.JPEG', contentId: a.id });
  await uploadMedia(env.ctx, { data: PNG(2), declaredMime: 'image/png', filename: 'wrong-ext.jpg', contentId: a.id });
  await uploadMedia(env.ctx, { data: GIF, declaredMime: 'image/gif', filename: 'anim.gif', contentId: a.id });
  addComment(env.ctx, a.id, '社内メモ: クライアントには見せない');
  return { env, a, b };
}

describe('NetaMeguri 納品パック (pure builder)', () => {
  it('reuses the original naming: folder, 3-digit posts, NNN_MM.ext, BOM+CRLF txt, quoted CSV', () => {
    const pk = DP.buildDeliveryPack(
      [
        { date: '2026-10-05', time: '09:30', title: 'T', body: 'a\r\nb', images: [{ bytes: JPG(1), originalName: 'x.jpg', ext: 'jpg' }, { bytes: PNG(1), originalName: 'y.png', ext: 'png' }], memo: 'SECRET-MEMO' },
        { date: null, time: null, title: null, body: '', images: [] },
      ],
      '2026-10-01T12:00',
    );
    expect(pk.fileName).toBe('SNS納品パック_2026-10-01.zip');
    expect(pk.files).toEqual([
      'SNS納品パック_2026-10-01/001/001_01.jpg', 'SNS納品パック_2026-10-01/001/001_02.png', 'SNS納品パック_2026-10-01/001/投稿文.txt',
      'SNS納品パック_2026-10-01/002/投稿文.txt', 'SNS納品パック_2026-10-01/投稿一覧.csv', 'SNS納品パック_2026-10-01/確認用一覧.html',
    ]);
    const z = unzipSync(pk.zip);
    expect(Object.keys(z)).toContain('SNS納品パック_2026-10-01/001/');
    const txt = td.decode(z['SNS納品パック_2026-10-01/001/投稿文.txt']);
    expect(txt.startsWith('﻿投稿番号：001\r\n投稿日：2026/10/05\r\n投稿時間：09:30\r\n管理タイトル：T\r\n画像：001_01.jpg、001_02.png\r\n\r\n【投稿本文】\r\n\r\na\r\nb\r\n')).toBe(true);
    const empty = td.decode(z['SNS納品パック_2026-10-01/002/投稿文.txt']);
    expect(empty).toContain('投稿日：（未設定）');
    expect(empty).toContain('（本文なし）');
    expect(td.decode(z['SNS納品パック_2026-10-01/投稿一覧.csv']).split('\r\n')[0]).toBe('﻿"投稿番号","投稿日","投稿時間","管理タイトル","投稿本文","画像枚数"');
    // whitelist: internal fields never reach the archive
    expect(Buffer.from(pk.zip).includes(Buffer.from('SECRET-MEMO'))).toBe(false);
    // images stored byte-identical, STORE method, UTF-8 flag + Info-ZIP Unicode Path on Japanese names
    expect([...z['SNS納品パック_2026-10-01/001/001_02.png']]).toEqual([...PNG(1)]);
    for (const e of centralEntries(pk.zip)) {
      expect(e.method).toBe(0);
      if (/[^\x20-\x7e]/.test(e.name)) {
        expect(e.flag & 0x800).toBe(0x800);
        expect(e.extra).toContain(0x7075);
      }
    }
  });

  it('CSV guards formula injection; HTML escapes input and uses relative image paths', () => {
    const recs = [DP.toDeliveryRecord({ date: '2026-10-05', time: '', title: '@cmd', body: '<script>alert(1)</script> "q"', images: [{ bytes: PNG(1), originalName: 'p.png', ext: 'png' }] }, 0)];
    const csv = DP.buildCsv(recs);
    expect(csv).toContain('"\'@cmd"');
    expect(csv).toContain('"<script>alert(1)</script> ""q"""');
    const html = DP.buildReviewHtml(recs, 'SNS納品パック_2026-10-01', '2026-10-01T12:00');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('src="001/001_01.png"');
    expect(html).toContain('作成日時 2026/10/01 12:00');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('extension rule: keep lower-cased name ext unless the content disagrees; JPG/PNG/WEBP only', () => {
    expect(DP.imageExt('Photo.JPEG', 'image/jpeg')).toBe('jpeg');
    expect(DP.imageExt('a.JPG', 'image/jpeg')).toBe('jpg');
    expect(DP.imageExt('a.png', 'image/jpeg')).toBe('jpg');
    expect(DP.imageExt('wrong.jpg', 'image/png')).toBe('png');
    expect(DP.imageExt('noext', 'image/webp')).toBe('webp');
    expect(DP.imageExt('a.gif', 'image/gif')).toBeNull();
  });
});

describe('NetaMeguri 納品パック (workspace export)', () => {
  it('exports selected drafts with workspace-local date/time, images in order, no comments leaked', async () => {
    const { env, a, b } = await setup();
    const prev = DP.previewDeliveryPack(env.ctx, { contentIds: [b.id, a.id] });
    expect(prev.posts.map((p) => [p.no, p.date, p.time, p.images])).toEqual([['001', '2026/10/03', '19:00', 0], ['002', '2026/10/05', '09:30', 2]]);
    expect(prev.posts[1].warnings.some((w) => w.includes('JPG/PNG/WEBP以外'))).toBe(true);
    expect(prev.posts[0].warnings).toContain('画像が未登録');
    const pk = await DP.exportDeliveryPack(env.ctx, { contentIds: [b.id, a.id] });
    const z = unzipSync(pk.zip);
    const root = 'SNS納品パック_2026-10-01/';
    expect(Object.keys(z).filter((k) => !k.endsWith('/')).sort()).toEqual([root + '001/投稿文.txt', root + '002/002_01.jpeg', root + '002/002_02.png', root + '002/投稿文.txt', root + '投稿一覧.csv', root + '確認用一覧.html'].sort());
    expect([...z[root + '002/002_01.jpeg']]).toEqual([...JPG(1)]);
    expect(td.decode(z[root + '001/投稿文.txt'])).toContain('管理タイトル：Threads（通常投稿）');
    const all = Object.values(z).map((u) => strFromU8(u)).join('\n');
    expect(all).not.toContain('社内メモ');
    expect(all).toContain("'=SUM(A1)");
    const audit = env.app.db.get("SELECT * FROM audit_logs WHERE action = 'delivery_pack.exported'")!;
    expect(JSON.parse(audit.meta)).toMatchObject({ posts: 2, images: 2 });
    expect(audit.meta).not.toContain('SUM');
  });

  it('caps images at 10 per post', async () => {
    const env = makeEnv();
    const c = createManualContent(env.ctx, { platform: 'instagram', body: 'many' });
    for (let i = 0; i < 12; i++) await uploadMedia(env.ctx, { data: PNG(i), declaredMime: 'image/png', filename: `i${i}.png`, contentId: c.id });
    const z = unzipSync((await DP.exportDeliveryPack(env.ctx, { contentIds: [c.id] })).zip);
    const imgs = Object.keys(z).filter((k) => k.endsWith('.png'));
    expect(imgs.length).toBe(10);
    expect(imgs.at(-1)).toMatch(/001\/001_10\.png$/);
  });

  it('campaign selection: non-archived items ordered by date', async () => {
    const { env, a, b } = await setup();
    const cmp = createCampaign(env.ctx, { name: '秋キャンペーン' });
    env.app.db.run('UPDATE content_items SET campaign_id = ? WHERE id IN (?, ?)', cmp.id, a.id, b.id);
    const prev = DP.previewDeliveryPack(env.ctx, { campaignId: cmp.id });
    expect(prev.posts.map((p) => p.contentId)).toEqual([b.id, a.id]);
    expect(() => DP.previewDeliveryPack(env.ctx, {})).toThrow();
    expect(() => DP.previewDeliveryPack(env.ctx, { campaignId: cmp.id, contentIds: [a.id] })).toThrow();
  });

  it('permissions and tenant isolation', async () => {
    const { env, a } = await setup();
    const reviewer = addMember(env, 'r@example.com', 'reviewer');
    const viewer = addMember(env, 'v@example.com', 'viewer');
    const editor = addMember(env, 'e@example.com', 'editor');
    await expect(DP.exportDeliveryPack(reviewer, { contentIds: [a.id] })).rejects.toThrow(/権限/);
    expect(() => DP.previewDeliveryPack(viewer, { contentIds: [a.id] })).toThrow(/権限/);
    expect((await DP.exportDeliveryPack(editor, { contentIds: [a.id] })).files.length).toBeGreaterThan(0);
    const u = createUser(env.app.db, 'x@example.com', 'X', 'password-123456', env.clock.now());
    const ws2 = createWorkspace(env.app.db, u.id, 'B', env.clock.now());
    await expect(DP.exportDeliveryPack(ctxFor(env.app, u.id, ws2), { contentIds: [a.id] })).rejects.toThrow(/not found/);
  });

  it('HTTP: GET zip with UTF-8 filename, 403 for reviewers', async () => {
    const { env, a } = await setup();
    addMember(env, 'rev@example.com', 'reviewer');
    const f = await buildServer(env.app);
    const login = async (email: string) => ({ cl_session: (await f.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password-123456' } })).cookies.find((x: any) => x.name === 'cl_session')!.value });
    const owner = await login('owner@example.com');
    const res = await f.inject({ method: 'GET', url: `/api/w/${env.ws}/delivery-pack.zip?contentIds=${a.id}`, cookies: owner });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('SNS納品パック_2026-10-01.zip')}`);
    expect(Object.keys(unzipSync(new Uint8Array(res.rawPayload))).length).toBeGreaterThan(3);
    const rev = await login('rev@example.com');
    expect((await f.inject({ method: 'GET', url: `/api/w/${env.ws}/delivery-pack.zip?contentIds=${a.id}`, cookies: rev })).statusCode).toBe(403);
    expect((await f.inject({ method: 'GET', url: `/api/w/${env.ws}/delivery-pack.zip?contentIds=${a.id}` })).statusCode).toBe(401);
    await f.close();
  });
});
