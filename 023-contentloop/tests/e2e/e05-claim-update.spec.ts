import { test, expect } from '@playwright/test';
import { login, apiFor } from './helpers';

// E2E-5: Product価格変更 → Claim Registry更新 → 古いEvergreen/Content を Needs Update
test('E2E-5 price change → claim registry → needs update', async ({ page }) => {
  await login(page);
  const api = await apiFor(page);
  const c = await api.post('/content', { platform: 'threads', body: 'ProofFlowは月額980円で使えます。リリース前のチェックをまとめて管理できます。' });
  await api.post(`/content/${c.id}/review`);
  expect((await api.post(`/content/${c.id}/approve`)).status).toBe('approved');
  const before = await api.get('/ideas-memory');

  await page.goto('/claims');
  page.once('dialog', (d) => d.accept('月額1,280円'));
  await page.locator('tr', { hasText: 'ProofFlow 月額料金' }).getByRole('button', { name: '値を更新' }).click();
  await expect(page.getByText(/を「要更新\/再レビュー」にしました/)).toBeVisible();
  await expect(page.locator('tr', { hasText: 'ProofFlow 月額料金' })).toContainText('月額1,280円');
  await expect(page.locator('tr', { hasText: 'ProofFlow 月額料金' })).toContainText('月額980円'); // history

  const after = await api.get(`/content/${c.id}`);
  expect(after.content.status).toBe('needs_review');
  expect(after.checks.claims.some((x: any) => x.severity === 'block' && x.message.includes('古い値'))).toBe(true);
  const mem = await api.get('/ideas-memory');
  expect(mem.needsUpdate.length).toBeGreaterThanOrEqual(before.needsUpdate.length);
  expect(mem.needsUpdate.some((i: any) => i.evergreen)).toBe(true);
  // the approved content can no longer be approved while the outdated value remains
  const r = await page.request.post(`/api/w/${api.wsId}/content/${c.id}/approve`, { headers: api.headers, data: {} });
  expect(r.status()).toBe(400);
});
