// 画面スクリーンショット撮影（サンプルWorkspace使用）。 node scripts/screenshots.mjs [baseURL]
import { chromium, devices } from '@playwright/test';
const BASE = process.argv[2] ?? 'http://localhost:8787';
const OUT = 'docs/screenshots';
const b = await chromium.launch({ args: ['--lang=ja-JP'] });
const errors = [];

async function session(opts) {
  const ctx = await b.newContext({ ...opts, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  return { ctx, p };
}
async function login(p) {
  await p.goto(BASE + '/login');
  await p.fill('input[type=email]', 'demo@sample-build-lab.invalid');
  await p.fill('input[type=password]', 'demo-password-123');
  await p.click('button.btn.primary');
  await p.waitForSelector('.tiles');
}
const shot = async (p, name, full = false) => { await p.waitForTimeout(500); await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full }); console.log(name); };

// ---------- PC ----------
{
  const { ctx, p } = await session({ viewport: { width: 1440, height: 900 } });
  await p.goto(BASE + '/login'); await shot(p, 'pc-01-ログイン');
  await login(p); await shot(p, 'pc-02-ダッシュボード');
  await p.goto(BASE + '/sources'); await p.waitForSelector('table'); await shot(p, 'pc-03-素材一覧');
  await p.goto(BASE + '/sources/new'); await p.getByRole('tab', { name: '文字起こし(SRT/VTT)' }).click(); await shot(p, 'pc-04-素材登録');
  await p.goto(BASE + '/sources'); await p.locator('table a').filter({ hasText: '失敗談3つ' }).click(); await p.waitForSelector('.counts'); await shot(p, 'pc-05-素材詳細とContentPack作成');
  await p.getByRole('tab', { name: /Transcript/ }).click(); await shot(p, 'pc-06-文字起こし');
  await p.goto(BASE + '/ideas'); await p.waitForSelector('table');
  await p.getByLabel('ネタ').fill('AIでコードを書かせる前に、完成条件を決めておくと手戻りが減る');
  await p.getByRole('button', { name: '過去のネタと比べる' }).click(); await p.waitForSelector('.sim'); await shot(p, 'pc-07-ネタ重複チェック');
  await p.goto(BASE + '/'); await p.click('a[href^="/packs/"]'); await p.waitForSelector('.pack-grid'); await shot(p, 'pc-08-ContentPack');
  await p.locator('.pack-k', { hasText: 'Instagram' }).click(); await p.locator('.ccard').first().click(); await p.waitForSelector('textarea.body-edit'); await shot(p, 'pc-09-エディタ_Carousel_チェック', true);
  await p.goto(BASE + '/'); await p.click('a[href^="/packs/"]'); await p.locator('.pack-k', { hasText: 'Threads' }).click(); await p.locator('.ccard').first().click(); await p.waitForSelector('textarea.body-edit');
  await p.getByRole('tab', { name: '投稿・予約' }).click(); await shot(p, 'pc-10-投稿予約と手動投稿', true);
  await p.goto(BASE + '/campaigns'); await p.locator('.list a').first().click(); await p.waitForSelector('.timeline'); await shot(p, 'pc-11-キャンペーン', true);
  await p.goto(BASE + '/calendar'); await p.waitForSelector('.cal'); await shot(p, 'pc-12-カレンダー');
  await p.goto(BASE + '/library'); await p.getByRole('button', { name: 'まだThreadsで使ってないAI開発ネタ' }).click(); await p.waitForSelector('.results'); await shot(p, 'pc-13-ライブラリ検索');
  await p.goto(BASE + '/strategist'); await p.getByRole('button', { name: '今日Threadsに何か投稿したい' }).click(); await p.waitForSelector('.answer'); await shot(p, 'pc-14-AIアシスタント', true);
  await p.goto(BASE + '/performance'); await p.waitForSelector('table'); await shot(p, 'pc-15-効果分析', true);
  await p.goto(BASE + '/recycling'); await p.waitForSelector('.cards'); await shot(p, 'pc-16-再利用');
  await p.goto(BASE + '/brand'); await p.waitForSelector('textarea'); await shot(p, 'pc-17-BrandVoice');
  await p.goto(BASE + '/claims'); await p.waitForSelector('table'); await shot(p, 'pc-18-ClaimRegistry');
  await p.goto(BASE + '/connectors'); await p.waitForSelector('table'); await shot(p, 'pc-19-SNSConnector');
  await p.goto(BASE + '/settings'); await p.waitForSelector('.card'); await shot(p, 'pc-20-設定', true);
  await p.goto(BASE + '/data'); await p.waitForSelector('.card'); await shot(p, 'pc-21-Import_Export_Backup');
  await p.goto(BASE + '/audit'); await p.waitForSelector('table'); await shot(p, 'pc-22-監査ログ');
  await ctx.close();
}
// ---------- iPhone ----------
{
  const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
  const { ctx, p } = await session(iphone);
  await p.goto(BASE + '/login'); await shot(p, 'sp-01-ログイン');
  await login(p); await shot(p, 'sp-02-ダッシュボード');
  await p.getByRole('button', { name: 'メニュー' }).click(); await shot(p, 'sp-03-メニュー');
  await p.goto(BASE + '/inbox'); await p.getByLabel('メモ').fill('移動中に思いついた：リリース前チェックの話'); await shot(p, 'sp-04-QuickCapture');
  await p.goto(BASE + '/calendar'); await p.waitForSelector('.cal-list'); await shot(p, 'sp-05-カレンダー一覧');
  await p.goto(BASE + '/'); await p.click('a[href^="/packs/"]'); await p.waitForSelector('.pack-grid'); await shot(p, 'sp-06-ContentPack');
  await p.locator('.ccard').first().click(); await p.waitForSelector('textarea.body-edit'); await shot(p, 'sp-07-エディタ');
  await p.goto(BASE + '/strategist'); await p.getByRole('button', { name: '今日Threadsに何か投稿したい' }).click(); await p.waitForSelector('.answer'); await p.locator('.answer').scrollIntoViewIfNeeded(); await shot(p, 'sp-08-AIアシスタント');
  await ctx.close();
}
// ---------- iPad ----------
{
  const { defaultBrowserType, ...ipad } = devices['iPad (gen 7)'];
  const { ctx, p } = await session(ipad);
  await login(p); await shot(p, 'tab-01-ダッシュボード');
  await p.goto(BASE + '/calendar'); await p.waitForSelector('.cal'); await shot(p, 'tab-02-カレンダー');
  await ctx.close();
}
await b.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
