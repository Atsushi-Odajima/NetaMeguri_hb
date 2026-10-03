import { test, expect } from '@playwright/test';
import { login, apiFor, TRANSCRIPT } from './helpers';

// E2E-1: YouTube相当動画 upload → Transcript → Ideas → Content Pack → Threads/LinkedIn/Blog Draft → Review → Approved
test('E2E-1 video transcript → pack → review → approved', async ({ page }) => {
  await login(page);
  await page.goto('/sources/new');
  await page.getByRole('tab', { name: '文字起こし(SRT/VTT)' }).click();
  await page.getByLabel('種類').selectOption('video');
  await page.getByLabel('タイトル', { exact: true }).fill('E2E: AI個人開発の進め方（動画）');
  await page.getByLabel('文字起こし（SRT / VTT / [mm:ss] 形式）').fill(TRANSCRIPT);
  await page.getByLabel('元動画URL（任意）').fill('https://www.youtube.com/watch?v=e2e-demo-0001');
  await page.getByRole('button', { name: '登録して解析' }).click();
  await page.waitForURL(/\/sources\/src_/);
  await page.getByRole('tab', { name: /Transcript/ }).click();
  await expect(page.locator('.segments li')).toHaveCount(7);
  await page.getByRole('button', { name: 'まとめて作成' }).click();
  await page.waitForURL(/\/packs\/pack_/);
  for (const k of ['Threads', 'LinkedIn', 'ブログ']) await expect(page.locator('.pack-k', { hasText: k })).toBeVisible();

  // Threads via UI
  await page.locator('.pack-k', { hasText: 'Threads' }).click();
  await page.locator('.ccard').first().click();
  await page.waitForURL(/\/content\/cnt_/);
  await expect(page.locator('.pbadge').first()).toHaveText('Threads');
  await page.getByRole('button', { name: 'レビュー依頼' }).click();
  await expect(page.locator('.hero .status')).toHaveText('Review待ち');
  await page.getByRole('button', { name: '承認', exact: true }).click();
  await expect(page.locator('.hero .status')).toHaveText('Approved');

  // LinkedIn + Blog via API (same flow) — relations kept to idea/source/pack
  const api = await apiFor(page);
  const packId = page.url().match(/content\/(cnt_\w+)/) ? (await api.get(`/content/${page.url().split('/').pop()}`)).content.packId : null;
  const pack = await api.get(`/packs/${packId}`);
  for (const platform of ['linkedin', 'blog']) {
    const item = pack.items.find((i: any) => i.platform === platform);
    expect(item, platform).toBeTruthy();
    expect(item.ideaId).toBeTruthy();
    expect(item.sourceIds.length).toBe(1);
    await api.post(`/content/${item.id}/review`);
    const ap = await api.post(`/content/${item.id}/approve`);
    expect(ap.status).toBe('approved');
  }
});
