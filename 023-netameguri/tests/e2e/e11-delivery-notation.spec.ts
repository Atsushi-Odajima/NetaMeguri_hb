import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { login, apiFor } from './helpers';

// Merged features: NetaMeguri 表記ゆれチェック (dictionary → check draft → bulk replace)
// and NetaMeguri 納品パック (select draft → preview → ZIP download with the delivery layout).
test('E2E-11 notation dictionary → replace in draft → delivery pack ZIP', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await login(page);
  const api = await apiFor(page);
  const stamp = Date.now();
  const c = await api.post('/content', { platform: 'instagram', title: `納品E2E ${stamp}`, body: `Youtubeで新商品を紹介します ${stamp}\n詳しくはYoutubeで。` });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const up = await api.raw.post(`/api/w/${api.wsId}/media`, { headers: api.headers, multipart: { contentId: c.id, file: { name: 'photo.png', mimeType: 'image/png', buffer: png } } });
  expect(up.ok()).toBe(true);

  // dictionary via UI
  await page.goto('/notation');
  await expect(page.getByRole('heading', { name: 'NetaMeguri 表記ゆれチェック' })).toBeVisible();
  await page.getByLabel('正しい表記').fill('YouTube');
  await page.getByLabel('別表記（1行に1つ）').fill('Youtube\nyoutube');
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await expect(page.locator('.notation-rules')).toContainText('YouTube');

  // check the draft and bulk-replace
  await page.goto(`/content/${c.id}?tab=notation`);
  await page.getByRole('button', { name: 'チェックする' }).click();
  await expect(page.locator('.notation-hits tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'この表記をすべて置換' }).click();
  await expect(page.locator('.alert.ok')).toContainText('2件を置換しました');
  await expect(page.locator('textarea.body-edit')).toHaveValue(new RegExp(`^YouTubeで新商品を紹介します ${stamp}\\n詳しくはYouTubeで。$`));
  expect((await api.get(`/content/${c.id}`)).content.version).toBe(2);

  // delivery pack
  await page.goto('/delivery');
  await expect(page.getByRole('heading', { name: 'NetaMeguri 納品パック' })).toBeVisible();
  await page.getByLabel(`選択 納品E2E ${stamp}`).check();
  await page.getByRole('button', { name: '内容を確認' }).click();
  await expect(page.locator('.delivery-preview tbody tr')).toHaveCount(1);
  await expect(page.locator('.delivery-preview')).toContainText('1枚');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '納品パックZIPをダウンロード' }).click()]);
  // Chromium under a POSIX (non-UTF-8) locale names non-ASCII downloads "download"; the header is the contract.
  if (dl.suggestedFilename() !== 'download') expect(dl.suggestedFilename()).toMatch(/^SNS納品パック_\d{4}-\d{2}-\d{2}\.zip$/);
  const head = await api.raw.get(`/api/w/${api.wsId}/delivery-pack.zip?contentIds=${c.id}`);
  expect(head.headers()['content-disposition']).toMatch(/filename\*=UTF-8''SNS%E7%B4%8D%E5%93%81%E3%83%91%E3%83%83%E3%82%AF_\d{4}-\d{2}-\d{2}\.zip/);
  const z = unzipSync(new Uint8Array(readFileSync((await dl.path())!)));
  const names = Object.keys(z).filter((n) => !n.endsWith('/')).map((n) => n.replace(/^SNS納品パック_[\d-]+\//, ''));
  expect(names.sort()).toEqual(['001/001_01.png', '001/投稿文.txt', '投稿一覧.csv', '確認用一覧.html'].sort());
  const txt = new TextDecoder().decode(Object.entries(z).find(([n]) => n.endsWith('001/投稿文.txt'))![1]);
  expect(txt).toContain(`管理タイトル：納品E2E ${stamp}`);
  expect(txt).toContain('YouTubeで新商品を紹介します');
});
