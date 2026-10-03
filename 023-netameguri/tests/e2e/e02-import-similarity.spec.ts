import { test, expect } from '@playwright/test';
import { login, apiFor } from './helpers';

// E2E-2: 過去Threads import → Idea fingerprint → 新Draft similarity warning → 別angle生成
test('E2E-2 import past Threads posts → similarity warning → new angle draft', async ({ page }) => {
  await login(page);
  const d = new Date(Date.now() - 12 * 86400_000).toISOString().slice(0, 10);
  const csv = `date,text,likes,views\n${d},"朝の30分だけ個人開発を続けたら、半年で3つのアプリを公開できた。続けるコツは時間を固定すること。",120,4300\n${d},"=HYPERLINK(""http://evil"")",1,10\n`;
  await page.goto('/data');
  await page.getByLabel('CSV', { exact: true }).fill(csv);
  await page.getByLabel('Platform列がない場合').selectOption('threads');
  await page.getByRole('button', { name: 'プレビュー' }).click();
  await expect(page.getByText('2行')).toBeVisible();
  await page.getByRole('button', { name: '確定' }).click();
  await expect(page.getByText(/作成 2件/)).toBeVisible();

  await page.goto('/ideas');
  await page.getByLabel('ネタ').fill('朝の30分だけ個人開発を続けるコツは、時間を固定すること。');
  await page.getByRole('button', { name: '過去のネタと比べる' }).click();
  await expect(page.locator('.sim').first()).toContainText('日前にThreadsで使用したIdeaと');

  // Save as a new idea (nothing is auto-deleted), then choose "別角度"
  await page.getByRole('button', { name: 'Ideaとして保存' }).click();
  await expect(page.locator('.sim').first()).toBeVisible();
  const api = await apiFor(page);
  const sim = await api.post('/ideas/similar', { text: '朝の30分だけ個人開発を続けるコツは、時間を固定すること。' });
  const newest = (await api.get('/ideas?limit=5')).find((i: any) => i.coreIdea.startsWith('朝の30分だけ個人開発を続けるコツ'));
  expect(newest).toBeTruthy();
  expect(sim.length).toBeGreaterThanOrEqual(2); // imported idea + new idea both exist
  await page.goto(`/ideas/${newest.id}`);
  await page.getByRole('button', { name: '重複チェック' }).click();
  await expect(page.locator('.sim').first()).toContainText('Threads');
  await page.getByRole('button', { name: '別角度' }).click();
  await page.waitForURL(/\/content\/cnt_/);
  const id = page.url().split('/').pop()!;
  const c = await api.get(`/content/${id}`);
  expect(c.content.structured.angle).toBeTruthy();
  expect(c.content.structured.angle).not.toBe(newest.angle);
  // CSV formula row was imported as plain text, not executed; export neutralises it
  const exp = await (await page.request.get(`/api/w/${api.wsId}/export/content?format=csv`)).text();
  expect(exp).toContain(`'=HYPERLINK`);
});
