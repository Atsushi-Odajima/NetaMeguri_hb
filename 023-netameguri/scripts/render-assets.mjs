// Renders NetaMeguri brand assets (PNG) from in-repo SVG/HTML using the local Chromium.
// Wordmark is rasterized with "DejaVu Sans" (Bitstream Vera / DejaVu license permits use; no font file is bundled).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT_BRAND = 'brand';
const OUT_ICONS = 'web/public/icons';
mkdirSync(OUT_BRAND, { recursive: true });
mkdirSync(OUT_ICONS, { recursive: true });

const LOOP = (stroke = 'url(#g)') => `
  <path d="M60 40 C 70 24, 82 16, 94 16 C 107 16, 114 27, 114 40 C 114 53, 107 64, 94 64 C 82 64, 70 56, 60 40 C 50 24, 38 16, 26 16 C 13 16, 6 27, 6 40 C 6 53, 13 64, 26 64 C 34 64, 41 60, 47 54" fill="none" stroke="${stroke}" stroke-width="13" stroke-linecap="round"/>
  <path d="M44 44 L 56 52 L 42 60 Z" fill="#FF6A00"/>`;
const DEFS = `<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#FF9A2E"/><stop offset="1" stop-color="#FF6A00"/></linearGradient></defs>`;

const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">${DEFS}${LOOP()}</svg>`;
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111111"/><g transform="translate(5 14) scale(0.45)">${DEFS}${LOOP()}</g></svg>`;
writeFileSync(`${OUT_BRAND}/logo-mark.svg`, markSvg);
writeFileSync(`${OUT_ICONS}/favicon.svg`, faviconSvg);

const word = (dark) => `<span style="font-family:'DejaVu Sans',sans-serif;font-weight:700;letter-spacing:-0.03em"><span style="color:${dark ? '#fff' : '#111'}">Neta</span><span style="color:#FF7A00">Meguri</span></span>`;
const page = (body, w, h, bg = 'transparent') => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${w}px;height:${h}px;background:${bg};overflow:hidden}*{box-sizing:border-box}</style></head><body>${body}</body></html>`;

const iconHtml = (size, { maskable = false, rounded = true } = {}) => {
  const pad = maskable ? size * 0.2 : size * 0.12;
  const inner = size - pad * 2;
  return page(`<div style="width:${size}px;height:${size}px;background:#111;border-radius:${rounded && !maskable ? size * 0.22 : 0}px;display:flex;align-items:center;justify-content:center">
    <svg width="${inner}" height="${inner * (80 / 120)}" viewBox="0 0 120 80">${DEFS}${LOOP()}</svg></div>`, size, size);
};
const horizontal = (dark) => page(`<div style="display:flex;align-items:center;gap:28px;height:240px;padding:0 40px;background:${dark ? '#111' : 'transparent'}">
  <svg width="210" height="140" viewBox="0 0 120 80">${DEFS}${LOOP()}</svg><div style="font-size:120px;line-height:1">${word(dark)}</div></div>`, 1100, 240);
const stacked = page(`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;width:600px;height:500px">
  <svg width="330" height="220" viewBox="0 0 120 80">${DEFS}${LOOP()}</svg><div style="font-size:84px;line-height:1">${word(false)}</div></div>`, 600, 500);
const og = page(`<div style="width:1200px;height:630px;background:#fff;display:flex;flex-direction:column;justify-content:center;padding:70px 90px;gap:26px;font-family:'IPAGothic','DejaVu Sans',sans-serif;position:relative;overflow:hidden">
  <div style="position:absolute;right:-160px;bottom:-220px;width:460px;height:460px;border-radius:50%;background:#FFF1E3;z-index:0"></div>
  <div style="display:flex;align-items:center;gap:20px;position:relative;z-index:1"><svg width="150" height="100" viewBox="0 0 120 80">${DEFS}${LOOP()}</svg><div style="font-size:84px;line-height:1">${word(false)}</div></div>
  <div style="font-size:46px;font-weight:700;color:#111;position:relative;z-index:1">1個作ったコンテンツを、<span style="color:#FF7A00">1回で終わらせない。</span></div>
  <div style="font-size:26px;color:#444;position:relative;z-index:1">素材 → SNS別の投稿案 → ネタ重複チェック → 効果分析 → 再利用</div></div>`, 1200, 630);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const p = await ctx.newPage();
async function shot(html, w, h, path, transparent = true) {
  await p.setViewportSize({ width: w, height: h });
  await p.setContent(html);
  await p.screenshot({ path, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
  console.log('wrote', path);
}
await shot(iconHtml(512), 512, 512, `${OUT_ICONS}/icon-512.png`);
await shot(iconHtml(192), 192, 192, `${OUT_ICONS}/icon-192.png`);
await shot(iconHtml(512, { maskable: true }), 512, 512, `${OUT_ICONS}/maskable-512.png`, false);
await shot(iconHtml(180, { rounded: false }), 180, 180, `${OUT_ICONS}/apple-touch-icon.png`, false);
await shot(iconHtml(32), 32, 32, `${OUT_ICONS}/favicon-32.png`);
await shot(og, 1200, 630, `${OUT_ICONS}/og.png`, false);
await shot(horizontal(false), 1100, 240, `${OUT_BRAND}/logo-horizontal.png`);
await shot(horizontal(true), 1100, 240, `${OUT_BRAND}/logo-horizontal-dark.png`, false);
await shot(stacked, 600, 500, `${OUT_BRAND}/logo-stacked.png`);
await shot(page(`<svg width="480" height="320" viewBox="0 0 120 80">${DEFS}${LOOP()}</svg>`, 480, 320), 480, 320, `${OUT_BRAND}/logo-mark.png`);
await browser.close();
