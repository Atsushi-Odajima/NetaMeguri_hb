import { test, expect } from '@playwright/test';
import { login, apiFor, register } from './helpers';

// E2E-9: 全data export → 空環境restore → Source/Idea/Content/Campaign relation一致
test('E2E-9 backup → restore into empty workspace → relations match', async ({ page, browser }) => {
  await login(page);
  const api = await apiFor(page);
  const relBefore = await api.get('/relations');
  const res = await page.request.get(`/api/w/${api.wsId}/backup.zip`);
  expect(res.ok()).toBe(true);
  const zip = await res.body();
  // exports
  for (const f of ['csv', 'json', 'md', 'txt']) expect((await page.request.get(`/api/w/${api.wsId}/export/content?format=${f}`)).ok()).toBe(true);
  const pack = (await api.get('/packs'))[0];
  expect((await page.request.get(`/api/w/${api.wsId}/packs/${pack.id}/zip`)).headers()['content-type']).toContain('zip');

  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await register(p2, `restore-${Date.now()}@example.com`);
  await p2.goto('/data');
  await p2.getByLabel('空のWorkspaceへ復元').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: zip });
  await expect(p2.getByText(/復元しました/)).toBeVisible();
  const api2 = await apiFor(p2);
  const relAfter = await api2.get('/relations');
  expect(relAfter).toEqual(relBefore);
  // restored data is usable: search works and connectors need re-auth
  const s = await api2.get('/search?q=' + encodeURIComponent('チェックリスト'));
  expect(s.hits.length).toBeGreaterThan(0);
  expect((await api2.get('/connectors')).connectors.every((c: any) => c.status !== 'connected')).toBe(true);
  // a second restore into the now non-empty workspace is refused
  const again = await p2.request.post(`/api/w/${api2.wsId}/restore`, { data: zip, headers: { ...api2.headers, 'content-type': 'application/zip' } });
  expect(again.status()).toBe(400);
  await ctx2.close();
});
