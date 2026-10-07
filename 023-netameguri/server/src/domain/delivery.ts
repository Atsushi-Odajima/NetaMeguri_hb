// NetaMeguri 納品パック: client delivery ZIP for selected drafts / a Content Pack / a Campaign.
// Layout and file naming are ported from the standalone SNS delivery pack maker (app/export.js):
//
//   SNS納品パック_YYYY-MM-DD/
//     001/001_01.jpg … 001_10.png   images (original bytes, STORE / no recompression)
//     001/投稿文.txt                 UTF-8 BOM + CRLF
//     002/…
//     投稿一覧.csv                   UTF-8 BOM + CRLF, every cell quoted, formula-injection guarded
//     確認用一覧.html                inline CSS, no JS, relative image paths
//
// Internal data never leaks: toDeliveryRecord() is a whitelist (no, date, time, title, body, images).
// Comments, review history, AI suggestions, structured notes, claims etc. are dropped before any file is built.
import { zipSync } from 'fflate';
import { badRequest, utcToZoned } from '../lib/util.js';
import { audit, getScoped, getTimezone, requirePerm, type Ctx } from './context.js';
import { getContent, listContent, type ContentItem } from './content.js';
import { PLATFORMS } from './platforms.js';

const FORMAT_LABELS: Record<string, string> = { post: '通常投稿', thread: 'スレッド', carousel: 'カルーセル', short_video: 'ショート動画', article: '記事', newsletter: 'ニュースレター', quote: '引用', caption: 'キャプション' };

const BOM = '﻿';
const CRLF = '\r\n';
export const MAX_IMAGES_PER_POST = 10;
export const MAX_POSTS = 999; // 3-digit post numbers (same limit as the original tool)

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const postNumber = (index: number) => pad(index + 1, 3);

/** 'YYYY-MM-DD' → 'YYYY/MM/DD' */
export function formatDate(value: string | null | undefined) {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : value;
}
const normalizeNewlines = (t: string | null | undefined) => String(t || '').replace(/\r\n?/g, '\n');

export interface DeliveryImage {
  bytes: Uint8Array;
  originalName: string;
  ext: string;
}
/** A post as handed to the pack builder (still may carry internal fields — they are dropped by toDeliveryRecord). */
export interface DeliveryPostInput {
  date: string | null; // YYYY-MM-DD (workspace timezone)
  time: string | null; // HH:MM
  title: string | null;
  body: string;
  images: DeliveryImage[];
  [internal: string]: unknown;
}
export interface DeliveryRecord {
  no: string;
  date: string;
  time: string;
  title: string;
  body: string;
  images: { bytes: Uint8Array; originalName: string; fileName: string }[];
}

/** Whitelist: only these fields may be delivered. Anything else on the input is discarded here. */
export function toDeliveryRecord(post: DeliveryPostInput, index: number): DeliveryRecord {
  const no = postNumber(index);
  return {
    no,
    date: formatDate(post.date),
    time: post.time || '',
    title: post.title || '',
    body: normalizeNewlines(post.body),
    images: (post.images || []).map((img, i) => ({ bytes: img.bytes, originalName: img.originalName, fileName: `${no}_${pad(i + 1, 2)}.${img.ext}` })),
  };
}

export function buildPostText(rec: DeliveryRecord) {
  const lines = [
    '投稿番号：' + rec.no,
    '投稿日：' + (rec.date || '（未設定）'),
    '投稿時間：' + (rec.time || '（指定なし）'),
    '管理タイトル：' + (rec.title || '（なし）'),
    '画像：' + (rec.images.length ? rec.images.map((im) => im.fileName).join('、') : '（なし）'),
    '',
    '【投稿本文】',
    '',
    rec.body ? rec.body : '（本文なし）',
    '',
  ];
  return BOM + lines.join('\n').replace(/\n/g, CRLF);
}

function csvCell(value: unknown) {
  let s = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // Excel formula injection guard
  return '"' + s.replace(/"/g, '""') + '"';
}

export function buildCsv(records: DeliveryRecord[]) {
  const rows: string[][] = [['投稿番号', '投稿日', '投稿時間', '管理タイトル', '投稿本文', '画像枚数']];
  for (const r of records) rows.push([r.no, r.date, r.time, r.title, r.body, String(r.images.length)]);
  return BOM + rows.map((row) => row.map(csvCell).join(',')).join(CRLF) + CRLF;
}

const esc = (s: unknown) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const REVIEW_CSS = [
  '*{box-sizing:border-box}',
  'body{margin:0;background:#f4f5f7;color:#1f2933;font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Meiryo",system-ui,sans-serif;line-height:1.7;font-size:15px}',
  'main{max-width:1080px;margin:0 auto;padding:32px 24px 64px}',
  'h1{font-size:24px;margin:0 0 6px}',
  'h2{font-size:17px;margin:0 0 12px}',
  'h3{font-size:13px;color:#52606d;margin:0 0 8px;font-weight:600}',
  '.summary{margin:0;color:#52606d}',
  '.note{margin:8px 0 0;font-size:12px;color:#7b8794}',
  '.page-head{margin-bottom:24px}',
  '.toc,.post{background:#fff;border:1px solid #e1e4e8;border-radius:10px;padding:20px 24px;margin-bottom:20px}',
  'table{width:100%;border-collapse:collapse;font-size:14px}',
  'th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f2;vertical-align:top}',
  'th{background:#f7f8fa;color:#52606d;font-weight:600;font-size:12px}',
  'td.num a{font-weight:700;color:#0b6e6e;text-decoration:none;font-variant-numeric:tabular-nums}',
  'td.center{text-align:center}',
  '.post-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 20px;padding-bottom:12px;border-bottom:1px solid #eef0f2;margin-bottom:16px}',
  '.no{font-size:22px;font-weight:800;color:#0b6e6e;font-variant-numeric:tabular-nums}',
  '.meta{font-variant-numeric:tabular-nums}',
  '.label{font-size:11px;color:#7b8794;margin-right:6px}',
  '.title{font-weight:700;font-size:16px}',
  '.post-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}',
  '@media (max-width:760px){.post-body{grid-template-columns:1fr}}',
  '.images{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}',
  'figure{margin:0}',
  'figure img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:6px;border:1px solid #e1e4e8;background:#f0f2f4;display:block}',
  'figcaption{font-size:11px;color:#7b8794;margin-top:3px;word-break:break-all}',
  '.body{white-space:pre-wrap;word-break:break-word;background:#fafbfc;border:1px solid #eef0f2;border-radius:6px;padding:12px 14px}',
  '.folder{font-size:12px;color:#7b8794;margin:8px 0 0}',
  '.muted{color:#9aa5b1}',
  '.noimg{margin:0}',
  '@media print{body{background:#fff}.toc,.post{break-inside:avoid;border-color:#ccc}.note{display:none}}',
].join('\n');

/** createdAtLocal: 'YYYY-MM-DDTHH:MM' in the workspace timezone. */
export function buildReviewHtml(records: DeliveryRecord[], packName: string, createdAtLocal: string) {
  const created = createdAtLocal.slice(0, 10).replace(/-/g, '/') + ' ' + createdAtLocal.slice(11, 16);
  const totalImages = records.reduce((n, r) => n + r.images.length, 0);
  const tocRows = records
    .map((r) => '<tr>' +
      `<td class="num"><a href="#post-${r.no}">${r.no}</a></td>` +
      '<td>' + (esc(r.date) || '<span class="muted">未設定</span>') + '</td>' +
      '<td>' + (esc(r.time) || '<span class="muted">—</span>') + '</td>' +
      '<td>' + (esc(r.title) || '<span class="muted">（なし）</span>') + '</td>' +
      `<td class="center">${r.images.length}</td>` +
      '</tr>')
    .join('\n');
  const posts = records
    .map((r) => {
      const imgs = r.images.length
        ? '<div class="images">' + r.images.map((im) => {
            const src = r.no + '/' + im.fileName;
            return `<figure><a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${esc(im.fileName)}" loading="lazy"></a><figcaption>${esc(im.fileName)}</figcaption></figure>`;
          }).join('') + '</div>'
        : '<p class="muted noimg">画像なし</p>';
      const body = r.body ? `<div class="body">${esc(r.body)}</div>` : '<div class="body muted">（本文なし）</div>';
      return `<section class="post" id="post-${r.no}">` +
        '<header class="post-head">' +
        `<span class="no">${r.no}</span>` +
        '<span class="meta"><span class="label">投稿日</span>' + (esc(r.date) || '<span class="muted">未設定</span>') + '</span>' +
        '<span class="meta"><span class="label">投稿時間</span>' + (esc(r.time) || '<span class="muted">—</span>') + '</span>' +
        '<span class="title">' + (esc(r.title) || '<span class="muted">（管理タイトルなし）</span>') + '</span>' +
        '</header>' +
        '<div class="post-body">' +
        `<div class="col-images"><h3>画像（${r.images.length}枚）</h3>${imgs}</div>` +
        `<div class="col-text"><h3>投稿本文</h3>${body}<p class="folder">フォルダ：${r.no}/</p></div>` +
        '</div>' +
        '</section>';
    })
    .join('\n');
  return '<!DOCTYPE html>\n<html lang="ja">\n<head>\n<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>確認用一覧 - ${esc(packName)}</title>\n<style>\n${REVIEW_CSS}\n</style>\n</head>\n<body>\n` +
    '<main>\n' +
    '<header class="page-head">\n<h1>SNS投稿 確認用一覧</h1>\n' +
    `<p class="summary">投稿 ${records.length}件 ／ 画像 ${totalImages}枚 ／ 作成日時 ${esc(created)}</p>\n` +
    '<p class="note">※ 画像が表示されない場合は、ZIPファイルを「すべて展開（解凍）」してから、この確認用一覧.htmlを開いてください。</p>\n' +
    '</header>\n' +
    '<section class="toc">\n<h2>投稿一覧</h2>\n<table>\n<thead><tr><th>投稿番号</th><th>投稿日</th><th>投稿時間</th><th>管理タイトル</th><th>画像</th></tr></thead>\n<tbody>\n' +
    tocRows + '\n</tbody>\n</table>\n</section>\n' +
    posts + '\n' +
    '</main>\n</body>\n</html>\n';
}

// ---- ZIP (fflate, STORE). UTF-8 names (flag bit 11 set by fflate) + Info-ZIP Unicode Path extra field (0x7075).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function unicodePathExtra(name: string) {
  const u = new TextEncoder().encode(name);
  const out = new Uint8Array(5 + u.length);
  out[0] = 1;
  new DataView(out.buffer).setUint32(1, crc32(u), true);
  out.set(u, 5);
  return out;
}

/** Build the pack. Pure: no DB/IO. `localNow` = 'YYYY-MM-DDTHH:MM' in the workspace timezone. */
export function buildDeliveryPack(posts: DeliveryPostInput[], localNow: string, mtime: Date = new Date()) {
  if (posts.length > MAX_POSTS) throw badRequest(`納品パックに含められる投稿は${MAX_POSTS}件までです`);
  const folder = 'SNS納品パック_' + localNow.slice(0, 10);
  const records = posts.map(toDeliveryRecord);
  const entries: Record<string, [Uint8Array, { level: 0; mtime: Date; extra?: Record<number, Uint8Array> }]> = {};
  const files: string[] = [];
  const add = (path: string, data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const opts: { level: 0; mtime: Date; extra?: Record<number, Uint8Array> } = { level: 0, mtime };
    if (/[^\x20-\x7e]/.test(path)) opts.extra = { 0x7075: unicodePathExtra(path) };
    entries[path] = [bytes, opts];
    if (!path.endsWith('/')) files.push(path);
  };
  add(folder + '/', new Uint8Array(0));
  for (const rec of records) {
    const dir = `${folder}/${rec.no}/`;
    add(dir, new Uint8Array(0));
    for (const im of rec.images) add(dir + im.fileName, im.bytes);
    add(dir + '投稿文.txt', buildPostText(rec));
  }
  add(folder + '/投稿一覧.csv', buildCsv(records));
  add(folder + '/確認用一覧.html', buildReviewHtml(records, folder, localNow));
  return { zip: zipSync(entries), fileName: folder + '.zip', folderName: folder, files };
}

// ---------------------------------------------------------------- NetaMeguri bridge

const IMAGE_EXT: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };

/** Same rule as the original: keep the (lower-cased) filename extension unless it disagrees with the content. */
export function imageExt(filename: string | null | undefined, mime: string): string | null {
  const type = IMAGE_EXT[mime];
  if (!type) return null; // JPG / PNG / WEBP only (GIF/HEIC etc. are skipped with a warning)
  const m = /\.([^.\\/]+)$/.exec(filename || '');
  const ext = m ? m[1].toLowerCase() : '';
  const matches = (type === 'jpeg' && (ext === 'jpg' || ext === 'jpeg')) || type === ext;
  return matches ? ext : type === 'jpeg' ? 'jpg' : type;
}

export interface DeliverySelection {
  contentIds?: string[];
  packId?: string;
  campaignId?: string;
}

const sortKey = (c: ContentItem) => c.scheduledAt ?? c.publishedAt ?? '9999';

/**
 * Resolve the selection to ordered ContentItems (tenant-scoped).
 * - contentIds: order as given (the UI sends them in the order the user sees).
 * - packId / campaignId: every non-archived item, ordered by scheduled/published date then creation.
 */
export function resolveSelection(ctx: Ctx, sel: DeliverySelection): ContentItem[] {
  const n = [sel.contentIds?.length ? 1 : 0, sel.packId ? 1 : 0, sel.campaignId ? 1 : 0].reduce((a, b) => a + b, 0);
  if (n !== 1) throw badRequest('contentIds / packId / campaignId のいずれか1つを指定してください');
  let items: ContentItem[];
  if (sel.contentIds?.length) {
    if (sel.contentIds.length > MAX_POSTS) throw badRequest(`納品パックに含められる投稿は${MAX_POSTS}件までです`);
    const seen = new Set<string>();
    items = sel.contentIds.filter((x) => !seen.has(x) && seen.add(x)).map((cid) => getContent(ctx, cid));
  } else {
    if (sel.packId) getScoped(ctx, 'content_packs', sel.packId);
    if (sel.campaignId) getScoped(ctx, 'campaigns', sel.campaignId);
    items = listContent(ctx, { packId: sel.packId, campaignId: sel.campaignId, limit: 2000 })
      .filter((c) => c.status !== 'archived')
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || a.createdAt.localeCompare(b.createdAt));
  }
  if (!items.length) throw badRequest('納品パックにする投稿がありません');
  return items;
}

function mediaFor(ctx: Ctx, c: ContentItem) {
  const rows = ctx.app.db.all("SELECT * FROM media_assets WHERE workspace_id = ? AND content_id = ? AND kind = 'image' ORDER BY created_at, rowid", ctx.workspaceId, c.id);
  const refOrder = new Map(c.mediaRefs.map((m, i) => [m, i]));
  return rows.sort((a, b) => (refOrder.get(a.id) ?? 1e9) - (refOrder.get(b.id) ?? 1e9));
}

function titleOf(c: ContentItem) {
  if (c.title) return c.title;
  const p = PLATFORMS[c.platform];
  return `${p?.label ?? c.platform}（${FORMAT_LABELS[c.format] ?? c.format}）`;
}

/** Preview: what would go into the pack, with the same warnings as the original (no date / no body / no images). */
export function previewDeliveryPack(ctx: Ctx, sel: DeliverySelection) {
  requirePerm(ctx, 'export');
  const tz = getTimezone(ctx.app.db, ctx.workspaceId);
  const items = resolveSelection(ctx, sel);
  return {
    timezone: tz,
    folderName: 'SNS納品パック_' + utcToZoned(ctx.app.clock.now().toISOString(), tz).slice(0, 10),
    posts: items.map((c, i) => {
      const media = mediaFor(ctx, c);
      const usable = media.filter((m) => imageExt(m.filename, m.mime));
      const when = c.scheduledAt ?? c.publishedAt;
      const local = when ? utcToZoned(when, tz) : null;
      const warnings: string[] = [];
      if (!local) warnings.push('投稿日が未入力');
      if (!c.body.trim()) warnings.push('本文が未入力');
      if (!usable.length) warnings.push('画像が未登録');
      if (usable.length > MAX_IMAGES_PER_POST) warnings.push(`画像は最大${MAX_IMAGES_PER_POST}枚まで（${usable.length - MAX_IMAGES_PER_POST}枚は含めません）`);
      if (media.length > usable.length) warnings.push(`JPG/PNG/WEBP以外の画像${media.length - usable.length}枚は含めません`);
      return { no: postNumber(i), contentId: c.id, platform: c.platform, status: c.status, date: formatDate(local?.slice(0, 10)), time: local?.slice(11, 16) ?? '', title: titleOf(c), images: Math.min(usable.length, MAX_IMAGES_PER_POST), warnings };
    }),
  };
}

/** Build the 納品パック ZIP from NetaMeguri content (images are read from object storage, bytes untouched). */
export async function exportDeliveryPack(ctx: Ctx, sel: DeliverySelection) {
  requirePerm(ctx, 'export');
  const tz = getTimezone(ctx.app.db, ctx.workspaceId);
  const items = resolveSelection(ctx, sel);
  const posts: DeliveryPostInput[] = [];
  let imageCount = 0;
  for (const c of items) {
    const images: DeliveryImage[] = [];
    for (const m of mediaFor(ctx, c)) {
      if (images.length >= MAX_IMAGES_PER_POST) break;
      const ext = imageExt(m.filename, m.mime);
      if (!ext) continue;
      const data = await ctx.app.storage.get(m.storage_key);
      if (!data) throw badRequest(`画像「${m.filename || m.id}」をストレージから読み込めませんでした`);
      images.push({ bytes: new Uint8Array(data), originalName: m.filename ?? m.id, ext });
    }
    imageCount += images.length;
    const when = c.scheduledAt ?? c.publishedAt;
    const local = when ? utcToZoned(when, tz) : null;
    posts.push({ date: local?.slice(0, 10) ?? null, time: local?.slice(11, 16) ?? null, title: titleOf(c), body: c.body, images });
  }
  const now = ctx.app.clock.now();
  const pack = buildDeliveryPack(posts, utcToZoned(now.toISOString(), tz), now);
  audit(ctx, 'delivery_pack.exported', sel.packId ? 'content_pack' : sel.campaignId ? 'campaign' : 'content', sel.packId ?? sel.campaignId ?? null, { posts: posts.length, images: imageCount });
  return pack;
}
