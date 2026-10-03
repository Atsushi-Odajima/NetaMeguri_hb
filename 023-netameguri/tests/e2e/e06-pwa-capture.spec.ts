import { test, expect, devices } from '@playwright/test';
import { login, apiFor } from './helpers';

// E2E-6: iPhone PWA で URL Quick Capture (offline → online sync) → PC で Source 処理 → Draft review
test('E2E-6 mobile quick capture (offline) → PC processes → draft review', async ({ browser, page }) => {
  const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 13'] as any;
  const mctx = await browser.newContext({ ...iphone });
  const m = await mctx.newPage();
  await login(m);
  // PWA manifest + service worker
  const manifest = await (await m.request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
  await m.goto('/inbox');
  await m.waitForFunction(() => navigator.serviceWorker?.controller != null || navigator.serviceWorker?.ready != null);
  await expect(m.locator('.bottom-nav')).toBeVisible();

  await mctx.setOffline(true);
  await m.getByLabel('メモ').fill('E2E: 個人開発のリリース前チェックの話を使いたい');
  await m.getByLabel('URL').fill('https://example.com/e2e/release-checklist');
  await m.getByRole('button', { name: 'Inboxに入れる' }).click();
  await expect(m.getByText('オフラインのため端末に保存しました')).toBeVisible();
  await expect(m.locator('.sync-pill')).toContainText('未同期 1');
  await mctx.setOffline(false);
  await expect(m.locator('.sync-pill')).toHaveCount(0, { timeout: 10_000 });

  // offline draft edit on mobile → synced on reconnect
  const mapi = await apiFor(m);
  const target = (await mapi.get('/content?status=draft'))[0];
  await m.goto(`/content/${target.id}`);
  await expect(m.locator('textarea.body-edit')).toBeVisible();
  await mctx.setOffline(true);
  await m.locator('textarea.body-edit').fill(target.body + '\nオフラインで追記しました。');
  await expect(m.locator('.save')).toHaveText('端末に保存（未同期）', { timeout: 5000 });
  await expect(m.getByRole('button', { name: 'API予約投稿' })).toHaveCount(0); // publish UI not on this tab; schedule disabled offline
  await mctx.setOffline(false);
  await expect.poll(async () => (await mapi.get(`/content/${target.id}`)).content.body, { timeout: 10_000 }).toContain('オフラインで追記しました。');
  await mctx.close();

  // PC: process inbox item into a Source, build pack, review a draft
  await login(page);
  await page.goto('/inbox');
  const item = page.locator('.list > li', { hasText: 'E2E: 個人開発のリリース前チェック' });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Sourceにする' }).click();
  await expect(item).toHaveCount(0);
  const api = await apiFor(page);
  const src = (await api.get('/sources')).find((s: any) => s.url === 'https://example.com/e2e/release-checklist');
  expect(src).toBeTruthy();
  await page.goto(`/sources/${src.id}`);
  await page.getByRole('button', { name: 'まとめて作成' }).click();
  await page.waitForURL(/\/packs\//);
  await page.locator('.ccard').first().click();
  await page.getByRole('button', { name: 'レビュー依頼' }).click();
  await expect(page.locator('.hero .status')).toHaveText('Review待ち');
});
