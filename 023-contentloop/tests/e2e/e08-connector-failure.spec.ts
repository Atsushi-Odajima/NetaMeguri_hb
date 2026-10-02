import { test, expect } from '@playwright/test';
import { login, apiFor } from './helpers';

// E2E-8: Connector失効 → publish failed → duplicateなし → 再認証 → 再実行
test('E2E-8 connector expiry → failed → re-auth → retry without duplicates', async ({ page }) => {
  await login(page);
  page.on('dialog', (d) => d.accept());
  const api = await apiFor(page);
  const c = await api.post('/content', { platform: 'threads', body: 'E2E-8: リリース前は表示・課金・バックアップの3点を確認します。' });
  await api.post(`/content/${c.id}/review`);
  await api.post(`/content/${c.id}/approve`);
  const conns = (await api.get('/connectors')).connectors;
  if (!conns.some((x: any) => x.platform === 'threads' && x.status === 'connected')) {
    await page.goto('/connectors');
    await page.locator('tr', { hasText: 'Threads' }).getByRole('button', { name: 'Sandboxに接続' }).click();
    await page.getByRole('link', { name: '許可する' }).click();
    await page.waitForURL(/connected=1/);
  }
  const before = await api.test('sandbox', { platform: 'threads' });
  await api.post(`/content/${c.id}/schedule`, { at: new Date(Date.now() - 1000).toISOString(), mode: 'api' });
  await api.test('sandbox', { platform: 'threads', failNext: 'auth' }); // token rejected by platform
  const run1 = await api.test('run-jobs');
  const job = run1.find((j: any) => j.contentId === c.id);
  expect(job.status).toBe('failed');
  expect((await api.get(`/content/${c.id}`)).content.status).toBe('failed');
  expect((await api.get('/connectors')).connectors.find((x: any) => x.platform === 'threads').status).toBe('expired');

  // retry before re-auth is refused
  const r = await page.request.post(`/api/w/${api.wsId}/jobs/${job.id}/retry`, { headers: api.headers, data: {} });
  expect(r.status()).toBe(400);

  // re-auth via OAuth (sandbox)
  await page.goto('/connectors');
  await expect(page.locator('tr', { hasText: 'Threads' })).toContainText('expired');
  await page.locator('tr', { hasText: 'Threads' }).getByRole('button', { name: 'Sandboxに接続' }).click();
  await page.getByRole('link', { name: '許可する' }).click();
  await page.waitForURL(/connected=1/);

  // retry from the editor UI
  await page.goto(`/content/${c.id}`);
  await page.getByRole('tab', { name: '投稿・予約' }).click();
  await page.getByRole('button', { name: '再実行（重複確認つき）' }).click();
  await expect(page.locator('.hero .status')).toHaveText('公開済み');
  const after = await api.test('sandbox', { platform: 'threads' });
  expect(after.remotePosts - before.remotePosts).toBe(1);
  // running the worker again does not post twice
  await api.test('run-jobs');
  expect((await api.test('sandbox', { platform: 'threads' })).remotePosts).toBe(after.remotePosts);
});
