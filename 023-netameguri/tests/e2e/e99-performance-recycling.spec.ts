import { test, expect } from '@playwright/test';
import { login, apiFor } from './helpers';

// E2E-4: Published → 24h/7d Performance → High Performer → 60日後 Recycling → 別Platform Draft
// (runs last: it advances the server's test clock by 61 days)
test('E2E-4 performance snapshots → high performer → recycling after 60 days', async ({ page }) => {
  await login(page);
  const api = await apiFor(page);
  const ideas = await api.get('/ideas-memory');
  const idea = ideas.unused[0];
  const d = await api.post('/drafts', { ideaId: idea.id, platform: 'threads' });
  await api.post(`/content/${d.content.id}/review`);
  await api.post(`/content/${d.content.id}/approve`);
  await api.post(`/content/${d.content.id}/mark-published`, { url: 'https://www.threads.net/@sample/post/e2e4' });

  await page.goto(`/content/${d.content.id}`);
  await page.getByRole('tab', { name: '反応' }).click();
  await page.getByLabel('views').fill('3000');
  await page.getByLabel('likes').fill('150');
  await page.getByLabel('期間').selectOption('24h');
  await page.getByRole('button', { name: '記録' }).click();
  await expect(page.locator('table tbody tr')).toHaveCount(1);
  await page.getByLabel('views').fill('9000');
  await page.getByLabel('likes').fill('800');
  await page.getByLabel('comments').fill('90');
  await page.getByLabel('shares').fill('70');
  await page.getByLabel('期間').selectOption('7d');
  await page.getByRole('button', { name: '記録' }).click();
  await expect(page.locator('table tbody tr')).toHaveCount(2);
  const c = await api.get(`/content/${d.content.id}`);
  expect(c.content.recycleState).toBe('high_performer');
  const sum = await api.get('/performance/summary');
  expect(sum.crossPlatformTotal).toBeNull();

  // Not a candidate yet
  expect((await api.get('/recycling')).some((r: any) => r.content.id === d.content.id)).toBe(false);
  await api.test('advance', { days: 61 });
  await login(page); // session lifetime is 14 days on the server clock
  const api2 = await apiFor(page);
  const cand = (await api2.get('/recycling')).find((r: any) => r.content.id === d.content.id);
  expect(cand.reason).toContain('High Performer');

  await page.goto('/recycling');
  const card = page.locator('.ccard', { hasText: cand.content.body.slice(0, 20) });
  await card.getByRole('button', { name: '別Platform' }).click();
  await page.waitForURL(/\/content\/cnt_/);
  await expect(page.locator('.hero .pbadge')).toHaveText('LinkedIn');
  const n = await api2.get(`/content/${page.url().split('/').pop()}`);
  expect(n.content.parentContentId).toBe(d.content.id);
  expect(n.content.ideaId).toBe(d.content.ideaId);
  expect(n.content.status).toBe('draft'); // never auto-published
});
