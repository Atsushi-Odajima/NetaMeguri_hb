import { test, expect } from '@playwright/test';
import { login, apiFor } from './helpers';

// E2E-3: Product Launch Campaign → 8段階sequence → Calendar → manual/API publish混在
test('E2E-3 campaign 8-stage sequence → calendar with API + manual', async ({ page }) => {
  await login(page);
  page.on('dialog', (d) => d.accept());
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  await page.goto('/campaigns');
  await page.getByLabel('名前').fill('E2E Launch');
  await page.getByLabel('開始日').fill(fmt(new Date(today.getTime() + 86400_000)));
  await page.getByLabel('終了日').fill(fmt(new Date(today.getTime() + 15 * 86400_000)));
  await page.getByLabel('Key Message（1行に1つ）').fill('リリース前の不安を減らす\n14日間の無料トライアル');
  await page.locator('fieldset', { hasText: '使う素材' }).locator('input[type=checkbox]').first().check();
  await page.getByRole('button', { name: '作成して8段階のDraft計画を作る' }).click();
  await page.waitForURL(/\/campaigns\/cmp_/);
  await expect(page.locator('.timeline > li')).toHaveCount(8);
  await page.locator('.timeline > li').nth(0).getByRole('button', { name: 'Draftを作る' }).click();
  await expect(page.locator('.timeline > li').nth(0).locator('a')).toBeVisible();
  await page.locator('.timeline > li').nth(1).getByRole('button', { name: 'Draftを作る' }).click();
  await expect(page.locator('.timeline > li').nth(1).locator('a')).toBeVisible();
  await expect(page.getByText('Campaign Guard')).toBeVisible();

  // Connect Threads sandbox through the OAuth flow (simulated platform — no real SNS)
  await page.goto('/connectors');
  await page.locator('tr', { hasText: 'Threads' }).getByRole('button', { name: 'Sandboxに接続' }).click();
  await page.getByRole('link', { name: '許可する' }).click();
  await page.waitForURL(/connectors\?connected=1/);
  await expect(page.getByText('接続しました')).toBeVisible();
  await expect(page.locator('tr', { hasText: 'Threads' }).locator('.tag', { hasText: '投稿' }).first()).toBeVisible();

  const api = await apiFor(page);
  const camp = await api.get(`/campaigns/${page.url().includes('cmp_') ? '' : ''}`.replace(/\/$/, '')).catch(() => null);
  const list = await api.get('/campaigns');
  const c = await api.get(`/campaigns/${list.find((x: any) => x.name === 'E2E Launch').id}`);
  const threadsItem = c.items.find((i: any) => i.platform === 'threads');
  const xItem = c.items.find((i: any) => i.platform === 'x');
  expect(threadsItem && xItem).toBeTruthy();
  for (const it of [threadsItem, xItem]) {
    await api.post(`/content/${it.id}/review`);
    await api.post(`/content/${it.id}/approve`);
  }
  const when = new Date(today.getTime() + 2 * 86400_000);
  const local = `${fmt(when)}T09:00`;
  const j1 = await api.post(`/content/${threadsItem.id}/schedule`, { localTime: local, timezone: 'Asia/Tokyo', mode: 'api' });
  expect(j1.job.mode).toBe('api');
  // X has no connector → API schedule is refused, manual reminder works
  const refused = await page.request.post(`/api/w/${api.wsId}/content/${xItem.id}/schedule`, { data: { localTime: local, timezone: 'Asia/Tokyo', mode: 'api' }, headers: api.headers });
  expect(refused.status()).toBe(400);
  const j2 = await api.post(`/content/${xItem.id}/schedule`, { localTime: `${fmt(when)}T12:00`, timezone: 'Asia/Tokyo', mode: 'manual' });
  expect(j2.job.mode).toBe('manual');
  void camp;

  await page.goto('/calendar');
  if (when.getMonth() !== today.getMonth()) await page.getByRole('button', { name: '翌月' }).click();
  await expect(page.locator('.cal-e', { hasText: '⚡' }).first()).toBeVisible();
  await expect(page.locator('.cal-e', { hasText: '✋' }).first()).toBeVisible();
  await expect(page.locator('.cal-e.plan').first()).toBeVisible();
});
